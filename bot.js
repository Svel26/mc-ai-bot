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
let activeConnection = null;

// --- FIX #1: Replace boolean cancel flag with a command token ---
// Each command gets a unique token. The running action checks its captured
// token against the global; a STOP or new command overwrites the global token.
let currentCommandToken = null;
function isCancelled(myToken) {
  return currentCommandToken !== myToken;
}
function newCommandToken() {
  const token = Symbol('cmd');
  currentCommandToken = token;
  return token;
}

// --- Reflex suppression flag ---
// Set true while any command is actively moving/digging so the reflex loop
// doesn't fight the pathfinder with concurrent goto() calls.
let commandInProgress = false;

wss.on('error', (err) => {
  console.error('[Game-Layer] WebSocket server error:', err);
});

function getBotState() {
  const currentInventory = bot.inventory ? bot.inventory.items().map((item) => ({
    name: item.name,
    count: item.count,
    type: item.type,
    slot: item.slot
  })) : [];

  const nearbyEntities = (bot.entities && bot.entity) ? Object.values(bot.entities)
    .filter((e) => e !== bot.entity && (e.type === 'mob' || e.type === 'player'))
    .map((e) => ({
      id: e.id,
      name: e.name || e.username,
      type: e.type,
      position: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) },
      distance: Math.round(bot.entity.position.distanceTo(e.position))
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10) : [];

  return {
    type: 'STATE',
    pos: bot.entity ? {
      x: Math.round(bot.entity.position.x),
      y: Math.round(bot.entity.position.y),
      z: Math.round(bot.entity.position.z)
    } : { x: 0, y: 0, z: 0 },
    health: bot.health ?? 20,
    food: bot.food ?? 20,
    oxygen: bot.oxygen ?? 20,
    time: bot.time ? bot.time.timeOfDay : 0,
    inventory: currentInventory,
    entities: nearbyEntities
  };
}

function sendState(ws) {
  if (!ws) ws = activeConnection;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(getBotState()));
  }
}

let stateTimeout = null;
function queueStateSend(ws) {
  if (!ws) ws = activeConnection;
  if (!ws || stateTimeout) return;
  stateTimeout = setTimeout(() => {
    stateTimeout = null;
    sendState(ws);
  }, 500);
}

// --- FIX #5: Debounce reflex armor equip to prevent stacked async calls ---
let reflexRunning = false;
let reflexInterval = null;

function startReflexLoop() {
  if (reflexInterval) return;
  console.log('[Reflex] Starting autonomic survival background ticks...');

  reflexInterval = setInterval(async () => {
    if (reflexRunning) return; // prevent stacking
    reflexRunning = true;
    try {
      // 1. Auto-Eat (restore hunger)
      if (bot.food < 15) {
        const food = bot.inventory.items().find(i => bot.registry.foodsByName[i.name] !== undefined);
        if (food) {
          console.log(`[Reflex] Automatically consuming food: ${food.name}`);
          try {
            await bot.equip(food, 'hand');
            await bot.consume();
            queueStateSend();
          } catch (e) {
            console.error(`[Reflex] Auto-eat failed: ${e.message}`);
          }
        }
      }

      // 2. Auto-Armor (automatic gear equipping — guarded by debounce flag above)
      const slots = {
        head: 'helmet',
        torso: 'chestplate',
        legs: 'leggings',
        feet: 'boots'
      };
      for (const [slot, pattern] of Object.entries(slots)) {
        const equipSlot = bot.getEquipmentDestSlot(slot);
        if (!bot.inventory.slots[equipSlot]) {
          const armor = bot.inventory.items().find(i => i.name.includes(pattern));
          if (armor) {
            console.log(`[Reflex] Equipping discovered armor: ${armor.name}`);
            try {
              await bot.equip(armor, slot);
              queueStateSend();
            } catch (e) {
              console.error(`[Reflex] Auto-armor failed: ${e.message}`);
            }
          }
        }
      }

      // 3. Auto-Loot (pick up items on ground)
      // Only runs when no command is actively using the pathfinder.
      if (!commandInProgress) {
        const drops = Object.values(bot.entities)
          .filter(e => e.type === 'object' && e.name === 'item' && bot.entity.position.distanceTo(e.position) <= 6)
          .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));

        if (drops.length > 0) {
          const item = drops[0];
          console.log(`[Reflex] Looting nearby item: ${item.name || 'stack'}`);
          try {
            await bot.ashfinder.goto(new goals.GoalNear(item.position, 1));
          } catch (e) {}
        }
      }

      // 4. Auto-Defend (combat reflex & Creeper evasion)
      const hostiles = ['zombie', 'skeleton', 'spider', 'creeper', 'witch', 'slime', 'enderman', 'drowned', 'husk'];
      const nearbyMobs = Object.values(bot.entities)
        .filter(e => e.type === 'mob' && hostiles.includes(e.name) && bot.entity.position.distanceTo(e.position) <= 8)
        .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));

      if (nearbyMobs.length > 0) {
        const mob = nearbyMobs[0];
        const distance = bot.entity.position.distanceTo(mob.position);

        // Creeper flee is an emergency — always runs regardless of commandInProgress
        if (mob.name === 'creeper' && distance < 3.5) {
          console.log('[Reflex] Fleeing detonating Creeper!');
          const fleeVec = bot.entity.position.minus(mob.position).normalize().scaled(4);
          const targetPos = bot.entity.position.plus(fleeVec);
          try {
            await bot.ashfinder.goto(new goals.GoalNear(targetPos, 1));
          } catch (e) {}
        } else if (!commandInProgress && distance <= 4.5) {
          // Only attack/approach if no command is using the pathfinder
          const weapon = bot.inventory.items().find(i => i.name.includes('sword') || i.name.includes('axe'));
          if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) {
            try {
              await bot.equip(weapon, 'hand');
            } catch (e) {}
          }

          console.log(`[Reflex] Defending against ${mob.name}`);
          try {
            await bot.lookAt(mob.position.offset(0, 1.2, 0));
            await bot.attack(mob);
          } catch (e) {}
        }
      }
    } finally {
      reflexRunning = false;
    }
  }, 1200);
}

// Setup event listeners for state updates when spawn occurs
bot.once('spawn', () => {
  console.log('[Game-Layer] Bot spawned. Configuring Baritone physical properties...');
  bot.ashfinder.config.breakBlocks = true;
  bot.ashfinder.config.placeBlocks = true;
  bot.ashfinder.config.swimming = true;
  bot.ashfinder.config.parkour = true;
  bot.ashfinder.config.thinkTimeout = 30000;

  // Set up events to push updates
  bot.on('health', () => queueStateSend());
  bot.on('playerCollect', () => queueStateSend());
  bot.inventory.on('updateSlot', () => queueStateSend());
  bot.on('damage', (amount) => {
    console.log(`[Game-Layer] Bot took ${amount} damage!`);
    if (activeConnection && activeConnection.readyState === WebSocket.OPEN) {
      activeConnection.send(JSON.stringify({
        type: 'DAMAGE_TAKEN',
        health: bot.health,
        amount: amount
      }));
    }
  });

  // Periodically send state every 2.5 seconds
  setInterval(() => {
    queueStateSend();
  }, 2500);

  // Run reflexes
  startReflexLoop();
});

// Forward in-game chat messages mentioning bot
bot.on('chat', (username, message) => {
  if (username === bot.username || username === bot.entity?.username) return;

  const mention = 'GemmaBot';
  const lowercaseMessage = message.toLowerCase();
  if (lowercaseMessage.includes(mention.toLowerCase()) || lowercaseMessage.startsWith('bot ')) {
    const cleanMessage = message.replace(new RegExp(mention, 'gi'), '').replace(/^bot\s+/i, '').trim();
    console.log(`[In-Game Chat] Forwarding mention from ${username}: ${cleanMessage}`);
    if (activeConnection && activeConnection.readyState === WebSocket.OPEN) {
      activeConnection.send(JSON.stringify({
        type: 'IN_GAME_CHAT',
        username: username,
        message: cleanMessage
      }));
    }
  }
});

// Face vector helper
const faceVectors = {
  up: new Vec3(0, 1, 0),
  down: new Vec3(0, -1, 0),
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0)
};

function countItemInInventory(itemId) {
  return bot.inventory.items()
    .filter(item => item.type === itemId)
    .reduce((sum, item) => sum + item.count, 0);
}

function findNearbyPlacePosition() {
  const botPos = bot.entity.position.floored();
  // Check immediately adjacent ground blocks
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      const testPos = botPos.offset(dx, 0, dz);
      const blockUnder = bot.blockAt(testPos.offset(0, -1, 0));
      const blockCurrent = bot.blockAt(testPos);
      const blockAbove = bot.blockAt(testPos.offset(0, 1, 0));
      if (blockUnder && blockUnder.name !== 'air' && blockUnder.name !== 'water' && blockUnder.name !== 'lava' &&
          blockCurrent && blockCurrent.name === 'air' &&
          blockAbove && blockAbove.name === 'air') {
        return testPos;
      }
    }
  }
  // Fallback to searching wider
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && dy === 0) continue;
        const testPos = botPos.offset(dx, dy, dz);
        const blockUnder = bot.blockAt(testPos.offset(0, -1, 0));
        const blockCurrent = bot.blockAt(testPos);
        const blockAbove = bot.blockAt(testPos.offset(0, 1, 0));
        if (blockUnder && blockUnder.name !== 'air' && blockUnder.name !== 'water' && blockUnder.name !== 'lava' &&
            blockCurrent && blockCurrent.name === 'air' &&
            blockAbove && blockAbove.name === 'air') {
          return testPos;
        }
      }
    }
  }
  return null;
}

async function equipBestTool(block) {
  let toolName = null;
  const name = block.name.toLowerCase();
  if (name.includes('stone') || name.includes('ore') || name.includes('cobblestone') || name.includes('obsidian') || name.includes('iron') || name.includes('coal') || name.includes('gold') || name.includes('diamond')) {
    toolName = 'pickaxe';
  } else if (name.includes('wood') || name.includes('log') || name.includes('planks') || name.includes('chest') || name.includes('crafting_table')) {
    toolName = 'axe';
  } else if (name.includes('dirt') || name.includes('grass') || name.includes('sand') || name.includes('gravel')) {
    toolName = 'shovel';
  }

  if (toolName) {
    const tool = bot.inventory.items().find(item => item.name.includes(toolName));
    if (tool) {
      await bot.equip(tool, 'hand');
    }
  }
}

wss.on('connection', (ws) => {
  console.log('[Game-Layer] Python Orchestrator connected.');
  activeConnection = ws;

  // Send state immediately on connect
  sendState(ws);

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
      // --- FIX #1: STOP now invalidates all in-flight commands via token ---
      if (action.type === 'STOP') {
        currentCommandToken = null; // invalidate any running token
        commandInProgress = false;  // release reflex suppression immediately
        bot.ashfinder.stop();
        ws.send(JSON.stringify({ status: 'INTERRUPTED', message: 'Current command interrupted.' }));
        return;
      }

      // Stamp a new token for this command and suppress reflex movement
      const myToken = newCommandToken();
      commandInProgress = true;

      if (action.type === 'EVALUATE_GOAL') {
        const goalDescription = action.goal_description;
        const botPos = bot.entity ? bot.entity.position : { x: 0, y: 0, z: 0 };
        ws.send(JSON.stringify({
          status: 'SUCCESS',
          message: `Evaluated goal: "${goalDescription}". Physical status: Bot position is at (${Math.round(botPos.x)}, ${Math.round(botPos.y)}, ${Math.round(botPos.z)}). Current inventory: ${bot.inventory.items().map(i => `${i.count}x ${i.name}`).join(', ')}.`
        }));
        return;
      }

      if (action.type === 'GET_STATE') {
        ws.send(JSON.stringify({ status: 'SUCCESS', message: 'State retrieved.', state: getBotState() }));
        return;
      }

      if (action.type === 'GET_INVENTORY') {
        const currentInventory = bot.inventory.items().map((item) => ({ name: item.name, count: item.count }));
        ws.send(JSON.stringify({ status: 'SUCCESS', data: currentInventory }));
        return;
      }

      if (action.type === 'NAVIGATE') {
        const target = new Vec3(action.x, action.y, action.z);
        const goal = new goals.GoalExact(target);
        await bot.ashfinder.goto(goal);
        ws.send(JSON.stringify({ status: 'SUCCESS', message: 'Arrived safely.' }));
        queueStateSend(ws);
        return;
      }

      if (action.type === 'NAVIGATE_NEAR') {
        const range = action.range ?? 3;
        const target = new Vec3(action.x, action.y, action.z);
        const goal = new goals.GoalNear(target, range);
        await bot.ashfinder.goto(goal);
        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Arrived within ${range} blocks.` }));
        queueStateSend(ws);
        return;
      }

      if (action.type === 'FIND_BLOCK') {
        const blockEntry = bot.registry.blocksByName[action.block_name];
        if (!blockEntry) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `Unknown block: ${action.block_name}` }));
          return;
        }

        const blocks = bot.findBlocks({
          matching: blockEntry.id,
          maxDistance: action.radius ?? 32,
          count: action.count ?? 5
        });

        ws.send(JSON.stringify({ status: 'SUCCESS', data: blocks }));
        return;
      }

      // --- NEW: FIND_ENTITY tool ---
      if (action.type === 'FIND_ENTITY') {
        const searchName = (action.entity_name || '').toLowerCase();
        const searchType = (action.entity_type || '').toLowerCase(); // 'mob', 'player', or ''
        const maxDist = action.radius ?? 64;

        const results = Object.values(bot.entities)
          .filter(e => {
            if (e === bot.entity) return false;
            const eName = (e.name || e.username || '').toLowerCase();
            const eType = (e.type || '').toLowerCase();
            const withinDist = bot.entity && bot.entity.position.distanceTo(e.position) <= maxDist;
            const nameMatch = !searchName || eName.includes(searchName);
            const typeMatch = !searchType || eType === searchType;
            return withinDist && nameMatch && typeMatch;
          })
          .map(e => ({
            id: e.id,
            name: e.name || e.username,
            type: e.type,
            position: {
              x: Math.round(e.position.x),
              y: Math.round(e.position.y),
              z: Math.round(e.position.z)
            },
            distance: Math.round(bot.entity.position.distanceTo(e.position))
          }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 10);

        ws.send(JSON.stringify({ status: 'SUCCESS', data: results }));
        return;
      }

      // ── SLEEP ────────────────────────────────────────────────────────────────
      if (action.type === 'SLEEP') {
        // Try to find a bed and sleep. If no bed, wait until dawn (time > 23000).
        const bedNames = [
          'white_bed','orange_bed','magenta_bed','light_blue_bed','yellow_bed',
          'lime_bed','pink_bed','gray_bed','light_gray_bed','cyan_bed',
          'purple_bed','blue_bed','brown_bed','green_bed','red_bed','black_bed'
        ];
        const bedIds = bedNames
          .map(n => bot.registry.blocksByName[n])
          .filter(Boolean)
          .map(b => b.id);

        let slept = false;
        if (bedIds.length > 0) {
          const bedBlock = bot.findBlock({ matching: bedIds, maxDistance: 32, count: 1 })[0]
            || bot.findBlock({ matching: bedIds, maxDistance: 64, count: 1 })[0];

          if (bedBlock) {
            try {
              await bot.ashfinder.goto(new goals.GoalNear(bedBlock.position, 2));
              await bot.sleep(bedBlock);
              slept = true;
              console.log('[SLEEP] Bot slept through the night.');
            } catch (e) {
              console.log(`[SLEEP] Could not sleep in bed: ${e.message}`);
            }
          }
        }

        if (!slept) {
          // No bed — wait it out until dawn
          console.log('[SLEEP] No bed found — waiting for dawn...');
          const maxWait = 14000; // max ~11 min real time at normal tick rate
          let waited = 0;
          while (waited < maxWait && !isCancelled(myToken)) {
            const t = bot.time ? bot.time.timeOfDay : 0;
            if (t >= 23000 || t < 1000) break;
            await bot.waitForTicks(20);
            waited += 20;
          }
        }

        ws.send(JSON.stringify({
          status: 'SUCCESS',
          message: slept ? 'Slept through the night in a bed.' : 'Waited until dawn (no bed available).'
        }));
        queueStateSend(ws);
        return;
      }

      // ── SCAN_AREA ────────────────────────────────────────────────────────────
      if (action.type === 'SCAN_AREA') {
        const radius = action.radius ?? 48;
        const pos = bot.entity.position.floored();
        const biome = bot.world ? bot.world.getBiome(pos) : null;
        const biomeName = biome !== null && bot.registry.biomes[biome]
          ? bot.registry.biomes[biome].name
          : (biome !== null ? `biome_${biome}` : 'unknown');

        const skyLight = bot.blockAt(pos.offset(0, 1, 0))?.skyLight ?? -1;
        const blockLight = bot.blockAt(pos)?.light ?? -1;
        const timeOfDay = bot.time ? bot.time.timeOfDay : 0;
        const isNight = timeOfDay >= 13000 && timeOfDay < 23000;

        // Sample nearby blocks and build a census
        const census = {};
        const sampleStep = Math.max(1, Math.floor(radius / 8));
        for (let dx = -radius; dx <= radius; dx += sampleStep) {
          for (let dy = -16; dy <= 16; dy += sampleStep) {
            for (let dz = -radius; dz <= radius; dz += sampleStep) {
              const b = bot.blockAt(pos.offset(dx, dy, dz));
              if (b && b.name !== 'air') {
                census[b.name] = (census[b.name] || 0) + 1;
              }
            }
          }
        }

        // Top 15 most common non-trivial blocks
        const interesting = Object.entries(census)
          .filter(([n]) => !['water','lava','bedrock','cave_air'].includes(n))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15);

        // Find nearest water and lava
        const nearWater = bot.findBlock({ matching: bot.registry.blocksByName['water']?.id, maxDistance: radius, count: 1 });
        const nearLava  = bot.findBlock({ matching: bot.registry.blocksByName['lava']?.id,  maxDistance: radius, count: 1 });

        ws.send(JSON.stringify({
          status: 'SUCCESS',
          data: {
            biome: biomeName,
            position: { x: pos.x, y: pos.y, z: pos.z },
            sky_light: skyLight,
            block_light: blockLight,
            is_night: isNight,
            time_of_day: timeOfDay,
            nearby_blocks: Object.fromEntries(interesting),
            nearest_water: nearWater[0] ?? null,
            nearest_lava:  nearLava[0]  ?? null,
            health: bot.health,
            food: bot.food
          }
        }));
        return;
      }

      // ── WAIT ─────────────────────────────────────────────────────────────────
      if (action.type === 'WAIT') {
        const ticks = Math.min(action.ticks ?? 100, 2400); // cap at 2 min
        console.log(`[WAIT] Waiting ${ticks} ticks...`);
        await bot.waitForTicks(ticks);
        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Waited ${ticks} ticks.` }));
        queueStateSend(ws);
        return;
      }

      // ── PLACE_TORCH ──────────────────────────────────────────────────────────
      if (action.type === 'PLACE_TORCH') {
        const torch = bot.inventory.items().find(i => i.name === 'torch');
        if (!torch) {
          ws.send(JSON.stringify({ status: 'FAILED', message: 'No torches in inventory.' }));
          return;
        }

        await bot.equip(torch, 'hand');

        // Try floor first, then walls
        const botPos = bot.entity.position.floored();
        const candidates = [
          { ref: botPos.offset(0, -1, 0), face: faceVectors.up },                // place on floor
          { ref: botPos.offset(1,  0, 0), face: faceVectors.west },
          { ref: botPos.offset(-1, 0, 0), face: faceVectors.east },
          { ref: botPos.offset(0,  0, 1), face: faceVectors.north },
          { ref: botPos.offset(0,  0,-1), face: faceVectors.south },
        ];

        let placed = false;
        for (const { ref, face } of candidates) {
          const refBlock = bot.blockAt(ref);
          if (refBlock && refBlock.name !== 'air' && refBlock.name !== 'water' && refBlock.name !== 'lava') {
            try {
              await bot.lookAt(ref.offset(0.5, 0.5, 0.5));
              await bot.placeBlock(refBlock, face);
              placed = true;
              break;
            } catch (e) {}
          }
        }

        if (placed) {
          ws.send(JSON.stringify({ status: 'SUCCESS', message: 'Placed a torch.' }));
        } else {
          ws.send(JSON.stringify({ status: 'FAILED', message: 'Could not find a valid surface to place the torch.' }));
        }
        queueStateSend(ws);
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

        // Navigate near it first
        const goal = new goals.GoalNear(blockTarget.position, 2);
        await bot.ashfinder.goto(goal);

        // Equip best tool
        await equipBestTool(blockTarget);

        await bot.lookAt(blockTarget.position.offset(0.5, 0.5, 0.5));
        await bot.dig(blockTarget);
        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Harvested 1 ${action.block_name}.` }));
        queueStateSend(ws);
        return;
      }

      // Macro action: Automatically vein-mine blocks until count target is reached.
      // Automatically expands search radius if no block is found nearby.
      if (action.type === 'AUTO_MINE') {
        const blockName = action.block_name;
        const targetCount = action.count ?? 1;
        const blockEntry = bot.registry.blocksByName[blockName];
        if (!blockEntry) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `Unknown block: ${blockName}` }));
          return;
        }

        let minedCount = 0;
        let failures = 0;
        const SEARCH_RADII = [32, 64, 128]; // expand search if nothing found nearby

        while (minedCount < targetCount && failures < 5) {
          if (isCancelled(myToken)) {
            console.log('[Auto-Mine] Cancelled by orchestrator.');
            break;
          }

          // Try each radius tier until a block is found
          let block = null;
          for (const radius of SEARCH_RADII) {
            block = bot.findBlock({ matching: blockEntry.id, maxDistance: radius });
            if (block) {
              if (radius > 32) console.log(`[Auto-Mine] Found ${blockName} at expanded radius ${radius}.`);
              break;
            }
          }

          if (!block) {
            console.log(`[Auto-Mine] No ${blockName} found within ${SEARCH_RADII[SEARCH_RADII.length-1]} blocks.`);
            break;
          }

          try {
            const goal = new goals.GoalNear(block.position, 2);
            await bot.ashfinder.goto(goal);

            if (isCancelled(myToken)) break;

            // Re-fetch block after navigating (may have been mined by another entity)
            const freshBlock = bot.blockAt(block.position);
            if (!freshBlock || freshBlock.name !== block.name) {
              // Block is gone, continue to find the next one
              continue;
            }

            await equipBestTool(freshBlock);
            await bot.lookAt(freshBlock.position.offset(0.5, 0.5, 0.5));
            await bot.dig(freshBlock);

            // Wait for item to pick up
            await bot.waitForTicks(8);
            minedCount++;
            failures = 0;
            queueStateSend(ws);
          } catch (e) {
            failures++;
            console.error(`[Auto-Mine] Error on segment: ${e.message}`);
            await bot.waitForTicks(10);
          }
        }

        const didFinish = minedCount >= targetCount;
        const summary = didFinish
          ? `Completed auto-mining. Gathered ${minedCount}/${targetCount} ${blockName}.`
          : `Partial auto-mine complete. Gathered ${minedCount}/${targetCount} ${blockName}. ${
              failures >= 5 ? 'Stopped due to repeated failures.' : 'No more blocks found in range.'
            }`;

        bot.chat(`[Auto-Mine] ${summary}`);
        ws.send(JSON.stringify({
          status: didFinish ? 'SUCCESS' : 'PARTIAL',
          message: summary,
          data: { mined: minedCount, target: targetCount, block: blockName }
        }));
        queueStateSend(ws);
        return;
      }

      // Macro action: Build simple structures (shelter, walls, towers, bridges)
      if (action.type === 'BUILD_STRUCTURE') {
        const startPos = new Vec3(action.x, action.y, action.z);
        const structureType = action.structure_type;

        let layout = [];
        if (structureType === 'shelter') {
          // Walls
          for (let y = 0; y < 3; y++) {
            for (let x = 0; x < 4; x++) {
              for (let z = 0; z < 4; z++) {
                if (x === 0 || x === 3 || z === 0 || z === 3) {
                  if (x === 2 && z === 0 && (y === 0 || y === 1)) continue; // door gap
                  layout.push(new Vec3(x, y, z));
                }
              }
            }
          }
          // Roof
          for (let x = 0; x < 4; x++) {
            for (let z = 0; z < 4; z++) {
              layout.push(new Vec3(x, 3, z));
            }
          }
        } else if (structureType === 'wall') {
          for (let y = 0; y < 3; y++) {
            for (let x = 0; x < 5; x++) {
              layout.push(new Vec3(x, y, 0));
            }
          }
        } else if (structureType === 'bridge') {
          for (let z = 0; z < 5; z++) {
            layout.push(new Vec3(0, 0, z));
          }
        } else if (structureType === 'staircase') {
          for (let i = 0; i < 4; i++) {
            layout.push(new Vec3(i, i, 0));
          }
        } else {
          ws.send(JSON.stringify({ status: 'FAILED', message: `Unknown structure layout: ${structureType}` }));
          return;
        }

        let placedCount = 0;
        let failCount = 0;

        for (const offset of layout) {
          if (isCancelled(myToken)) {
            console.log('[Build] Cancelled by orchestrator.');
            break;
          }
          const targetPos = startPos.plus(offset);
          const currentBlock = bot.blockAt(targetPos);

          if (currentBlock && currentBlock.name === 'air') {
            const placeables = ['cobblestone', 'dirt', 'stone', 'oak_planks', 'spruce_planks', 'stone_bricks', 'sandstone'];
            const item = bot.inventory.items().find(i => placeables.includes(i.name) || i.name.includes('planks') || i.name.includes('wood'));

            if (!item) {
              console.log("[Build] Out of building blocks in inventory.");
              break;
            }

            try {
              await bot.equip(item, 'hand');

              let referenceBlock = null;
              let faceVector = null;
              for (const [key, vector] of Object.entries(faceVectors)) {
                const neighborPos = targetPos.minus(vector);
                const neighborBlock = bot.blockAt(neighborPos);
                if (neighborBlock && neighborBlock.name !== 'air' && neighborBlock.name !== 'water' && neighborBlock.name !== 'lava') {
                  referenceBlock = neighborBlock;
                  faceVector = vector;
                  break;
                }
              }

              if (referenceBlock) {
                const dist = bot.entity.position.distanceTo(referenceBlock.position);
                if (dist > 3.5) {
                  await bot.ashfinder.goto(new goals.GoalNear(referenceBlock.position, 2));
                }

                await bot.lookAt(referenceBlock.position.offset(0.5, 0.5, 0.5));
                await bot.placeBlock(referenceBlock, faceVector);
                placedCount++;
                await bot.waitForTicks(2);
                queueStateSend(ws);
              } else {
                failCount++;
              }
            } catch (e) {
              console.error(`[Build] Block place error at ${targetPos}: ${e.message}`);
              failCount++;
            }
          }
        }

        bot.chat(`[Build] Completed structure. Placed ${placedCount} blocks (Skipped/Failed: ${failCount}).`);
        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Completed building ${structureType}. Placed ${placedCount} blocks (Skipped/Failed: ${failCount}).` }));
        queueStateSend(ws);
        return;
      }

      // Macro action: Move and scan the landscape safely
      if (action.type === 'EXPLORE') {
        const exploreDist = action.distance ?? 40;

        let segments = 0;
        while (segments < 4) {
          if (isCancelled(myToken)) {
            console.log('[Explore] Cancelled by orchestrator.');
            break;
          }
          const angle = Math.random() * Math.PI * 2;
          const dx = Math.cos(angle) * (exploreDist / 4);
          const dz = Math.sin(angle) * (exploreDist / 4);
          const targetPos = bot.entity.position.offset(dx, 0, dz);

          console.log(`[Explore] Navigating segment to ${targetPos.floored()}`);
          try {
            await bot.ashfinder.goto(new goals.GoalNear(targetPos, 3));
            segments++;

            // Scan for points of interest
            const chests = bot.findBlocks({
              matching: bot.registry.blocksByName['chest'].id,
              maxDistance: 32,
              count: 1
            });
            if (chests.length > 0) {
              bot.chat(`[Explore] Chest discovered at ${chests[0]}`);
              ws.send(JSON.stringify({ type: 'DISCOVERY', name: 'chest', position: chests[0] }));
            }

            await bot.waitForTicks(20);
            queueStateSend(ws);
          } catch (e) {
            console.error(`[Explore] Segment path failed: ${e.message}`);
            break;
          }
        }

        ws.send(JSON.stringify({ status: 'SUCCESS', message: 'Exploration complete.' }));
        queueStateSend(ws);
        return;
      }

      if (action.type === 'PLACE_BLOCK') {
        const item = bot.inventory.items().find(i => i.name === action.block_name);
        if (!item) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `No ${action.block_name} in inventory.` }));
          return;
        }

        let targetPos;
        if (action.x === undefined || action.x === null) {
          const autoPos = findNearbyPlacePosition();
          if (!autoPos) {
            ws.send(JSON.stringify({ status: 'FAILED', message: 'Could not find a suitable empty block nearby to place the block.' }));
            return;
          }
          targetPos = autoPos;
        } else {
          targetPos = new Vec3(action.x, action.y, action.z);
        }

        await bot.equip(item, 'hand');

        let referenceBlock = null;
        let faceVector = null;
        for (const [key, vector] of Object.entries(faceVectors)) {
          const neighborPos = targetPos.minus(vector);
          const neighborBlock = bot.blockAt(neighborPos);
          if (neighborBlock && neighborBlock.name !== 'air' && neighborBlock.name !== 'water' && neighborBlock.name !== 'lava') {
            referenceBlock = neighborBlock;
            faceVector = vector;
            break;
          }
        }

        if (!referenceBlock) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `No solid block adjacent to the target position ${targetPos} to place against.` }));
          return;
        }

        const dist = bot.entity.position.distanceTo(targetPos);
        if (dist > 4) {
          await bot.ashfinder.goto(new goals.GoalNear(targetPos, 3));
        }

        await bot.lookAt(referenceBlock.position.offset(0.5, 0.5, 0.5));
        await bot.placeBlock(referenceBlock, faceVector);

        ws.send(JSON.stringify({
          status: 'SUCCESS',
          message: `Placed ${action.block_name} at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}).`,
          data: { x: targetPos.x, y: targetPos.y, z: targetPos.z }
        }));
        queueStateSend(ws);
        return;
      }

      if (action.type === 'CRAFT') {
        const itemName = action.block_name || action.item_name;
        const itemEntry = bot.registry.itemsByName[itemName] || bot.registry.blocksByName[itemName];
        if (!itemEntry) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `Unknown item: ${itemName}` }));
          return;
        }

        const count = action.count ?? 1;

        // Check recipes
        let recipes = bot.recipesAll(itemEntry.id, null, false);
        if (recipes.length === 0) {
          recipes = bot.recipesAll(itemEntry.id, null, true);
        }
        if (recipes.length === 0) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `No recipe found for ${itemName}. It cannot be crafted.` }));
          return;
        }

        // Find a recipe for which we have ingredients in inventory
        let recipe = null;
        for (const r of recipes) {
          let hasIngredients = true;
          for (const ingredient of r.delta) {
            if (ingredient.count >= 0) continue; // output
            const requiredCount = Math.abs(ingredient.count) * count;
            const inInv = countItemInInventory(ingredient.id);
            if (inInv < requiredCount) {
              hasIngredients = false;
              break;
            }
          }
          if (hasIngredients) {
            recipe = r;
            break;
          }
        }
        // Fall back to the first recipe if none match
        if (!recipe) {
          recipe = recipes[0];
        }
        let tableBlock = null;

        if (recipe.requiresTable) {
          const tableEntry = bot.registry.blocksByName['crafting_table'];
          tableBlock = bot.findBlock({
            matching: tableEntry.id,
            maxDistance: 32
          });
          if (!tableBlock) {
            ws.send(JSON.stringify({
              status: 'FAILED',
              message: `A crafting table is required to craft ${itemName}, but none was found within 32 blocks. You must place a crafting table nearby first.`
            }));
            return;
          }
        }

        // Verify ingredients
        for (const ingredient of recipe.delta) {
          if (ingredient.count >= 0) continue; // output
          const requiredCount = Math.abs(ingredient.count) * count;
          const inInv = countItemInInventory(ingredient.id);
          if (inInv < requiredCount) {
            const ingredientEntry = bot.registry.items[ingredient.id];
            const ingredientName = ingredientEntry ? ingredientEntry.name : `item_${ingredient.id}`;
            ws.send(JSON.stringify({
              status: 'FAILED',
              message: `Missing ingredients to craft ${itemName}. Required: ${requiredCount}x ${ingredientName}, but you only have ${inInv} in inventory.`
            }));
            return;
          }
        }

        // Navigate near table if required
        if (recipe.requiresTable && tableBlock) {
          const dist = bot.entity.position.distanceTo(tableBlock.position);
          if (dist > 3) {
            await bot.ashfinder.goto(new goals.GoalNear(tableBlock.position, 2));
          }
        }

        // Craft it
        const freshRecipe = bot.recipesFor(itemEntry.id, null, null, tableBlock)[0];
        if (freshRecipe) {
          await bot.craft(freshRecipe, count, tableBlock);
          ws.send(JSON.stringify({ status: 'SUCCESS', message: `Crafted ${count} ${itemName}.` }));
        } else {
          ws.send(JSON.stringify({ status: 'FAILED', message: `Could not initiate crafting for ${itemName}.` }));
        }

        queueStateSend(ws);
        return;
      }

      if (action.type === 'EQUIP') {
        const item = bot.inventory.items().find(i => i.name === action.item_name);
        if (!item) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `No ${action.item_name} in inventory.` }));
          return;
        }

        await bot.equip(item, action.slot ?? 'hand');
        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Equipped ${action.item_name} to ${action.slot ?? 'hand'}.` }));
        queueStateSend(ws);
        return;
      }

      // --- FIX #4: ATTACK loops until the mob is dead or out of range ---
      if (action.type === 'ATTACK') {
        let target = null;
        if (action.entity_name) {
          target = Object.values(bot.entities)
            .filter(e => e.type === 'mob' && e.name.toLowerCase().includes(action.entity_name.toLowerCase()))
            .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
        } else {
          const hostiles = ['zombie', 'skeleton', 'spider', 'creeper', 'witch', 'slime', 'enderman', 'drowned', 'husk'];
          target = Object.values(bot.entities)
            .filter(e => e.type === 'mob' && hostiles.includes(e.name))
            .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
        }

        if (!target) {
          ws.send(JSON.stringify({ status: 'FAILED', message: 'No target found nearby.' }));
          return;
        }

        const weapon = bot.inventory.items().find(i => i.name.includes('sword') || i.name.includes('axe'));
        if (weapon) {
          await bot.equip(weapon, 'hand');
        }

        // Loop until mob is dead (removed from entity list) or we are cancelled
        let attackCount = 0;
        const maxAttacks = 40; // safety cap
        while (attackCount < maxAttacks && !isCancelled(myToken)) {
          // Re-check mob still exists
          const stillAlive = bot.entities[target.id];
          if (!stillAlive) break;

          const dist = bot.entity.position.distanceTo(target.position);
          if (dist > 16) {
            // Mob fled too far
            break;
          }

          try {
            if (dist > 2.5) {
              await bot.ashfinder.goto(new goals.GoalNear(target.position, 2));
            }
            await bot.lookAt(target.position.offset(0, 1.2, 0));
            await bot.attack(target);
            attackCount++;
            // Wait for attack cooldown (~10 ticks = 0.5s)
            await bot.waitForTicks(10);
          } catch (e) {
            console.error(`[Attack] Error: ${e.message}`);
            break;
          }
        }

        const killed = !bot.entities[target.id];
        const targetName = target.name || target.username || 'entity';
        ws.send(JSON.stringify({
          status: 'SUCCESS',
          message: killed
            ? `Killed ${targetName} after ${attackCount} hits.`
            : `Attacked ${targetName} ${attackCount} times (may still be alive).`
        }));
        queueStateSend(ws);
        return;
      }

      if (action.type === 'EAT') {
        const food = bot.inventory.items().find(i => bot.registry.foodsByName[i.name] !== undefined);
        if (!food) {
          ws.send(JSON.stringify({ status: 'FAILED', message: 'No food found in inventory.' }));
          return;
        }

        await bot.equip(food, 'hand');
        await bot.consume();

        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Consumed ${food.name}.` }));
        queueStateSend(ws);
        return;
      }

      if (action.type === 'DROP_ITEM') {
        const item = bot.inventory.items().find(i => i.name === action.item_name);
        if (!item) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `No ${action.item_name} in inventory.` }));
          return;
        }
        const count = action.count ?? item.count;
        await bot.toss(item.type, null, count);
        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Dropped ${count} ${action.item_name}.` }));
        queueStateSend(ws);
        return;
      }

      // --- FIX #3: COLLECT_DROPPED_ITEMS uses GoalNear(1) instead of GoalExact ---
      if (action.type === 'COLLECT_DROPPED_ITEMS') {
        const radius = action.radius ?? 16;
        const droppedItems = Object.values(bot.entities)
          .filter(e => e.type === 'object' && e.name === 'item')
          .map(e => ({
            entity: e,
            distance: bot.entity.position.distanceTo(e.position)
          }))
          .filter(e => e.distance <= radius)
          .sort((a, b) => a.distance - b.distance);

        if (droppedItems.length === 0) {
          ws.send(JSON.stringify({ status: 'SUCCESS', message: 'No dropped items found within radius.' }));
          return;
        }

        let collected = 0;
        for (const itemObj of droppedItems) {
          if (isCancelled(myToken)) break;
          // Re-check entity still exists (items can despawn or be picked up)
          if (!bot.entities[itemObj.entity.id]) continue;
          const pos = itemObj.entity.position;
          try {
            // Use GoalNear(1) — items have physics and move slightly
            await bot.ashfinder.goto(new goals.GoalNear(pos, 1));
            await bot.waitForTicks(5);
            collected++;
          } catch (e) {
            // Item may have already been picked up by auto-loot reflex, ignore
          }
        }

        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Attempted to collect ${collected} dropped items.` }));
        queueStateSend(ws);
        return;
      }

      if (action.type === 'INTERACT_WITH_BLOCK') {
        const blockPos = new Vec3(action.x, action.y, action.z);
        const block = bot.blockAt(blockPos);
        if (!block) {
          ws.send(JSON.stringify({ status: 'FAILED', message: 'No block found at coordinates.' }));
          return;
        }
        await bot.ashfinder.goto(new goals.GoalNear(block.position, 2));
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        await bot.activateBlock(block);
        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Interacted with ${block.name} at (${action.x}, ${action.y}, ${action.z}).` }));
        queueStateSend(ws);
        return;
      }

      if (action.type === 'DEPOSIT_CHEST') {
        const chestBlock = bot.blockAt(new Vec3(action.chest_x, action.chest_y, action.chest_z));
        if (!chestBlock || !chestBlock.name.includes('chest')) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `No chest found at (${action.chest_x}, ${action.chest_y}, ${action.chest_z}).` }));
          return;
        }
        await bot.ashfinder.goto(new goals.GoalNear(chestBlock.position, 2));
        const chest = await bot.openChest(chestBlock);

        const item = bot.inventory.items().find(i => i.name === action.item_name);
        if (!item) {
          chest.close();
          ws.send(JSON.stringify({ status: 'FAILED', message: `No ${action.item_name} in inventory.` }));
          return;
        }
        const count = action.count ?? item.count;
        await chest.deposit(item.type, null, count);
        chest.close();

        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Deposited ${count} ${action.item_name} into chest.` }));
        queueStateSend(ws);
        return;
      }

      if (action.type === 'WITHDRAW_CHEST') {
        const chestBlock = bot.blockAt(new Vec3(action.chest_x, action.chest_y, action.chest_z));
        if (!chestBlock || !chestBlock.name.includes('chest')) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `No chest found at (${action.chest_x}, ${action.chest_y}, ${action.chest_z}).` }));
          return;
        }
        await bot.ashfinder.goto(new goals.GoalNear(chestBlock.position, 2));
        const chest = await bot.openChest(chestBlock);

        const item = chest.containerItems().find(i => i.name === action.item_name);
        if (!item) {
          chest.close();
          ws.send(JSON.stringify({ status: 'FAILED', message: `No ${action.item_name} in chest.` }));
          return;
        }
        const count = action.count ?? item.count;
        await chest.withdraw(item.type, null, count);
        chest.close();

        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Withdrew ${count} ${action.item_name} from chest.` }));
        queueStateSend(ws);
        return;
      }

      if (action.type === 'SAY') {
        bot.chat(action.message);
        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Said: "${action.message}" in chat.` }));
        return;
      }

      if (action.type === 'GET_RECIPE') {
        const itemName = action.item_name;
        const itemEntry = bot.registry.itemsByName[itemName] || bot.registry.blocksByName[itemName];
        if (!itemEntry) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `Unknown item name: ${itemName}` }));
          return;
        }

        let recipes = bot.recipesAll(itemEntry.id, null, false);
        if (recipes.length === 0) {
          recipes = bot.recipesAll(itemEntry.id, null, true);
        }
        if (recipes.length === 0) {
          ws.send(JSON.stringify({ status: 'SUCCESS', message: `No recipes found for ${itemName}. It cannot be crafted.` }));
          return;
        }

        const recipeDetails = recipes.map(r => {
          const ingredients = r.delta.filter(d => d.count < 0).map(d => {
            const ingredientEntry = bot.registry.items[d.id];
            return {
              name: ingredientEntry ? ingredientEntry.name : `item_${d.id}`,
              count: Math.abs(d.count)
            };
          });
          return {
            requires_table: r.requiresTable,
            ingredients: ingredients
          };
        });

        ws.send(JSON.stringify({ status: 'SUCCESS', data: recipeDetails }));
        return;
      }

      // --- FIX #2: SMELT_ITEM properly waits for output before closing ---
      if (action.type === 'SMELT_ITEM') {
        const furnacePos = new Vec3(action.furnace_x, action.furnace_y, action.furnace_z);
        const furnaceBlock = bot.blockAt(furnacePos);
        if (!furnaceBlock || furnaceBlock.name !== 'furnace') {
          ws.send(JSON.stringify({ status: 'FAILED', message: `No furnace found at (${action.furnace_x}, ${action.furnace_y}, ${action.furnace_z}).` }));
          return;
        }

        // Navigate near furnace
        await bot.ashfinder.goto(new goals.GoalNear(furnaceBlock.position, 2));

        const item = bot.inventory.items().find(i => i.name === action.item_name);
        if (!item) {
          ws.send(JSON.stringify({ status: 'FAILED', message: `No ${action.item_name} in inventory.` }));
          return;
        }

        const fuel = bot.inventory.items().find(i => ['coal', 'charcoal', 'oak_planks', 'spruce_planks', 'oak_log', 'birch_log'].includes(i.name));
        if (!fuel) {
          ws.send(JSON.stringify({ status: 'FAILED', message: 'No suitable fuel (coal, charcoal, wood, planks) in inventory.' }));
          return;
        }

        const furnace = await bot.openFurnace(furnaceBlock);

        const count = action.count ?? 1;
        await furnace.putInput(item.type, null, count);
        await furnace.putFuel(fuel.type, null, Math.ceil(count / 8));

        // Wait for all items to smelt (each item takes ~10s = 200 ticks)
        // Poll the output slot every 100 ticks until we have our expected output
        console.log(`[SMELT] Waiting for ${count} item(s) to smelt...`);
        const maxWaitTicks = count * 220 + 50; // generous buffer
        let waited = 0;
        let outputCount = 0;
        while (waited < maxWaitTicks && !isCancelled(myToken)) {
          await bot.waitForTicks(20);
          waited += 20;
          const outputItem = furnace.outputItem();
          if (outputItem) {
            outputCount = outputItem.count;
          }
          // If furnace is done (no progress item and output matches)
          const progressItem = furnace.inputItem();
          if (!progressItem && outputCount >= count) break;
        }

        if (outputCount > 0) {
          // Take the output
          try {
            await furnace.takeOutput();
          } catch (e) {}
        }
        furnace.close();

        ws.send(JSON.stringify({ status: 'SUCCESS', message: `Smelted ${outputCount} ${action.item_name}. Waiting complete.` }));
        queueStateSend(ws);
        return;
      }

      ws.send(JSON.stringify({ status: 'ERROR', error: `Unsupported action type: ${action.type}` }));
    } catch (err) {
      ws.send(JSON.stringify({ status: 'FAILED', error: err.message }));
    } finally {
      // Always re-enable the reflex loop movement once a command finishes
      commandInProgress = false;
    }
  });

  ws.on('close', () => {
    console.log('[Game-Layer] Python Orchestrator disconnected.');
    if (activeConnection === ws) {
      activeConnection = null;
    }
  });
});

bot.on('error', (err) => console.error('[Game-Layer] Bot error:', err));
bot.on('end', () => console.log('[Game-Layer] Connection ended.'));
