# New Discord Features — March 2026

This document covers the new Discord-specific features added to LettaBot. Most of these require config changes in `lettabot.yaml` and one requires a Discord Developer Portal change.

---

## 1. Channel Exclusion

You can now exclude specific channels or entire servers so the bot completely ignores them — no messages processed, no reactions tracked, nothing.

### Config

Add `excludeChannels` to your Discord config with an array of channel IDs and/or guild (server) IDs:

```yaml
discord:
  enabled: true
  token: "..."
  excludeChannels:
    - "1234567890123456789"   # A specific channel ID
    - "9876543210987654321"   # A guild/server ID (excludes ALL channels in that server)
```

The bot checks both the channel ID and the guild ID against this list. If either matches, the message is silently dropped before any processing happens.

### No restart needed?

You do need to restart the bot for config changes to take effect.

---

## 2. Custom Server Emoji in Reactions

The `<react>` directive and the `lettabot-react` CLI now support custom server emoji (the ones you upload to your Discord server), not just standard Unicode emoji.

### How it works

The agent can use custom emoji in three ways:

1. **By name** — The bot looks up the emoji in the server's emoji cache:
   ```xml
   <actions><react emoji="pepe" /></actions>
   ```

2. **By Discord format** — Full `<:name:id>` or `<a:name:id>` (animated) syntax:
   ```xml
   <actions><react emoji="<:pepe:123456789>" /></actions>
   ```

3. **Via CLI** — The `lettabot-react` CLI also supports the `<:name:id>` format:
   ```bash
   lettabot-react add --emoji "<:pepe:123456789>"
   ```

Name-based lookup (option 1) only works through the directive, not the CLI, because the CLI uses the REST API and doesn't have access to the guild's emoji cache.

### Discovering available emoji

The agent can list all custom emoji on a server using:

```bash
# List custom emoji from all servers the bot is in
lettabot-channels emoji

# Filter by server name or ID
lettabot-channels emoji --server "My Server"
```

Output looks like:
```
Discord Custom Emoji:
  Server: My Server (id: 123456789) — 12 custom emoji
    :pepe     :  <:pepe:111111111111>
    :sadge    :  <:sadge:222222222222>
    :copium   :  <a:copium:333333333333> (animated)
```

The agent can then use the name directly in a react directive or copy the `<:name:id>` format.

### No config changes needed

This works out of the box. The agent's per-message directives section now mentions custom emoji support when responding in Discord.

---

## 3. Custom Bot Status

The agent can now set a custom status text on the Discord bot (the "Custom Status" that appears under the bot's name in the member list).

### Two interfaces

**XML Directive** (in normal responses):
```xml
<actions><set-status>Pondering the meaning of life</set-status></actions>
```

To clear:
```xml
<actions><set-status clear="true" /></actions>
```

**CLI** (in silent mode — heartbeats, cron jobs):
```bash
lettabot-status set "Working on something cool"
lettabot-status clear
lettabot-status show
```

### Persistence

The status is saved to `data/bot-status.json` and automatically restored when the bot restarts. The running bot polls this file every 5 seconds, so changes made via the CLI are picked up without a restart.

### No config changes needed

This works out of the box. The agent already knows about it through its system prompt and per-message directives.

---

## 4. Message History Reading

The agent can now read past messages from Discord channels using the `lettabot-history` CLI. (This feature already existed but the agent didn't know about it — now it's documented in the system prompt.)

```bash
# Read last 50 messages from the current channel
lettabot-history fetch --limit 50

# Read from a specific channel
lettabot-history fetch --limit 50 --channel discord --chat 123456789

# Pagination — fetch messages before a specific message ID
lettabot-history fetch --limit 50 --before 987654321
```

### No config changes needed

Uses the bot token that's already configured.

---

## 5. Member Join/Leave Events

The bot can now detect when members join or leave the Discord server and surface these events to the agent. This enables welcome messages, onboarding flows, etc.

### Prerequisites

**This is the one feature that requires a Discord Developer Portal change.**

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your bot application
3. Go to **Bot** in the left sidebar
4. Under **Privileged Gateway Intents**, enable **Server Members Intent**
5. Save changes

Without this, the bot will fail to connect if `memberEvents` is enabled.

### Config

```yaml
discord:
  enabled: true
  token: "..."
  memberEvents: true                  # Enable join/leave events
  welcomeChannel: "123456789012345"   # Channel to post join/leave events (optional)
```

- `memberEvents: true` — Enables the `GuildMembers` privileged intent and registers the event listeners. Default: `false`.
- `welcomeChannel` — The channel ID where join/leave events are sent to the agent. If not set, falls back to the server's system channel (the one Discord uses for its own welcome messages). If neither exists, the event is silently dropped.

### What the agent sees

When a member joins:
```
[System: Member joined]
User: username (Display Name)
Server: My Server Name
```

When a member leaves:
```
[System: Member left]
User: username (Display Name)
Server: My Server Name
```

The message is sent to the configured welcome channel and the agent can respond normally — welcome the new member, say goodbye, react, or use `<no-reply/>`.

### Group mode interaction

The welcome channel must pass the existing group-mode checks. If you have a `groups` config without a `"*"` wildcard, make sure the welcome channel ID is included. If the welcome channel is in `excludeChannels`, events are silently dropped.

---

## Full Config Example

Here's what a Discord config with all new features looks like:

```yaml
discord:
  enabled: true
  token: "${DISCORD_BOT_TOKEN}"
  dmPolicy: open
  streaming: true

  # Exclude channels the bot shouldn't see at all
  excludeChannels:
    - "111111111111111111"   # #bot-dev (technical discussion)

  # Member join/leave events
  memberEvents: true
  welcomeChannel: "222222222222222222"   # #welcome

  # Existing group mode config (unchanged)
  groups:
    "333333333333333333":   # #general
      mode: open
    "222222222222222222":   # #welcome (must be listed if no "*" wildcard)
      mode: open
    "*":
      mode: mention-only
```

---

## 6. System Prompt Sync on Startup

The agent's system prompt on the Letta server is now automatically synced with LettaBot's built-in prompt on every bot startup. This means new CLI commands, directives, and documentation are available to the agent without manually updating the prompt or recreating the agent.

### Config

Enabled by default. To disable (e.g. if you've made custom edits to the agent's prompt that you don't want overwritten):

```yaml
features:
  syncSystemPrompt: false
```

When disabled, the system prompt is only set at agent creation time and never updated.

---

## Summary

| Feature | Config change | Developer Portal | Restart needed |
|---------|:---:|:---:|:---:|
| Channel exclusion | Yes (`excludeChannels`) | No | Yes |
| Custom emoji reactions | No | No | No (after deploy) |
| Custom emoji listing | No | No | No (after deploy) |
| Custom bot status | No | No | No (after deploy) |
| Message history | No | No | No (after deploy) |
| Member join/leave | Yes (`memberEvents`, `welcomeChannel`) | Yes (Server Members Intent) | Yes |
| System prompt sync | No (on by default) | No | Yes |
