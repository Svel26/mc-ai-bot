require('dotenv').config();

const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const baritone = require('@miner-org/mineflayer-baritone').loader;
const goals = require('@miner-org/mineflayer-baritone').goals;
const WebSocket = require('ws');

const MINECRAFT_HOST = process.env.MC_HOST ?? 'localhost';
const MINECRAFT_PORT = Number(process.env.MC_PORT ?? '25565');
const MINECRAFT_USERNAME = process.env.MC_USERNAME ?? 'GemmaBot';
const MINECRAFT_VERSION = process.env.MC_VERSION ?? '1.21.1';
const WS_PORT = Number(process.env.WS_PORT ?? '8080');

console.log(`[Game-Layer] Starting bot for Minecraft at ${MINECRAFT_HOST}:${MINECRAFT_PORT}`);
console.log(`[Game-Layer] WebSocket server will listen on port ${WS_PORT}`);

const bot = mineflayer.createBot({
  host: MINECRAFT_HOST,
  port: MINECRAFT_PORT,
  username: MINECRAFT_USERNAME,
  version: MINECRAFT_VERSION,
  auth: 'offline'
});

bot.loadPlugin(baritone);

const wss = new WebSocket.Server({ port: WS_PORT });
wss.on('error', (err) => {
  console.error('[Game-Layer] WebSocket server error:', err);
});

bot.once('spawn', () => {
  console.log('[Game-Layer] Bot spawned. Configuring Baritone physical properties...');
  bot.ashfinder.config.breakBlocks = true;
  bot.ashfinder.config.placeBlocks = true;
  bot.ashfinder.config.swimming = true;
  bot.ashfinder.config.parkour = true;
  bot.ashfinder.config.thinkTimeout = 30000;
});

wss.on('connection', (ws) => {
  console.log('[Game-Layer] Python Orchestrator connected.');

  ws.on('message', async (message) => {
    let action;

    try {
      action = JSON.parse(message.toString());
    } catch (err) {
      ws.send(JSON.stringify({ status: 'ERROR', error: 'Invalid JSON payload' }));
      return;
    }

    console.log(`[Received Command]: ${action.type}`);

    try {
      if (action.type === 'NAVIGATE') {
        const target = new Vec3(action.x, action.y, action.z);
        const goal = new goals.GoalExact(target);
        await bot.ashfinder.goto(goal);
        ws.send(JSON.stringify({ status: 'SUCCESS', message: 'Arrived safely.' }));
        return;
      }

      if (action.type === 'COLLECT_BLOCK') {
        const blockEntry = bot.registry.blocksByName[action.block_name];
        if (!blockEntry) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `Unknown block: ${action.block_name}` }));
          return;
        }

        const blockTarget = bot.findBlock({
          matching: blockEntry.id,
          maxDistance: 32
        });

        if (!blockTarget) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `No ${action.block_name} found in radius.` }));
          return;
        }

        const goal = new goals.GoalExact(blockTarget.position);
        await bot.ashfinder.goto(goal);
        await bot.dig(blockTarget);
        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Harvested 1 ${action.block_name}.` }));
        return;
      }

      if (action.type === 'GET_INVENTORY') {
        const currentInventory = bot.inventory.items().map((item) => ({ name: item.name, count: item.count }));
        ws.send(JSON.stringify({ status: 'SUCCESS', data: currentInventory }));
        return;
      }

      ws.send(JSON.stringify({ status: 'ERROR', error: `Unsupported action type: ${action.type}` }));
    } catch (err) {
      ws.send(JSON.stringify({ status: 'FAILED', error: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('[Game-Layer] Python Orchestrator disconnected.');
  });
});

bot.on('error', (err) => console.error('[Game-Layer] Bot error:', err));
bot.on('end', () => console.log('[Game-Layer] Connection ended.'));
