/**
 * Config schema — drives the portal config editor UI.
 *
 * Pure metadata: maps each settable config field to its type, label, default,
 * options (for enums), and restart-required flag. Consumed by:
 *   - GET /api/v1/config/schema endpoint
 *   - The portal config editor at /config
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'secret' | 'string[]';

export interface SchemaField {
  key: string;
  type: FieldType;
  label: string;
  description?: string;
  default?: unknown;
  options?: string[];     // for enum type
  required?: boolean;
  restartRequired?: boolean;
}

export interface SchemaGroup {
  id: string;
  label: string;
  fields: SchemaField[];
}

// Group channel config fields (shared across Discord, Telegram, Slack, etc.)
export const GROUP_CONFIG_FIELDS: SchemaField[] = [
  { key: 'mode', type: 'enum', label: 'Mode', options: ['open', 'listen', 'mention-only', 'disabled'], default: 'open', description: 'How the bot engages in this group' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users', description: 'Only process messages from these user IDs' },
  { key: 'receiveBotMessages', type: 'boolean', label: 'Receive Bot Messages', default: false, description: 'Process messages from other bots' },
  { key: 'dailyLimit', type: 'number', label: 'Daily Limit', description: 'Max bot triggers per day in this group' },
  { key: 'dailyUserLimit', type: 'number', label: 'Daily User Limit', description: 'Max triggers per user per day' },
  { key: 'threadMode', type: 'enum', label: 'Thread Mode', options: ['any', 'thread-only'], default: 'any', description: 'Discord: require messages to be in a thread (thread-only) or respond anywhere (any)' },
  { key: 'autoCreateThreadOnMention', type: 'boolean', label: 'Auto-Create Thread on Mention', default: false, description: 'Discord: auto-create a thread when the bot is @mentioned in a channel' },
];

// Per-channel schema definitions (key prefix is relative to the channel object)
export const DISCORD_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'token', type: 'secret', label: 'Bot Token', restartRequired: true },
  { key: 'dmPolicy', type: 'enum', label: 'DM Policy', options: ['pairing', 'allowlist', 'open'], default: 'pairing' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users', description: 'User IDs for allowlist policy' },
  { key: 'streaming', type: 'boolean', label: 'Streaming', description: 'Stream responses via progressive edits' },
  { key: 'groupDebounceSec', type: 'number', label: 'Group Debounce (sec)', default: 5, description: 'Debounce interval for group messages' },
  { key: 'instantGroups', type: 'string[]', label: 'Instant Groups', description: 'Guild/channel IDs that bypass batching' },
  { key: 'excludeChannels', type: 'string[]', label: 'Exclude Channels', description: 'Channel/guild IDs to completely ignore' },
  { key: 'ignoreBotReactions', type: 'boolean', label: 'Ignore Bot Reactions', default: true, description: 'Ignore emoji reactions from bots' },
  { key: 'memberEvents', type: 'boolean', label: 'Member Events', description: 'Enable member join/leave events' },
  { key: 'welcomeChannel', type: 'string', label: 'Welcome Channel', description: 'Channel ID for join/leave events' },
];

export const TELEGRAM_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'token', type: 'secret', label: 'Bot Token', restartRequired: true },
  { key: 'dmPolicy', type: 'enum', label: 'DM Policy', options: ['pairing', 'allowlist', 'open'], default: 'pairing' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users' },
  { key: 'streaming', type: 'boolean', label: 'Streaming' },
  { key: 'groupDebounceSec', type: 'number', label: 'Group Debounce (sec)', default: 5 },
  { key: 'instantGroups', type: 'string[]', label: 'Instant Groups' },
  { key: 'mentionPatterns', type: 'string[]', label: 'Mention Patterns', description: 'Regex patterns for mention detection' },
  { key: 'excludeChannels', type: 'string[]', label: 'Exclude Channels' },
];

export const SLACK_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'botToken', type: 'secret', label: 'Bot Token (xoxb-...)', restartRequired: true },
  { key: 'appToken', type: 'secret', label: 'App Token (xapp-...)', restartRequired: true },
  { key: 'dmPolicy', type: 'enum', label: 'DM Policy', options: ['pairing', 'allowlist', 'open'], default: 'pairing' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users' },
  { key: 'streaming', type: 'boolean', label: 'Streaming' },
  { key: 'groupDebounceSec', type: 'number', label: 'Group Debounce (sec)', default: 5 },
  { key: 'instantGroups', type: 'string[]', label: 'Instant Groups' },
  { key: 'excludeChannels', type: 'string[]', label: 'Exclude Channels' },
];

export const SIGNAL_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'phone', type: 'secret', label: 'Phone Number', restartRequired: true },
  { key: 'dmPolicy', type: 'enum', label: 'DM Policy', options: ['pairing', 'allowlist', 'open'], default: 'pairing' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users' },
  { key: 'selfChat', type: 'boolean', label: 'Self Chat', default: true },
  { key: 'mentionPatterns', type: 'string[]', label: 'Mention Patterns' },
  { key: 'groupDebounceSec', type: 'number', label: 'Group Debounce (sec)', default: 5 },
  { key: 'instantGroups', type: 'string[]', label: 'Instant Groups' },
  { key: 'excludeChannels', type: 'string[]', label: 'Exclude Channels' },
  { key: 'readReceipts', type: 'boolean', label: 'Read Receipts', default: true, description: 'Send read receipts for incoming messages' },
];

export const WHATSAPP_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'dmPolicy', type: 'enum', label: 'DM Policy', options: ['pairing', 'allowlist', 'open'], default: 'pairing' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users' },
  { key: 'selfChat', type: 'boolean', label: 'Self Chat' },
  { key: 'groupPolicy', type: 'enum', label: 'Group Policy', options: ['open', 'disabled', 'allowlist'], default: 'open' },
  { key: 'mentionPatterns', type: 'string[]', label: 'Mention Patterns' },
  { key: 'groupDebounceSec', type: 'number', label: 'Group Debounce (sec)', default: 5 },
  { key: 'instantGroups', type: 'string[]', label: 'Instant Groups' },
];

export const BLUESKY_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'handle', type: 'string', label: 'Handle', description: 'Bluesky handle (for posting)' },
  { key: 'appPassword', type: 'secret', label: 'App Password', restartRequired: true },
  { key: 'serviceUrl', type: 'string', label: 'Service URL', description: 'ATProto service URL (default: https://bsky.social)' },
  { key: 'appViewUrl', type: 'string', label: 'AppView URL', description: 'For list/notification APIs' },
  { key: 'jetstreamUrl', type: 'string', label: 'Jetstream URL', description: 'Jetstream WebSocket URL' },
  { key: 'wantedDids', type: 'string[]', label: 'Wanted DIDs', description: 'DID(s) to follow (e.g. did:plc:...)' },
  { key: 'wantedCollections', type: 'string[]', label: 'Wanted Collections', description: 'e.g. app.bsky.feed.post' },
  { key: 'notifications.enabled', type: 'boolean', label: 'Notifications', description: 'Poll notifications API' },
  { key: 'notifications.intervalSec', type: 'number', label: 'Notification Poll Interval (sec)', default: 60 },
  { key: 'notifications.reasons', type: 'string[]', label: 'Notification Reasons', description: 'Filter: mention, reply, etc.' },
];

export const AGENT_INFO_FIELDS: SchemaField[] = [
  { key: 'name', type: 'string', label: 'Name', required: true, restartRequired: true },
  { key: 'id', type: 'string', label: 'Agent ID', description: 'Existing Letta agent ID (skip creation)' },
  { key: 'displayName', type: 'string', label: 'Display Name', description: 'Prefix for outbound messages' },
  { key: 'model', type: 'string', label: 'Model', description: 'Model for initial agent creation' },
  { key: 'workingDir', type: 'string', label: 'Working Directory', description: 'Runtime data directory (default: /tmp/lettabot)', restartRequired: true },
];

export const FEATURES_FIELDS: SchemaField[] = [
  { key: 'features.cron', type: 'boolean', label: 'Cron Jobs', description: 'Enable scheduled cron tasks' },
  { key: 'features.heartbeat.enabled', type: 'boolean', label: 'Heartbeat', description: 'Send periodic heartbeat messages' },
  { key: 'features.heartbeat.intervalMin', type: 'number', label: 'Heartbeat Interval (min)', default: 60 },
  { key: 'features.heartbeat.skipRecentUserMin', type: 'number', label: 'Skip After User (min)', default: 0 },
  { key: 'features.heartbeat.skipRecentPolicy', type: 'enum', label: 'Skip Recent Policy', options: ['fixed', 'fraction', 'off'], default: 'fixed', description: 'How to calculate skip window: fixed minutes, fraction of interval, or disabled' },
  { key: 'features.heartbeat.skipRecentFraction', type: 'number', label: 'Skip Recent Fraction', description: 'Fraction of intervalMin when policy=fraction (0-1)' },
  { key: 'features.heartbeat.interruptOnUserMessage', type: 'boolean', label: 'Interrupt on User Message', description: 'Cancel in-flight heartbeat when a user messages' },
  { key: 'features.heartbeat.prompt', type: 'string', label: 'Heartbeat Prompt' },
  { key: 'features.heartbeat.promptFile', type: 'string', label: 'Heartbeat Prompt File', description: 'Path to prompt file (re-read each tick for live editing)' },
  { key: 'features.heartbeat.target', type: 'string', label: 'Heartbeat Target', description: 'e.g. telegram:12345' },
  { key: 'features.memfs', type: 'boolean', label: 'Memory Filesystem', description: 'Enable git-backed context repository' },
  { key: 'features.syncSystemPrompt', type: 'boolean', label: 'Sync System Prompt', default: true },
  { key: 'features.maxToolCalls', type: 'number', label: 'Max Tool Calls', default: 100 },
  { key: 'features.inlineImages', type: 'boolean', label: 'Inline Images', default: true },
  { key: 'features.autoVoice', type: 'boolean', label: 'Auto Voice', description: 'Automatically generate TTS voice memo for every text response' },
  { key: 'features.display.toolCalls', type: 'boolean', label: 'Show Tool Calls' },
  { key: 'features.display.reasoning', type: 'boolean', label: 'Show Reasoning' },
  { key: 'features.sleeptime.trigger', type: 'enum', label: 'Sleeptime Trigger', options: ['off', 'step-count', 'compaction-event'], default: 'off', description: 'When to trigger SDK reflection' },
  { key: 'features.sleeptime.behavior', type: 'enum', label: 'Sleeptime Behavior', options: ['reminder', 'auto-launch'], default: 'reminder', description: 'How to handle sleeptime (reminder prompt or auto-launch)' },
  { key: 'features.sleeptime.stepCount', type: 'number', label: 'Sleeptime Step Count', description: 'Trigger after N steps (when trigger = step-count)' },
  { key: 'features.logging.turnLogFile', type: 'string', label: 'Turn Log File', description: 'Path to JSONL file for turn logging' },
  { key: 'features.logging.maxTurns', type: 'number', label: 'Max Log Turns', default: 1000, description: 'Max turns to retain in log file' },
  { key: 'features.allowedTools', type: 'string[]', label: 'Allowed Tools' },
  { key: 'features.disallowedTools', type: 'string[]', label: 'Disallowed Tools' },
];

export const CONVERSATIONS_FIELDS: SchemaField[] = [
  { key: 'conversations.mode', type: 'enum', label: 'Mode', options: ['disabled', 'shared', 'per-channel', 'per-chat'], default: 'shared' },
  { key: 'conversations.heartbeat', type: 'string', label: 'Heartbeat Routing', description: 'dedicated, last-active, or channel name' },
  { key: 'conversations.perChannel', type: 'string[]', label: 'Per-Channel Keys' },
  { key: 'conversations.maxSessions', type: 'number', label: 'Max Sessions', default: 10 },
  { key: 'conversations.reuseSession', type: 'boolean', label: 'Reuse Session', default: true },
];

export const CONFIG_SCHEMA = {
  global: [
    {
      id: 'server', label: 'Server', fields: [
        { key: 'server.mode', type: 'enum' as FieldType, label: 'Mode', options: ['api', 'docker'], default: 'api', description: 'api = Letta Cloud, docker = self-hosted', restartRequired: true },
        { key: 'server.baseUrl', type: 'string' as FieldType, label: 'Base URL', description: 'Letta server URL (docker mode only)', restartRequired: true },
        { key: 'server.apiKey', type: 'secret' as FieldType, label: 'API Key', description: 'Letta API key', restartRequired: true },
        { key: 'server.logLevel', type: 'enum' as FieldType, label: 'Log Level', options: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'], default: 'info' },
        { key: 'server.api.port', type: 'number' as FieldType, label: 'API Port', default: 8080, restartRequired: true },
        { key: 'server.api.host', type: 'string' as FieldType, label: 'API Host', default: '127.0.0.1', restartRequired: true },
        { key: 'server.api.corsOrigin', type: 'string' as FieldType, label: 'CORS Origin' },
      ],
    },
    {
      id: 'transcription', label: 'Transcription', fields: [
        { key: 'transcription.provider', type: 'enum' as FieldType, label: 'Provider', options: ['openai', 'mistral'] },
        { key: 'transcription.apiKey', type: 'secret' as FieldType, label: 'API Key' },
        { key: 'transcription.model', type: 'string' as FieldType, label: 'Model' },
      ],
    },
    {
      id: 'tts', label: 'Text-to-Speech', fields: [
        { key: 'tts.provider', type: 'enum' as FieldType, label: 'Provider', options: ['elevenlabs', 'openai'], default: 'elevenlabs' },
        { key: 'tts.apiKey', type: 'secret' as FieldType, label: 'API Key' },
        { key: 'tts.voiceId', type: 'string' as FieldType, label: 'Voice ID' },
        { key: 'tts.model', type: 'string' as FieldType, label: 'Model' },
      ],
    },
    {
      id: 'attachments', label: 'Attachments', fields: [
        { key: 'attachments.maxMB', type: 'number' as FieldType, label: 'Max Size (MB)' },
        { key: 'attachments.maxAgeDays', type: 'number' as FieldType, label: 'Max Age (days)' },
      ],
    },
    {
      id: 'security', label: 'Security', fields: [
        { key: 'security.redaction.secrets', type: 'boolean' as FieldType, label: 'Redact Secrets', default: true },
        { key: 'security.redaction.pii', type: 'boolean' as FieldType, label: 'Redact PII', default: false },
      ],
    },
  ] as SchemaGroup[],
  agent: {
    info: AGENT_INFO_FIELDS,
    features: FEATURES_FIELDS,
    conversations: CONVERSATIONS_FIELDS,
    channels: {
      discord: { label: 'Discord', fields: DISCORD_FIELDS },
      telegram: { label: 'Telegram', fields: TELEGRAM_FIELDS },
      slack: { label: 'Slack', fields: SLACK_FIELDS },
      signal: { label: 'Signal', fields: SIGNAL_FIELDS },
      whatsapp: { label: 'WhatsApp', fields: WHATSAPP_FIELDS },
      bluesky: { label: 'Bluesky', fields: BLUESKY_FIELDS },
    },
    groupConfig: GROUP_CONFIG_FIELDS,
  },
};
