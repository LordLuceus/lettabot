# Getting Started

Get LettaBot running in 5 minutes.

## Prerequisites

- Node.js 20+
- npm or yarn
- A Telegram account
- A self-hosted Letta server (see [Self-Hosted Letta Server](./selfhosted-setup.md))

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/letta-ai/lettabot.git
cd lettabot
npm ci
```

> **Note:** Always use `npm ci` (not `npm install`) to avoid modifying the lockfile, which would block future `git pull` updates.

### 2. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 3. Configure LettaBot

**Option A: Interactive Setup (Recommended)**

```bash
npm run build
npm link
lettabot onboard
```

This will walk you through configuration interactively.

**Option B: Manual Setup**

```bash
cp .env.example .env
```

Edit `.env`:
```bash
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
LETTA_BASE_URL=http://localhost:8283    # URL of your Letta server
LETTA_API_KEY=your_letta_api_key        # Only if your Letta server has auth
```

### 4. Start the Bot

```bash
npm run dev
```

You should see:
```
Starting LettaBot...
Bot started as @your_bot_name
Allowed users: all
```

### 5. Chat with Your Bot

Open Telegram and message your bot. Try:
- "Hello!"
- "What can you help me with?"
- "Remember that my favorite color is blue"

## Configuration Options

Configuration is most easily expressed as a list rather than a table.

- `TELEGRAM_BOT_TOKEN` (required): from @BotFather
- `LETTA_BASE_URL` (optional): URL of your Letta server. Default: `http://localhost:8283`
- `LETTA_API_KEY` (optional): only required if your Letta server has auth enabled
- `ALLOWED_USERS` (optional): comma-separated Telegram user IDs to allow
- `WORKING_DIR` (optional): base directory for agent workspaces (default: `/tmp/lettabot`)
- `LETTA_CLI_PATH` (optional): custom path to letta CLI

## Restricting Access

To limit who can use your bot, set `ALLOWED_USERS`:

```bash
# Find your Telegram user ID by messaging @userinfobot
ALLOWED_USERS=123456789,987654321
```

## Updating

Pull the latest changes and rebuild:

```bash
npm run update
```

This performs a fast-forward-only pull, installs dependencies, and rebuilds without resetting tracked files.

## Next Steps

- [Commands Reference](./commands.md) - Learn all bot commands
- [Gmail Integration](./gmail-pubsub.md) - Set up email notifications
- [Slack Setup](./slack-setup.md) - Add Slack channel
- [Discord Setup](./discord-setup.md) - Add Discord channel
