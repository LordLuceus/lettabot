#!/usr/bin/env node
/**
 * lettabot-help - List all agent-facing CLI commands
 *
 * This is the discovery entry point for the agent. Instead of documenting
 * every command in the system prompt, the agent can run this to see what's
 * available, then run `<command> --help` for details.
 */

const COMMANDS = [
  {
    name: 'lettabot-message',
    description: 'Send messages and files to users across channels',
    examples: [
      'lettabot-message send --text "Hello!"',
      'lettabot-message send --file photo.png --image',
      'lettabot-message send --text "Hi" --channel discord --chat 123456789',
    ],
  },
  {
    name: 'lettabot-react',
    description: 'Add emoji reactions to messages',
    examples: [
      'lettabot-react add --emoji :eyes:',
      'lettabot-react add --emoji "<:custom:123456>" --channel discord --chat 123 --message 456',
    ],
  },
  {
    name: 'lettabot-channels',
    description: 'Discover channels and custom emoji across platforms',
    examples: [
      'lettabot-channels list',
      'lettabot-channels list --channel discord',
      'lettabot-channels emoji',
      'lettabot-channels emoji --server "My Server"',
    ],
  },
  {
    name: 'lettabot-history',
    description: 'Fetch message history from channels (Discord, Slack)',
    examples: [
      'lettabot-history fetch --limit 50',
      'lettabot-history fetch --limit 50 --channel discord --chat 123456789',
    ],
  },
  {
    name: 'lettabot-status',
    description: 'Set the bot\'s custom status text (Discord, 128 char limit)',
    examples: [
      'lettabot-status set "Working on something cool"',
      'lettabot-status clear',
      'lettabot-status show',
    ],
  },
  {
    name: 'lettabot-schedule',
    description: 'Create and manage scheduled tasks (reminders, cron jobs)',
    examples: [
      'lettabot-schedule create --name "Reminder" --at "2026-01-28T20:15:00Z" --message "Break time!"',
      'lettabot-schedule create --name "Daily" --schedule "0 8 * * *" --message "Good morning!"',
      'lettabot-schedule list',
      'lettabot-schedule delete <job-id>',
    ],
  },
];

function showHelp(): void {
  console.log('Available agent CLI commands:\n');

  for (const cmd of COMMANDS) {
    console.log(`  ${cmd.name}`);
    console.log(`    ${cmd.description}`);
    console.log(`    Examples:`);
    for (const ex of cmd.examples) {
      console.log(`      ${ex}`);
    }
    console.log();
  }

  console.log('Run any command with --help for full usage details.');
  console.log('Example: lettabot-message --help');
}

showHelp();
