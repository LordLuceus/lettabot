#!/usr/bin/env node
/**
 * lettabot-bio - Set the bot's Discord profile bio (the "About Me" text
 * shown when a user clicks on the bot in Discord).
 *
 * Usage:
 *   lettabot-bio set "Friendly assistant. Ask me anything."
 *   lettabot-bio clear
 *   lettabot-bio show
 *
 * The CLI writes a one-shot bio-request.json file to the agent's working
 * directory (resolved via getBioRequestFilePath). The running bot polls
 * this file every 5s, applies the change via the Discord application API,
 * and deletes the file. The bio itself lives on Discord's servers — this
 * tool is purely an IPC channel.
 *
 * Note: Only works for Discord. The bio is the application description
 * (max 400 chars).
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

// Config loaded from lettabot.yaml
import { loadAppConfigOrExit, applyConfigToEnv } from '../config/index.js';
import { getBioRequestFilePath } from '../utils/paths.js';
const config = loadAppConfigOrExit();
applyConfigToEnv(config);

// Same fallback chain as the bot server: env wins, falls back to YAML's
// agent.workingDir. Keeps the CLI and bot in sync regardless of cwd.
const REQUEST_FILE = getBioRequestFilePath(config.agent?.workingDir);

const DISCORD_BIO_MAX_LENGTH = 400;

async function writeRequest(payload: { text?: string; clear?: boolean }): Promise<void> {
  await fs.mkdir(dirname(REQUEST_FILE), { recursive: true });
  await fs.writeFile(REQUEST_FILE, JSON.stringify({ ...payload, timestamp: Date.now() }, null, 2));
}

async function setBio(text: string): Promise<void> {
  if (text.length > DISCORD_BIO_MAX_LENGTH) {
    console.warn(`Warning: Bio text is ${text.length} chars (Discord limit: ${DISCORD_BIO_MAX_LENGTH}). It will be truncated.`);
    text = text.slice(0, DISCORD_BIO_MAX_LENGTH - 1) + '\u2026';
  }
  await writeRequest({ text });
  console.log(`✓ Bio update queued (${text.length} chars)`);
  console.log(`  File: ${REQUEST_FILE}`);
  console.log('  The running bot will apply this change within ~5s.');
}

async function clearBio(): Promise<void> {
  await writeRequest({ clear: true });
  console.log('✓ Bio clear queued');
  console.log(`  File: ${REQUEST_FILE}`);
  console.log('  The running bot will apply this change within ~5s.');
}

async function showPending(): Promise<void> {
  console.log(`File: ${REQUEST_FILE}`);
  try {
    const data = await fs.readFile(REQUEST_FILE, 'utf-8');
    const parsed = JSON.parse(data) as { text?: string; clear?: boolean; timestamp?: number };
    const ago = parsed.timestamp ? ` (queued ${new Date(parsed.timestamp).toISOString()})` : '';
    if (parsed.clear) {
      console.log(`Pending request: clear bio${ago}`);
    } else if (parsed.text) {
      console.log(`Pending request: set bio to "${parsed.text}"${ago}`);
    } else {
      console.log(`Pending request: <malformed>${ago}`);
    }
    console.log('Note: the bot may have already consumed and deleted this file.');
  } catch {
    console.log('No pending bio request.');
    console.log('Note: the live bio lives on Discord. This command only shows the pending IPC file.');
  }
}

function showHelp(): void {
  console.log(`
lettabot-bio - Set the bot's profile bio / "About Me" (Discord, 400 char limit)

Commands:
  set <text>       Set the bio text
  clear            Clear the bio
  show             Show pending bio request (if any)

Examples:
  lettabot-bio set "Friendly assistant. Ask me anything."
  lettabot-bio clear
  lettabot-bio show
`);
}

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'set': {
    const text = args.slice(1).join(' ');
    if (!text) {
      console.error('Error: bio text is required');
      console.error('Usage: lettabot-bio set "Your bio text"');
      process.exit(1);
    }
    setBio(text);
    break;
  }
  case 'clear':
    clearBio();
    break;
  case 'show':
    showPending();
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    if (command) {
      // Treat as set if it doesn't look like a command flag
      if (!command.startsWith('-')) {
        setBio(args.join(' '));
        break;
      }
      console.error(`Unknown command: ${command}`);
    }
    showHelp();
    break;
}
