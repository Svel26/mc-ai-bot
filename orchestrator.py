import asyncio
import json
import os
from pathlib import Path

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

SYSTEM_PROMPT = """
You are a deterministic Minecraft execution kernel. You look at tasks and emit ONLY valid JSON arrays containing tool executions. Do not describe your choices or write conversational text.

Available Tools:
1. Navigate to exact coordinates:
{"type": "NAVIGATE", "x": <int>, "y": <int>, "z": <int>}

2. Harvest specific block type:
{"type": "COLLECT_BLOCK", "block_name": "<string>"}

3. Check inventory contents:
{"type": "GET_INVENTORY"}

Example Input: "Go mine some cobblestone and then come back to the surface base at 100, 64, -200"
Example Output:
[
  {"type": "COLLECT_BLOCK", "block_name": "cobblestone"},
  {"type": "NAVIGATE", "x": 100, "y": 64, "z": -200}
]
"""

async def send_to_bot(payload):
    ws_port = int(os.getenv('WS_PORT', '8080'))
    uri = f"ws://localhost:{ws_port}"
    async with websockets.connect(uri) as websocket:
        await websocket.send(json.dumps(payload))
        response = await websocket.recv()
        return json.loads(response)

async def process_actions(actions):
    for action in actions:
        print(f"[Orchestrator] Executing: {action}")
        result = await send_to_bot(action)
        print(f"[Game-Result]: {result}")

async def main_loop():
    print("[Orchestrator] Active. Type a command for the bot. Use 'exit' to quit.")

    while True:
        user_input = input("\nCommand: ")
        if user_input.strip().lower() == 'exit':
            break

        try:
            completion = ai_client.chat.completions.create(
                model=MODEL_NAME,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_input}
                ],
                temperature=0.0
            )

            raw_output = completion.choices[0].message.content.strip()
            actions = json.loads(raw_output)
            if not isinstance(actions, list):
                raise ValueError('Expected a JSON array of tool calls')

            await process_actions(actions)
        except (json.JSONDecodeError, ValueError) as exc:
            print(f"[Error] Gemma output was invalid or not an array:\n{raw_output if 'raw_output' in locals() else ''}\n{exc}")
        except openai.BadRequestError as exc:
            print("[Error] LM Studio request failed. This usually means the chosen model is not loaded.")
            print(f"Model: {MODEL_NAME}")
            print("Confirm the model exists in LM Studio and is loaded, or set MODEL_NAME to a loaded model.")
            print(f"Details: {exc}")

if __name__ == "__main__":
    asyncio.run(main_loop())
