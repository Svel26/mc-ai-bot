# MC AI Bot

A lightweight headless Minecraft bot controller using Mineflayer and a Python orchestration layer.

Note: this is just a quick hobby/test project, do not expect good AI execution or future support/fixes

## Setup

1. Install Node dependencies:

```bash
cd mc-ai-bot
npm install
```

2. Install Python dependencies:

```bash
cd mc-ai-bot
python -m pip install openai websockets python-dotenv
```

## Run the bot controller

The bot now reads the Minecraft server address and the WebSocket port from environment variables.

Defaults are loaded from `.env` if present. Example values are provided in `.env.example`.

Run it like this:

```bash
cd mc-ai-bot
npm start
```

If your LAN host is on another IP, set `MC_HOST` in `.env` or via environment variables.

## Run the Python orchestrator

The orchestrator now reads `.env` automatically if present.

Example `.env` values:

```bash
WS_PORT=8080
MODEL_NAME=qwen/qwen3.6-27b
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=lm-studio
```

Run it like this:

```bash
cd mc-ai-bot
python orchestrator.py
```

If the model is not loaded in LM Studio, load it on the developer page or with `lms load`.

## Example for a LAN-hosted game

If Minecraft is open to LAN on `192.168.1.10:25565`, start the bot with:

```bash
cd mc-ai-bot
MC_HOST=192.168.1.10 MC_PORT=25565 npm start
```

Then start the orchestrator normally:

```bash
cd mc-ai-bot
WS_PORT=8080 python orchestrator.py
```

## Protocol

The bot listens on `ws://localhost:8080` for JSON commands.

Supported commands:

- `{"type": "NAVIGATE", "x": int, "y": int, "z": int}`
- `{"type": "COLLECT_BLOCK", "block_name": "<string>"}`
- `{"type": "GET_INVENTORY"}`

The orchestrator sends structured JSON arrays of tool calls produced by a local LM Studio agent to the bot.
