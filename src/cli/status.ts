#!/usr/bin/env node
/**
 * lettabot-status - Set the bot's custom status text
 *
 * Usage:
 *   lettabot-status set "Working on something cool"
 *   lettabot-status clear
 *
 * Status is persisted to data/bot-status.json and restored on bot startup.
 * The running bot watches this file and applies changes automatically.
 *
 * Note: Only works for Discord (other platforms don't support custom status text).
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';

// Config loaded from lettabot.yaml
import { loadAppConfigOrExit, applyConfigToEnv } from '../config/index.js';
const config = loadAppConfigOrExit();
applyConfigToEnv(config);

const STATUS_FILE = join(process.cwd(), 'data', 'bot-status.json');

const DISCORD_STATUS_MAX_LENGTH = 128;

async function setStatus(text: string): Promise<void> {
  if (text.length > DISCORD_STATUS_MAX_LENGTH) {
    console.warn(`Warning: Status text is ${text.length} chars (Discord limit: ${DISCORD_STATUS_MAX_LENGTH}). It will be truncated.`);
    text = text.slice(0, DISCORD_STATUS_MAX_LENGTH - 1) + '\u2026';
  }
  await fs.mkdir(dirname(STATUS_FILE), { recursive: true });
  await fs.writeFile(STATUS_FILE, JSON.stringify({ message: text, timestamp: Date.now() }, null, 2));
  console.log(`✓ Status set: ${text}`);
  console.log('  The running bot will pick up this change shortly.');
}

async function clearStatus(): Promise<void> {
  try {
    await fs.unlink(STATUS_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  console.log('✓ Status cleared');
  console.log('  The running bot will pick up this change shortly.');
}

async function showStatus(): Promise<void> {
  try {
    const data = await fs.readFile(STATUS_FILE, 'utf-8');
    const parsed = JSON.parse(data) as { message?: string; timestamp?: number };
    if (parsed.message) {
      const ago = parsed.timestamp ? ` (set ${new Date(parsed.timestamp).toISOString()})` : '';
      console.log(`Current status: ${parsed.message}${ago}`);
    } else {
      console.log('No status set');
    }
  } catch {
    console.log('No status set');
  }
}

function showHelp(): void {
  console.log(`
lettabot-status - Set the bot's custom status text (Discord)

Commands:
  set <text>       Set custom status text
  clear            Remove custom status
  show             Show current status

Examples:
  lettabot-status set "Thinking deeply about the universe"
  lettabot-status clear
  lettabot-status show
`);
}

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'set': {
    const text = args.slice(1).join(' ');
    if (!text) {
      console.error('Error: status text is required');
      console.error('Usage: lettabot-status set "Your status text"');
      process.exit(1);
    }
    setStatus(text);
    break;
  }
  case 'clear':
    clearStatus();
    break;
  case 'show':
    showStatus();
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    if (command) {
      // Treat as set if it doesn't look like a command
      if (!command.startsWith('-')) {
        setStatus(args.join(' '));
        break;
      }
      console.error(`Unknown command: ${command}`);
    }
    showHelp();
    break;
}
