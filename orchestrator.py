import asyncio
import json
import os
import threading
from pathlib import Path
import http.server
import socketserver

from dotenv import load_dotenv
import websockets
import openai
from openai import OpenAI

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / '.env')

MODEL_NAME = os.getenv('MODEL_NAME', 'qwen/qwen3.6-27b')
OPENAI_BASE_URL = os.getenv('OPENAI_BASE_URL', 'http://localhost:1234/v1')
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY', 'lm-studio')
ai_client = OpenAI(base_url=OPENAI_BASE_URL, api_key=OPENAI_API_KEY)

# Static system prompt — kept here to maximise KV cache reuse.
# This is the core intelligence specification for the agent.
SYSTEM_PROMPT = """You are GemmaBot, a highly capable autonomous AI agent that fully controls a Minecraft bot.
You are NOT a conversational assistant. You are an ACTION MACHINE. Your only job is to call tools until
the user's goal is completely achieved. NEVER give a conversational reply while a goal is unfinished.

=== OPERATING LOOP ===
Every turn you MUST either:
  A) Call one or more tools to make progress toward the goal, OR
  B) Give a final summary ONLY after EVALUATE_GOAL confirms success.

Do NOT produce a conversational reply while there are still things to do. If unsure what to do next, call
SCAN_AREA to gather information, then call GET_INVENTORY, then make a plan with SET_MEMORY.

=== PHASE 0 — ASSESS (always do this on a new goal) ===
1. Call SCAN_AREA to understand your environment (biome, time of day, what blocks are nearby).
2. Check the Current Bot State for health, food, and inventory already in context.
3. If it is night (time_of_day >= 13000), call SLEEP before doing anything else.
4. If food < 8, find food immediately (mine hay bales for wheat, hunt animals, or check inventory).

=== PHASE 1 — PLAN ===
Before taking any action, call SET_MEMORY with key "active_plan" and a JSON array of steps.
Each step MUST have a concrete success condition, e.g.:
  ["1. Mine 3 oak_log (need 3 in inventory)", "2. Craft 12 oak_planks", "3. Craft crafting_table", "4. DONE"]
Update this plan after each completed step.

=== PHASE 2 — EXECUTE ===
Work through each plan step. After every tool call:
- If SUCCESS → mark step done, move to next step.
- If PARTIAL → the action got some but not all. Check how many you got vs needed and continue.
- If FAILED → DO NOT GIVE UP. Try recovery:
  a. Check inventory (maybe you already have what you need).
  b. Try a wider search radius or a different method.
  c. Try an alternative item (e.g. spruce_log instead of oak_log).
  d. Explore to find resources.

=== PHASE 3 — VERIFY ===
When you believe the goal is done, call EVALUATE_GOAL. Only stop after it confirms success.

=== SURVIVAL RULES (ALWAYS ACTIVE) ===
- If health < 8: find shelter, stop mining, wait for reflexes to handle combat.
- If it turns night mid-task: call SLEEP (the reflex handles combat but you should seek safety).
- Underground: call PLACE_TORCH periodically when light_level < 7 to prevent mob spawns.
- The bot's reflexes auto-handle: eating (food < 15), armor equipping, and nearby hostile combat.
  You do NOT need to manually trigger these unless targeting a specific enemy.

=== CRAFTING KNOWLEDGE ===
Always use GET_RECIPE before crafting something unfamiliar. Common recipes:
- oak_planks: 1 oak_log → 4 planks (no table needed)
- crafting_table: 4 planks → 1 crafting_table (no table needed)
- sticks: 2 planks → 4 sticks (no table needed)
- wooden_pickaxe: 3 planks + 2 sticks, crafting table
- stone_pickaxe: 3 cobblestone + 2 sticks, crafting table
- iron_pickaxe: 3 iron_ingot + 2 sticks, crafting table
- furnace: 8 cobblestone, crafting table
- torch: 1 coal/charcoal + 1 stick → 4 torches (no table needed)
- iron_ingot: smelt raw_iron or iron_ore in furnace with coal as fuel
- iron_helmet: 5 iron_ingot, crafting table
- iron_chestplate: 8 iron_ingot, crafting table
- iron_leggings: 7 iron_ingot, crafting table
- iron_boots: 4 iron_ingot, crafting table

BLOCK NAME REFERENCE:
- Trees: oak_log, birch_log, spruce_log, jungle_log, acacia_log, dark_oak_log
- Stone: stone, cobblestone, deepslate, granite, diorite, andesite
- Ores: coal_ore, iron_ore, gold_ore, diamond_ore, deepslate_iron_ore, deepslate_coal_ore
- Raw metals: raw_iron, raw_gold, raw_copper
- Dirt/surface: dirt, grass_block, sand, gravel

=== TOOL GUIDELINES ===
- AUTO_MINE is your primary resource gathering tool. It expands search radius automatically (32→64→128 blocks).
  If it returns PARTIAL, check data.mined vs data.target and call it again if needed.
- EXPLORE when you need to find a biome, structure, or resources not in your immediate area.
- FIND_BLOCK before NAVIGATE to get exact coordinates of a target block.
- SET_MEMORY often — use it to remember base coordinates, chest locations, and plan state.
- Never call NAVIGATE with made-up coordinates. Always get real coordinates from FIND_BLOCK or SCAN_AREA first.
"""

# -- FIX #11 + Tier 2: Full tool schema including previously missing SMELT_ITEM,
#    GET_RECIPE, GET_INVENTORY, and new FIND_ENTITY tool --
TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "AUTO_MINE",
            "description": "Autonomously search, navigate to, and mine multiple blocks of a given type in a loop. Highly recommended for gathering resources like stone, wood, coal, etc.!",
            "parameters": {
                "type": "object",
                "properties": {
                    "block_name": {"type": "string", "description": "The block name to mine (e.g. coal_ore, iron_ore, oak_log, cobblestone)"},
                    "count": {"type": "integer", "description": "Number of blocks to mine"}
                },
                "required": ["block_name", "count"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "BUILD_STRUCTURE",
            "description": "Construct predefined schematics at specific start coordinates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "structure_type": {
                        "type": "string",
                        "enum": ["shelter", "wall", "bridge", "staircase"],
                        "description": "Type of structure to build"
                    },
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                    "z": {"type": "integer"}
                },
                "required": ["structure_type", "x", "y", "z"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "EXPLORE",
            "description": "Wanders the landscape safely for a set distance, scanning for chests, villages, and other points of interest.",
            "parameters": {
                "type": "object",
                "properties": {
                    "distance": {"type": "integer", "description": "Distance to wander (default 40)"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "NAVIGATE",
            "description": "Walk to exact coordinates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                    "z": {"type": "integer"}
                },
                "required": ["x", "y", "z"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "NAVIGATE_NEAR",
            "description": "Walk close to coordinates (within a range). Recommended over NAVIGATE.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                    "z": {"type": "integer"},
                    "range": {"type": "integer", "description": "Target radius range from coordinates"}
                },
                "required": ["x", "y", "z"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "FIND_BLOCK",
            "description": "Search the surrounding area for block coordinates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "block_name": {"type": "string"},
                    "radius": {"type": "integer", "description": "Search radius (default 32)"},
                    "count": {"type": "integer", "description": "Max count to return"}
                },
                "required": ["block_name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "FIND_ENTITY",
            "description": "Search for nearby entities (mobs or players) by name or type. Returns their positions and distances.",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_name": {"type": "string", "description": "Partial name of the entity to search for (e.g. 'zombie', 'steve')"},
                    "entity_type": {
                        "type": "string",
                        "enum": ["mob", "player", ""],
                        "description": "Filter by entity type: 'mob', 'player', or empty for all"
                    },
                    "radius": {"type": "integer", "description": "Search radius in blocks (default 64)"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "COLLECT_BLOCK",
            "description": "Navigate to and mine a specific block type nearby (use AUTO_MINE for multiple).",
            "parameters": {
                "type": "object",
                "properties": {
                    "block_name": {"type": "string"}
                },
                "required": ["block_name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "PLACE_BLOCK",
            "description": "Place a block from inventory. If coordinates are omitted, the bot automatically finds a suitable empty block nearby and returns the coordinates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "block_name": {"type": "string"},
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                    "z": {"type": "integer"}
                },
                "required": ["block_name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "CRAFT",
            "description": "Craft a specific item. Recipe must be known/available.",
            "parameters": {
                "type": "object",
                "properties": {
                    "block_name": {"type": "string", "description": "The item/block to craft"},
                    "count": {"type": "integer", "description": "Quantity to craft"}
                },
                "required": ["block_name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "GET_RECIPE",
            "description": "Retrieve crafting ingredients and table requirements for any item name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_name": {"type": "string"}
                },
                "required": ["item_name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "GET_INVENTORY",
            "description": "Get the bot's full current inventory list with item names and counts.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "EQUIP",
            "description": "Equip an item from inventory to a slot.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_name": {"type": "string"},
                    "slot": {
                        "type": "string",
                        "enum": ["hand", "head", "torso", "legs", "feet"]
                    }
                },
                "required": ["item_name", "slot"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ATTACK",
            "description": "Fight a specific target or nearby hostiles. Loops until the mob is killed or retreats.",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_name": {"type": "string", "description": "Optional name of mob to target"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "SAY",
            "description": "Speak in the Minecraft server chat.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {"type": "string"}
                },
                "required": ["message"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "DROP_ITEM",
            "description": "Drop an item from inventory on the ground.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_name": {"type": "string"},
                    "count": {"type": "integer", "description": "Optional count (drops all if omitted)"}
                },
                "required": ["item_name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "COLLECT_DROPPED_ITEMS",
            "description": "Scan the ground for dropped items nearby and pick them up.",
            "parameters": {
                "type": "object",
                "properties": {
                    "radius": {"type": "integer", "description": "Optional search radius (default 16)"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "INTERACT_WITH_BLOCK",
            "description": "Right-click/activate a block (button, lever, chest, door).",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                    "z": {"type": "integer"}
                },
                "required": ["x", "y", "z"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "DEPOSIT_CHEST",
            "description": "Store items in a chest.",
            "parameters": {
                "type": "object",
                "properties": {
                    "chest_x": {"type": "integer"},
                    "chest_y": {"type": "integer"},
                    "chest_z": {"type": "integer"},
                    "item_name": {"type": "string"},
                    "count": {"type": "integer"}
                },
                "required": ["chest_x", "chest_y", "chest_z", "item_name", "count"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "WITHDRAW_CHEST",
            "description": "Retrieve items from a chest.",
            "parameters": {
                "type": "object",
                "properties": {
                    "chest_x": {"type": "integer"},
                    "chest_y": {"type": "integer"},
                    "chest_z": {"type": "integer"},
                    "item_name": {"type": "string"},
                    "count": {"type": "integer"}
                },
                "required": ["chest_x", "chest_y", "chest_z", "item_name", "count"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "SMELT_ITEM",
            "description": "Smelt an item in a furnace. The bot will wait for smelting to complete before returning.",
            "parameters": {
                "type": "object",
                "properties": {
                    "furnace_x": {"type": "integer"},
                    "furnace_y": {"type": "integer"},
                    "furnace_z": {"type": "integer"},
                    "item_name": {"type": "string", "description": "Item to smelt (e.g. 'iron_ore', 'raw_iron', 'beef')"},
                    "count": {"type": "integer", "description": "How many items to smelt"}
                },
                "required": ["furnace_x", "furnace_y", "furnace_z", "item_name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "SLEEP",
            "description": "Sleep through the night in a nearby bed. If no bed is found, waits until dawn. Call this whenever it is night time (time_of_day >= 13000).",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "SCAN_AREA",
            "description": "Scan the surrounding environment. Returns biome, time of day, light level, nearby block types and counts, nearest water/lava, health and food. Always call this at the start of a new goal.",
            "parameters": {
                "type": "object",
                "properties": {
                    "radius": {"type": "integer", "description": "Scan radius in blocks (default 48, max 96)"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "WAIT",
            "description": "Wait a number of game ticks (20 ticks = 1 second). Use to pause before re-checking a condition. Max 2400 ticks (2 minutes).",
            "parameters": {
                "type": "object",
                "properties": {
                    "ticks": {"type": "integer", "description": "Number of ticks to wait (default 100)"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "PLACE_TORCH",
            "description": "Place a torch from inventory on the nearest valid surface. Use underground when light level is low to prevent mob spawns.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "SET_MEMORY",
            "description": "Save a fact, location coordinates, or plan subgoals to persistent memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "e.g. locations.base, facts.chest, active_plan"},
                    "value": {"type": "string", "description": "Value to save (can be serialized JSON or text)"}
                },
                "required": ["key", "value"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "EVALUATE_GOAL",
            "description": "Evaluate the current world state against the primary goal to verify completeness. MUST be called before declaring a goal done.",
            "parameters": {
                "type": "object",
                "properties": {
                    "goal_description": {"type": "string", "description": "The goal we are evaluating"}
                },
                "required": ["goal_description"]
            }
        }
    }
]

# -- FIX #10: Action-aware timeout config --
# Macro actions that take a long time get a longer timeout
MACRO_ACTIONS = {"AUTO_MINE", "BUILD_STRUCTURE", "EXPLORE", "SMELT_ITEM"}
MACRO_TIMEOUT = 300.0   # 5 minutes for macro actions
DEFAULT_TIMEOUT = 90.0  # 90 seconds for normal actions

# Global State
bot_conn = None
bot_state = {}
active_command_future = None
dashboard_clients = set()
chat_history = []
agent_lock = asyncio.Lock()
cli_queue = asyncio.Queue()

# Memory system variables
MEMORY_FILE = BASE_DIR / 'memory.json'
memory = {
    "locations": {},
    "facts": {},
    "active_plan": []
}

def load_memory():
    global memory
    if MEMORY_FILE.exists():
        try:
            with open(MEMORY_FILE, 'r') as f:
                memory.update(json.load(f))
            print(f"[Memory] Loaded persistent memory: {list(memory.keys())}")
        except Exception as e:
            print(f"[Memory] Error loading memory.json: {e}")

def save_memory():
    try:
        with open(MEMORY_FILE, 'w') as f:
            json.dump(memory, f, indent=2)
    except Exception as e:
        print(f"[Memory] Error saving memory.json: {e}")

# Thread-safe HTTP Web Server to serve the dashboard UI
def start_http_server():
    PORT = 8000
    Handler = http.server.SimpleHTTPRequestHandler

    class DashboardHandler(Handler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(BASE_DIR / 'dashboard'), **kwargs)

        def log_message(self, format, *args):
            # Suppress normal HTTP logging to keep console clean
            pass

    # Allow port reuse to avoid 'Address already in use' errors on quick restarts
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), DashboardHandler) as httpd:
        print(f"[Orchestrator] Web Dashboard served at http://localhost:{PORT}")
        httpd.serve_forever()

# Broadcast message to all Web Dashboards
async def broadcast_to_dashboards(message):
    if not dashboard_clients:
        return
    payload = json.dumps(message)
    await asyncio.gather(*[client.send(payload) for client in list(dashboard_clients)], return_exceptions=True)

# -- FIX #10: Exponential backoff on reconnect --
async def bot_connection_loop():
    global bot_conn, bot_state, active_command_future
    ws_port = int(os.getenv('WS_PORT', '8080'))
    uri = f"ws://localhost:{ws_port}"
    retry_delay = 3.0
    MAX_RETRY_DELAY = 30.0

    while True:
        try:
            print(f"[Orchestrator] Connecting to Minecraft Bot at {uri}...")
            async with websockets.connect(uri) as websocket:
                bot_conn = websocket
                retry_delay = 3.0  # reset on successful connect
                print("[Orchestrator] Connected to Minecraft Bot.")
                await broadcast_to_dashboards({"type": "BOT_STATUS", "status": "CONNECTED"})

                # Send memory updates on bot connection
                await broadcast_to_dashboards({"type": "MEMORY_UPDATE", "memory": memory})

                async for message in websocket:
                    data = json.loads(message)
                    if data.get('type') == 'STATE':
                        bot_state = data
                        await broadcast_to_dashboards(data)
                    elif data.get('type') == 'DAMAGE_TAKEN':
                        print(f"[Orchestrator] Bot took damage! Health: {data.get('health')}. Interrupting current action.")
                        if active_command_future and not active_command_future.done():
                            await websocket.send(json.dumps({"type": "STOP"}))
                            active_command_future.set_result({
                                "status": "INTERRUPTED",
                                "error": f"Bot took damage! Health: {data.get('health')}"
                            })
                    elif data.get('type') == 'IN_GAME_CHAT':
                        sender = data.get('username')
                        msg_text = data.get('message')
                        asyncio.create_task(run_agent_loop(msg_text, trigger_username=sender))
                    elif data.get('type') == 'DISCOVERY':
                        await broadcast_to_dashboards(data)
                        print(f"[Orchestrator] Discovery Event: {data.get('name')} at {data.get('position')}")
                    elif 'status' in data:
                        # Command execution response
                        if active_command_future and not active_command_future.done():
                            active_command_future.set_result(data)
        except Exception as e:
            bot_conn = None
            print(f"[Orchestrator] Connection to bot lost: {e}. Retrying in {retry_delay:.0f}s...")
            await broadcast_to_dashboards({"type": "BOT_STATUS", "status": "DISCONNECTED"})
            if active_command_future and not active_command_future.done():
                active_command_future.set_exception(e)
            await asyncio.sleep(retry_delay)
            # Exponential backoff, capped at MAX_RETRY_DELAY
            retry_delay = min(retry_delay * 1.5, MAX_RETRY_DELAY)

# -- FIX #7: Action-aware timeout --
async def send_command_to_bot(action):
    global bot_conn, active_command_future
    if not bot_conn:
        return {"status": "FAILED", "error": "Bot is not connected"}

    action_type = action.get("type", "")
    timeout = MACRO_TIMEOUT if action_type in MACRO_ACTIONS else DEFAULT_TIMEOUT

    active_command_future = asyncio.get_running_loop().create_future()
    try:
        await bot_conn.send(json.dumps(action))
        result = await asyncio.wait_for(active_command_future, timeout=timeout)
        return result
    except asyncio.TimeoutError:
        return {"status": "FAILED", "error": f"Command '{action_type}' timed out after {timeout:.0f}s."}
    except Exception as e:
        return {"status": "FAILED", "error": f"Bot connection error: {e}"}
    finally:
        active_command_future = None

# Handle WebSocket clients connecting from Web Dashboard
async def dashboard_server_handler(websocket):
    global dashboard_clients, bot_state, bot_conn, memory
    dashboard_clients.add(websocket)
    print(f"[Orchestrator] Dashboard connected. Total clients: {len(dashboard_clients)}")

    try:
        # Send initial bot status, state, and memory if available
        if bot_state:
            await websocket.send(json.dumps(bot_state))

        await websocket.send(json.dumps({"type": "MEMORY_UPDATE", "memory": memory}))

        status_msg = "CONNECTED" if bot_conn else "DISCONNECTED"
        await websocket.send(json.dumps({"type": "BOT_STATUS", "status": status_msg}))

        async for message in websocket:
            data = json.loads(message)
            if data.get("type") == "USER_COMMAND":
                cmd = data.get("command")
                asyncio.create_task(run_agent_loop(cmd))
            elif data.get("type") == "STOP_COMMAND":
                # Dashboard stop button pressed
                if bot_conn:
                    await bot_conn.send(json.dumps({"type": "STOP"}))
                    if active_command_future and not active_command_future.done():
                        active_command_future.set_result({"status": "INTERRUPTED", "message": "Stopped by dashboard."})
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        dashboard_clients.discard(websocket)
        print(f"[Orchestrator] Dashboard disconnected. Total clients: {len(dashboard_clients)}")


def _truncate_history_safely(history, max_messages=20):
    """
    -- FIX #8: Truncate chat_history while preserving complete turn pairs.
    A 'turn pair' is an assistant message with tool_calls + its corresponding
    tool response messages. Orphaned tool messages (without the preceding
    assistant call) break most LLM APIs.
    """
    if len(history) <= max_messages:
        return history

    # Trim from the front, but never leave a 'tool' message without its
    # preceding 'assistant' message.
    trimmed = history[-max_messages:]

    # Walk forward until we find the first non-orphaned turn
    for i, msg in enumerate(trimmed):
        if msg.get("role") == "tool":
            continue  # look for a safe cut point after this orphan
        # Safe to start here
        return trimmed[i:]

    return trimmed


# -- Persistent goal injection + no-progress detection helpers --

def _build_messages(state_summary, memory_data, active_goal=None, step=1, max_steps=25):
    """
    Build the message list for each LLM call.
    The active_goal is pinned as a second system message that never scrolls out of context,
    even after many tool calls truncate chat_history.
    """
    state_content = (
        f"[Current Bot State]\n{json.dumps(state_summary, indent=2)}\n\n"
        f"[Persistent Memory]\n{json.dumps(memory_data, indent=2)}"
    )

    goal_reminder = ""
    if active_goal:
        goal_reminder = (
            f"[ACTIVE GOAL — Step {step}/{max_steps}]\n"
            f"Your current task is: {active_goal}\n"
            f"Keep calling tools until this is completely finished. "
            f"Do NOT give a conversational reply until EVALUATE_GOAL confirms success."
        )

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if goal_reminder:
        messages.append({"role": "system", "content": goal_reminder})
    messages.append({"role": "system", "content": state_content})
    messages.extend(chat_history)
    return messages


def _check_no_progress(recent_calls, threshold=3):
    """
    Returns True if the last `threshold` tool calls were identical (same name + same args)
    and all had non-SUCCESS status, indicating the agent is stuck in a loop.
    """
    if len(recent_calls) < threshold:
        return False
    last = recent_calls[-threshold:]
    return len(set(last)) == 1


# Main Agent loop running ReAct loop
async def run_agent_loop(user_input, trigger_username=None):
    global bot_state, chat_history, memory

    async with agent_lock:
        print(f"\n[Agent] New goal received: {user_input} (Triggered by: {trigger_username})")

        # Broadcast user message to dashboards
        sender_name = f"user ({trigger_username})" if trigger_username else "user"
        await broadcast_to_dashboards({"type": "CHAT", "sender": sender_name, "content": user_input})

        chat_history.append({"role": "user", "content": f"{trigger_username} said: {user_input}" if trigger_username else user_input})

        # -- Safe truncation that preserves turn pairs --
        chat_history = _truncate_history_safely(chat_history, max_messages=20)

        # Pin the original goal for persistent injection into every LLM call
        active_goal = user_input

        # No-progress detection: track (tool_name, args_json) of recent calls
        recent_call_signatures: list[str] = []
        NO_PROGRESS_THRESHOLD = 3  # same call 3× in a row = stuck

        step = 0
        max_steps = 25

        while step < max_steps:
            step += 1

            state_summary = {
                "position": bot_state.get("pos", {"x": 0, "y": 0, "z": 0}),
                "health": bot_state.get("health", 20),
                "food": bot_state.get("food", 20),
                "oxygen": bot_state.get("oxygen", 20),
                "inventory": bot_state.get("inventory", []),
                "entities": bot_state.get("entities", []),
                "time": bot_state.get("time", 0)
            }

            await broadcast_to_dashboards({"type": "LOG", "log_type": "status", "content": f"Thinking (Step {step}/{max_steps})..."})

            try:
                messages = _build_messages(state_summary, memory, active_goal, step, max_steps)

                completion = ai_client.chat.completions.create(
                    model=MODEL_NAME,
                    messages=messages,
                    tools=TOOLS_SCHEMA,
                    tool_choice="auto",
                    temperature=0.0
                )

                message = completion.choices[0].message
                thought = message.content or ""
                tool_calls = message.tool_calls
            except openai.BadRequestError as exc:
                err_msg = f"LM Studio call failed. Check if model '{MODEL_NAME}' is loaded."
                print(f"[Agent Error] {err_msg}: {exc}")
                await broadcast_to_dashboards({"type": "LOG", "log_type": "error", "content": err_msg})
                break
            except Exception as e:
                err_msg = f"LLM output parse failed: {e}. Retrying."
                print(f"[Agent Error] {err_msg}")
                await broadcast_to_dashboards({"type": "LOG", "log_type": "error", "content": err_msg})
                chat_history.append({"role": "user", "content": f"System Error: Failed to generate or parse response. Error: {e}."})
                continue

            if thought:
                print(f"[Thought]: {thought}")
                await broadcast_to_dashboards({"type": "LOG", "log_type": "thought", "content": thought})

            if tool_calls:
                # Append assistant message with tool calls to history
                tc_dicts = []
                for tc in tool_calls:
                    tc_dicts.append({
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments
                        }
                    })
                chat_history.append({
                    "role": "assistant",
                    "content": thought,
                    "tool_calls": tc_dicts
                })

                for tc in tool_calls:
                    name = tc.function.name
                    try:
                        params = json.loads(tc.function.arguments)
                    except Exception:
                        params = {}

                    # Handle local SET_MEMORY tool
                    if name == "SET_MEMORY":
                        key = params.get("key")
                        value = params.get("value")
                        if key:
                            parts = key.split('.')
                            if len(parts) == 2:
                                parent, child = parts[0], parts[1]
                                if parent not in memory:
                                    memory[parent] = {}
                                memory[parent][child] = value
                            else:
                                memory[key] = value
                            save_memory()
                            status = "SUCCESS"
                            msg = f"Saved memory key '{key}' with value: {value}"
                            await broadcast_to_dashboards({"type": "MEMORY_UPDATE", "memory": memory})
                        else:
                            status = "FAILED"
                            msg = "Missing 'key' or 'value' parameters in SET_MEMORY call."

                        print(f"[Memory Tool Result]: {status} - {msg}")
                        await broadcast_to_dashboards({"type": "LOG", "log_type": "tool_result", "content": f"Result: {status} - {msg}"})

                        chat_history.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "name": name,
                            "content": f"Tool Execution Result:\nStatus: {status}\nMessage: {msg}"
                        })
                        # SET_MEMORY is always a progress action, don't count it toward no-progress
                        recent_call_signatures.clear()

                    else:
                        action_payload = {"type": name, **params}
                        print(f"[Tool Call]: {name} with {params}")
                        await broadcast_to_dashboards({"type": "LOG", "log_type": "tool_call", "content": f"Executing: {name} {json.dumps(params)}"})

                        result = await send_command_to_bot(action_payload)
                        status = result.get("status", "FAILED")
                        msg = result.get("message", result.get("error", "No response details"))
                        data_val = result.get("data", None)

                        print(f"[Tool Result]: {status} - {msg}")
                        await broadcast_to_dashboards({"type": "LOG", "log_type": "tool_result", "content": f"Result: {status} - {msg}"})

                        chat_history.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "name": name,
                            "content": f"Tool Execution Result:\nStatus: {status}\nMessage: {msg}\nData: {json.dumps(data_val) if data_val else ''}"
                        })

                        # No-progress detection
                        sig = f"{name}:{json.dumps(params, sort_keys=True)}"
                        if status in ("FAILED", "ERROR", "INTERRUPTED"):
                            recent_call_signatures.append(sig)
                            if len(recent_call_signatures) > NO_PROGRESS_THRESHOLD:
                                recent_call_signatures = recent_call_signatures[-NO_PROGRESS_THRESHOLD:]
                            if _check_no_progress(recent_call_signatures, NO_PROGRESS_THRESHOLD):
                                stuck_msg = (
                                    f"SYSTEM NOTICE: You have called {name} with the same arguments "
                                    f"{NO_PROGRESS_THRESHOLD} times in a row and it keeps failing. "
                                    f"You MUST try a completely different approach, different tool, or "
                                    f"different arguments. Do not call {name} with these same arguments again."
                                )
                                print(f"[Agent] No-progress detected on {name}. Injecting recovery prompt.")
                                await broadcast_to_dashboards({"type": "LOG", "log_type": "error", "content": f"No-progress loop detected on {name}. Forcing recovery."})
                                chat_history.append({"role": "user", "content": stuck_msg})
                                recent_call_signatures.clear()
                        else:
                            # Any non-failure clears the stuck counter
                            recent_call_signatures.clear()

            else:
                # No tool calls = the model wants to give a conversational reply.
                # If goal isn't verified yet, push it back on track.
                if thought:
                    # Check if this looks like a premature stop (goal not yet verified)
                    lower_thought = thought.lower()
                    goal_phrases = ['done', 'complet', 'finish', 'achiev', 'success']
                    if any(p in lower_thought for p in goal_phrases) and step < max_steps - 1:
                        # Force it to verify before stopping
                        recovery = (
                            "You seem to think the goal is done, but you haven't called EVALUATE_GOAL yet. "
                            "Call EVALUATE_GOAL now to confirm before finishing."
                        )
                        chat_history.append({"role": "assistant", "content": thought})
                        chat_history.append({"role": "user", "content": recovery})
                        await broadcast_to_dashboards({"type": "LOG", "log_type": "status", "content": "Forcing EVALUATE_GOAL before stopping..."})
                        continue  # give it another step to verify

                    print(f"[GemmaBot]: {thought}")
                    await broadcast_to_dashboards({"type": "CHAT", "sender": "bot", "content": thought})
                    chat_history.append({"role": "assistant", "content": thought})
                    # If command came from in-game chat, reply in-game!
                    if trigger_username:
                        await send_command_to_bot({"type": "SAY", "message": f"{trigger_username}: {thought}"})
                break

# Thread-safe CLI inputs
def cli_input_thread(loop):
    while True:
        try:
            cmd = input()
            if cmd.strip():
                asyncio.run_coroutine_threadsafe(cli_queue.put(cmd), loop)
        except (KeyboardInterrupt, EOFError):
            break

async def cli_consumer():
    while True:
        cmd = await cli_queue.get()
        if cmd.strip().lower() == 'exit':
            print("[Orchestrator] Shutting down...")
            os._exit(0)
        asyncio.create_task(run_agent_loop(cmd))

async def main():
    print("[Orchestrator] Initializing...")

    # Load memory from disk
    load_memory()

    # Start thread-safe HTTP Web Server
    threading.Thread(target=start_http_server, daemon=True).start()

    # Start bot connection loop task
    asyncio.create_task(bot_connection_loop())

    # Start CLI consumer task
    asyncio.create_task(cli_consumer())

    # Start CLI input reader thread
    loop = asyncio.get_running_loop()
    threading.Thread(target=cli_input_thread, args=(loop,), daemon=True).start()

    # Start Dashboard WebSocket Server on port 8081
    print("[Orchestrator] Launching Web Dashboard WebSocket Server on port 8081...")
    async with websockets.serve(dashboard_server_handler, "0.0.0.0", 8081):
        print("[Orchestrator] Active. Type a command or open the web dashboard to begin. Use 'exit' to quit.")
        # Keep running
        await asyncio.Event().wait()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[Orchestrator] Terminated by user.")
