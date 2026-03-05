/**
 * Discord Channel Adapter
 *
 * Uses discord.js for Discord API.
 * Supports DM pairing for secure access control.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, InboundReaction, OutboundFile, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import { isUserAllowed, upsertPairingRequest } from '../pairing/store.js';
import { buildAttachmentPath, downloadToFile } from './attachments.js';
import { HELP_TEXT } from '../core/commands.js';
import { isGroupAllowed, isGroupUserAllowed, resolveGroupMode, resolveReceiveBotMessages, resolveDailyLimits, checkDailyLimit, type GroupModeConfig } from './group-mode.js';
import { basename } from 'node:path';

import { createLogger } from '../logger.js';

const log = createLogger('Discord');
// Dynamic import to avoid requiring Discord deps if not used
let Client: typeof import('discord.js').Client;
let GatewayIntentBits: typeof import('discord.js').GatewayIntentBits;
let Partials: typeof import('discord.js').Partials;

export interface DiscordConfig {
  token: string;
  dmPolicy?: DmPolicy;      // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: string[];  // Discord user IDs
  streaming?: boolean;      // Stream responses via progressive message edits (default: false)
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
  groups?: Record<string, GroupModeConfig>;  // Per-guild/channel settings
  excludeChannels?: string[];  // Channel/guild IDs to completely exclude
  welcomeChannel?: string;     // Channel ID for member join/leave events (fallback: guild system channel)
  memberEvents?: boolean;      // Enable member join/leave events (default: false, requires GuildMembers intent)
  agentName?: string;       // For scoping daily limit counters in multi-agent mode
}

export function shouldProcessDiscordBotMessage(params: {
  isFromBot: boolean;
  isGroup: boolean;
  authorId?: string;
  selfUserId?: string;
  groups?: Record<string, GroupModeConfig>;
  keys: string[];
}): boolean {
  if (!params.isFromBot) return true;
  if (!params.isGroup) return false;
  if (params.selfUserId && params.authorId === params.selfUserId) return false;
  return resolveReceiveBotMessages(params.groups, params.keys);
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord' as const;
  readonly name = 'Discord';

  private client: InstanceType<typeof Client> | null = null;
  private config: DiscordConfig;
  private running = false;
  private attachmentsDir?: string;
  private attachmentsMaxBytes?: number;
  private statusWatcher: ReturnType<typeof setInterval> | null = null;
  private lastStatusText: string | null = null;

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string, chatId?: string, args?: string) => Promise<string | null>;

  constructor(config: DiscordConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',
    };
    this.attachmentsDir = config.attachmentsDir;
    this.attachmentsMaxBytes = config.attachmentsMaxBytes;
  }

  /**
   * Check if a user is authorized based on dmPolicy
   * Returns 'allowed', 'blocked', or 'pairing'
   */
  private async checkAccess(userId: string): Promise<'allowed' | 'blocked' | 'pairing'> {
    const policy = this.config.dmPolicy || 'pairing';

    // Open policy: everyone allowed
    if (policy === 'open') {
      return 'allowed';
    }

    // Check if already allowed (config or store)
    const allowed = await isUserAllowed('discord', userId, this.config.allowedUsers);
    if (allowed) {
      return 'allowed';
    }

    // Allowlist policy: not allowed if not in list
    if (policy === 'allowlist') {
      return 'blocked';
    }

    // Pairing policy: needs pairing
    return 'pairing';
  }

  /**
   * Format pairing message for Discord
   */
  private formatPairingMsg(code: string): string {
    return `Hi! This bot requires pairing.

Your pairing code: **${code}**

Ask the bot owner to approve with:
\`lettabot pairing approve discord ${code}\``;
  }

  private async sendPairingMessage(
    message: import('discord.js').Message,
    text: string
  ): Promise<void> {
    const channel = message.channel;
    const canSend = channel.isTextBased() && 'send' in channel;
    const sendable = canSend
      ? (channel as unknown as { send: (content: string) => Promise<unknown> })
      : null;

    if (!message.guildId) {
      if (sendable) {
        await sendable.send(text);
      }
      return;
    }

    try {
      await message.author.send(text);
    } catch {
      if (sendable) {
        await sendable.send(text);
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    const discord = await import('discord.js');
    Client = discord.Client;
    GatewayIntentBits = discord.GatewayIntentBits;
    Partials = discord.Partials;

    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
    ];
    // GuildMembers is a privileged intent — only request it when member events are configured.
    // The user must also enable "Server Members Intent" in the Discord Developer Portal.
    if (this.config.memberEvents) {
      intents.push(GatewayIntentBits.GuildMembers);
      log.info('Member events enabled — requesting GuildMembers intent');
    }

    this.client = new Client({
      intents,
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    });

    this.client.once('clientReady', async () => {
      const tag = this.client?.user?.tag || '(unknown)';
      log.info(`Bot logged in as ${tag}`);
      log.info(`DM policy: ${this.config.dmPolicy}`);
      this.running = true;

      // Restore saved custom status from previous session
      const savedStatus = await loadDiscordStatus();
      this.lastStatusText = savedStatus;
      if (savedStatus && this.client?.user) {
        try {
          const { ActivityType } = await import('discord.js');
          this.client.user.setActivity(savedStatus, { type: ActivityType.Custom });
          log.info(`Restored status: ${savedStatus}`);
        } catch (err) {
          log.warn('Failed to restore status:', err);
        }
      }

      // Watch status file for changes from lettabot-status CLI
      this.statusWatcher = setInterval(async () => {
        try {
          const current = await loadDiscordStatus();
          if (current !== this.lastStatusText) {
            this.lastStatusText = current;
            if (this.client?.user) {
              const { ActivityType } = await import('discord.js');
              if (current) {
                this.client.user.setActivity(current, { type: ActivityType.Custom });
                log.info(`Status updated from file: ${current}`);
              } else {
                this.client.user.setActivity('');
                log.info('Status cleared from file');
              }
            }
          }
        } catch {
          // Ignore poll errors
        }
      }, 5000); // Poll every 5 seconds
    });

    this.client.on('messageCreate', async (message) => {
      // Exclusion list: completely ignore messages from excluded channels/guilds
      if (this.config.excludeChannels?.length) {
        const chatId = message.channel.id;
        const guildId = message.guildId;
        if (this.config.excludeChannels.includes(chatId) || (guildId && this.config.excludeChannels.includes(guildId))) {
          return;
        }
      }

      const isFromBot = !!message.author?.bot;
      const isGroup = !!message.guildId;
      const chatId = message.channel.id;
      const keys = [chatId];
      if (message.guildId) keys.push(message.guildId);
      const selfUserId = this.client?.user?.id;

      if (!shouldProcessDiscordBotMessage({
        isFromBot,
        isGroup,
        authorId: message.author?.id,
        selfUserId,
        groups: this.config.groups,
        keys,
      })) return;

      let content = (message.content || '').trim();
      const userId = message.author?.id;
      if (!userId) return;
      
      // Handle audio attachments
      const audioAttachment = message.attachments.find(a => a.contentType?.startsWith('audio/'));
      if (audioAttachment?.url) {
        try {
          const { isTranscriptionConfigured } = await import('../transcription/index.js');
          if (!isTranscriptionConfigured()) {
            await message.reply('Voice messages require a transcription API key. See: https://github.com/letta-ai/lettabot#voice');
          } else {
            // Download audio
            const response = await fetch(audioAttachment.url);
            const buffer = Buffer.from(await response.arrayBuffer());
            
            const { transcribeAudio } = await import('../transcription/index.js');
            const ext = audioAttachment.contentType?.split('/')[1] || 'mp3';
            const result = await transcribeAudio(buffer, audioAttachment.name || `audio.${ext}`);
            
            if (result.success && result.text) {
              log.info(`Transcribed audio: "${result.text.slice(0, 50)}..."`);
              content = (content ? content + '\n' : '') + `[Voice message]: ${result.text}`;
            } else {
              log.error(`Transcription failed: ${result.error}`);
              content = (content ? content + '\n' : '') + `[Voice message - transcription failed: ${result.error}]`;
            }
          }
        } catch (error) {
          log.error('Error transcribing audio:', error);
          content = (content ? content + '\n' : '') + `[Voice message - error: ${error instanceof Error ? error.message : 'unknown error'}]`;
        }
      }

      // Bypass pairing for guild (group) messages
      if (!message.guildId) {
        const access = await this.checkAccess(userId);
        if (access === 'blocked') {
          const ch = message.channel;
          if (ch.isTextBased() && 'send' in ch) {
            await (ch as { send: (content: string) => Promise<unknown> }).send(
              "Sorry, you're not authorized to use this bot."
            );
          }
          return;
        }

        if (access === 'pairing') {
          const { code, created } = await upsertPairingRequest('discord', userId, {
            username: message.author.username,
          });

          if (!code) {
            await message.channel.send('Too many pending pairing requests. Please try again later.');
            return;
          }

          if (created) {
            log.info(`New pairing request from ${userId} (${message.author.username}): ${code}`);
          }

          await this.sendPairingMessage(message, this.formatPairingMsg(code));
          return;
        }
      }

      const attachments = await this.collectAttachments(message.attachments, message.channel.id);
      if (!content && attachments.length === 0) return;

      if (content.startsWith('/')) {
        const parts = content.slice(1).split(/\s+/);
        const command = parts[0]?.toLowerCase();
        const cmdArgs = parts.slice(1).join(' ') || undefined;
        if (command === 'help' || command === 'start') {
          await message.channel.send(HELP_TEXT);
          return;
        }
        if (this.onCommand) {
          if (command === 'status' || command === 'reset' || command === 'heartbeat' || command === 'cancel' || command === 'model') {
            const result = await this.onCommand(command, message.channel.id, cmdArgs);
            if (result) {
              await message.channel.send(result);
            }
            return;
          }
        }
      }

      if (this.onMessage) {
        const isGroup = !!message.guildId;
        const groupName = isGroup && 'name' in message.channel ? message.channel.name : undefined;
        const displayName = message.member?.displayName || message.author.globalName || message.author.username;
        const wasMentioned = isGroup && !!this.client?.user && message.mentions.has(this.client.user);
        let isListeningMode = false;

        // Group gating: config-based allowlist + mode
        if (isGroup && this.config.groups) {
          const chatId = message.channel.id;
          const serverId = message.guildId;
          const keys = [chatId];
          if (serverId) keys.push(serverId);
          if (!isGroupAllowed(this.config.groups, keys)) {
            log.info(`Group ${chatId} not in allowlist, ignoring`);
            return;
          }

          if (!isGroupUserAllowed(this.config.groups, keys, userId)) {
            return; // User not in group allowedUsers -- silent drop
          }

          const mode = resolveGroupMode(this.config.groups, keys, 'open');
          if (mode === 'disabled') {
            return; // Groups disabled for this channel -- silent drop
          }
          if (mode === 'mention-only' && !wasMentioned) {
            return; // Mention required but not mentioned -- silent drop
          }
          isListeningMode = mode === 'listen' && !wasMentioned;

          // Daily rate limit check (after all other gating so we only count real triggers)
          const limits = resolveDailyLimits(this.config.groups, keys);
          const counterScope = limits.matchedKey ?? chatId;
          const counterKey = `${this.config.agentName ?? ''}:discord:${counterScope}`;
          const limitResult = checkDailyLimit(counterKey, userId, limits);
          if (!limitResult.allowed) {
            log.info(`Daily limit reached for ${counterKey} (${limitResult.reason})`);
            return;
          }
        }

        await this.onMessage({
          channel: 'discord',
          chatId: message.channel.id,
          userId,
          userName: displayName,
          userHandle: message.author.username,
          messageId: message.id,
          text: content || '',
          timestamp: message.createdAt,
          isGroup,
          groupName,
          serverId: message.guildId || undefined,
          wasMentioned,
          isListeningMode,
          attachments,
          formatterHints: this.getFormatterHints(),
        });
      }
    });

    this.client.on('error', (err) => {
      log.error('Client error:', err);
    });

    this.client.on('messageReactionAdd', async (reaction, user) => {
      await this.handleReactionEvent(reaction, user, 'added');
    });

    this.client.on('messageReactionRemove', async (reaction, user) => {
      await this.handleReactionEvent(reaction, user, 'removed');
    });

    // Member join/leave events (requires GuildMembers intent + Developer Portal toggle)
    if (this.config.memberEvents) {
      this.client.on('guildMemberAdd', async (member) => {
        await this.handleMemberEvent(member, 'member_join');
      });

      this.client.on('guildMemberRemove', async (member) => {
        await this.handleMemberEvent(member, 'member_leave');
      });
    }

    log.info('Connecting...');
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    if (this.statusWatcher) {
      clearInterval(this.statusWatcher);
      this.statusWatcher = null;
    }
    if (!this.running || !this.client) return;
    this.client.destroy();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Discord not started');
    const channel = await this.client.channels.fetch(msg.chatId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel not found or not text-based: ${msg.chatId}`);
    }

    const sendable = channel as { send: (content: string) => Promise<{ id: string }> };
    const chunks = splitMessageText(msg.text);
    let lastMessageId = '';
    for (const chunk of chunks) {
      const result = await sendable.send(chunk);
      lastMessageId = result.id;
    }
    return { messageId: lastMessageId };
  }

  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Discord not started');
    const channel = await this.client.channels.fetch(file.chatId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel not found or not text-based: ${file.chatId}`);
    }

    const payload = {
      content: file.caption || undefined,
      files: [
        { attachment: file.filePath, name: basename(file.filePath) },
      ],
    };
    const result = await (channel as { send: (options: typeof payload) => Promise<{ id: string }> }).send(payload);
    return { messageId: result.id };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Discord not started');
    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel not found or not text-based: ${chatId}`);
    }

    const message = await channel.messages.fetch(messageId);
    const botUserId = this.client.user?.id;
    if (!botUserId || message.author.id !== botUserId) {
      log.warn('Cannot edit message not sent by bot');
      return;
    }

    // Discord edit limit is 2000 chars -- truncate if needed (edits can't split)
    const truncated = text.length > DISCORD_MAX_LENGTH
      ? text.slice(0, DISCORD_MAX_LENGTH - 1) + '\u2026'
      : text;
    await message.edit(truncated);
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) throw new Error('Discord not started');
    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel not found or not text-based: ${chatId}`);
    }

    const textChannel = channel as { messages: { fetch: (id: string) => Promise<{ react: (input: string) => Promise<unknown>; guild?: { emojis: { cache: Map<string, { name: string | null; id: string; animated: boolean }> } } }> } };
    const message = await textChannel.messages.fetch(messageId);
    let resolved = resolveDiscordEmoji(emoji);

    // If resolved doesn't look like a Unicode emoji or a custom emoji (name:id),
    // try looking it up in the guild's custom emoji cache by name
    if (message.guild && !resolved.includes(':') && !/[\u{1F000}-\u{1FFFF}]/u.test(resolved)) {
      const guild = message.guild as unknown as { emojis: { cache: Map<string, { name: string | null; id: string; animated: boolean }> } };
      const guildEmoji = Array.from(guild.emojis.cache.values()).find(
        (e) => e.name?.toLowerCase() === resolved.toLowerCase()
      );
      if (guildEmoji) {
        resolved = guildEmoji.animated ? `a:${guildEmoji.name}:${guildEmoji.id}` : `${guildEmoji.name}:${guildEmoji.id}`;
        log.info(`Resolved custom emoji "${emoji}" → ${resolved}`);
      }
    }

    await message.react(resolved);
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !channel.isTextBased() || !('sendTyping' in channel)) return;
      await (channel as { sendTyping: () => Promise<void> }).sendTyping();
    } catch {
      // Ignore typing indicator failures
    }
  }

  async setStatus(text: string | null): Promise<void> {
    if (!this.client?.user) throw new Error('Discord not started');
    const { ActivityType } = await import('discord.js');
    if (text) {
      // Discord custom status has a 128 character limit
      if (text.length > DISCORD_STATUS_MAX_LENGTH) {
        const truncated = text.slice(0, DISCORD_STATUS_MAX_LENGTH - 1) + '\u2026';
        log.warn(`Status text truncated from ${text.length} to ${DISCORD_STATUS_MAX_LENGTH} chars`);
        text = truncated;
      }
      this.client.user.setActivity(text, { type: ActivityType.Custom });
      log.info(`Status set: ${text}`);
    } else {
      this.client.user.setActivity('');
      log.info('Status cleared');
    }
    // Persist for restart recovery
    await saveDiscordStatus(text);
  }

  getDmPolicy(): string {
    return this.config.dmPolicy || 'pairing';
  }

  getFormatterHints() {
    return {
      supportsReactions: true,
      supportsFiles: true,
      formatHint: 'Discord markdown: **bold** *italic* `code` [links](url) ```code blocks``` — supports headers',
    };
  }

  supportsEditing(): boolean {
    return this.config.streaming ?? false;
  }

  private async handleReactionEvent(
    reaction: import('discord.js').MessageReaction | import('discord.js').PartialMessageReaction,
    user: import('discord.js').User | import('discord.js').PartialUser,
    action: InboundReaction['action']
  ): Promise<void> {
    if ('bot' in user && user.bot) return;

    try {
      if (reaction.partial) {
        await reaction.fetch();
      }
      if (reaction.message.partial) {
        await reaction.message.fetch();
      }
    } catch (err) {
      log.warn('Failed to fetch reaction/message:', err);
    }

    const message = reaction.message;
    const channelId = message.channel?.id;
    if (!channelId) return;

    // Exclusion list check for reactions
    if (this.config.excludeChannels?.length) {
      const guildId = message.guildId;
      if (this.config.excludeChannels.includes(channelId) || (guildId && this.config.excludeChannels.includes(guildId))) {
        return;
      }
    }

    const access = await this.checkAccess(user.id);
    if (access !== 'allowed') {
      return;
    }

    const emoji = reaction.emoji.id
      ? reaction.emoji.toString()
      : (reaction.emoji.name || reaction.emoji.toString());
    if (!emoji) return;

    const isGroup = !!message.guildId;
    const groupName = isGroup && 'name' in message.channel
      ? message.channel.name || undefined
      : undefined;
    const userId = user.id;
    const userName = 'username' in user ? (user.username ?? undefined) : undefined;
    const displayName = message.guild?.members.cache.get(userId)?.displayName
      || userName
      || userId;

    this.onMessage?.({
      channel: 'discord',
      chatId: channelId,
      userId: userId,
      userName: displayName,
      userHandle: userName || userId,
      messageId: message.id,
      text: '',
      timestamp: new Date(),
      isGroup,
      groupName,
      serverId: message.guildId || undefined,
      reaction: {
        emoji,
        messageId: message.id,
        action,
      },
      formatterHints: this.getFormatterHints(),
    }).catch((err) => {
      log.error('Error handling reaction:', err);
    });
  }

  private async handleMemberEvent(
    member: import('discord.js').GuildMember | import('discord.js').PartialGuildMember,
    eventType: 'member_join' | 'member_leave'
  ): Promise<void> {
    const guild = member.guild;
    const guildId = guild.id;

    // Check exclusion list
    if (this.config.excludeChannels?.includes(guildId)) return;

    // Determine the target channel for this event
    const welcomeChannelId = this.config.welcomeChannel
      || guild.systemChannelId;

    if (!welcomeChannelId) {
      log.warn(`Member ${eventType} in ${guild.name} but no welcome channel configured and no system channel available`);
      return;
    }

    // Check that the welcome channel passes group-mode gating
    if (this.config.groups) {
      const keys = [welcomeChannelId, guildId];
      if (!isGroupAllowed(this.config.groups, keys)) {
        log.info(`Member ${eventType} in ${guild.name}: welcome channel ${welcomeChannelId} not in group allowlist, ignoring`);
        return;
      }
    }

    // Check exclusion for the welcome channel too
    if (this.config.excludeChannels?.includes(welcomeChannelId)) return;

    const userId = member.id;
    const displayName = ('displayName' in member ? member.displayName : null)
      || member.user?.globalName
      || member.user?.username
      || userId;
    const username = member.user?.username || userId;
    const action = eventType === 'member_join' ? 'joined' : 'left';

    const text = `[System: Member ${action}]\nUser: ${username} (${displayName})\nServer: ${guild.name}`;

    log.info(`Member ${eventType}: ${username} (${displayName}) in ${guild.name}`);

    this.onMessage?.({
      channel: 'discord',
      chatId: welcomeChannelId,
      userId,
      userName: displayName,
      userHandle: username,
      text,
      timestamp: new Date(),
      isGroup: true,
      groupName: guild.name,
      serverId: guildId,
      event: {
        type: eventType,
        userId,
        userName: displayName,
        serverName: guild.name,
      },
      formatterHints: this.getFormatterHints(),
    }).catch((err) => {
      log.error(`Error handling member ${eventType}:`, err);
    });
  }

  private async collectAttachments(attachments: unknown, channelId: string): Promise<InboundAttachment[]> {
    if (!attachments || typeof attachments !== 'object') return [];
    const list = Array.from((attachments as { values: () => Iterable<DiscordAttachment> }).values?.() || []);
    if (list.length === 0) return [];
    const results: InboundAttachment[] = [];
    for (const attachment of list) {
      const name = attachment.name || attachment.id || 'attachment';
      const entry: InboundAttachment = {
        id: attachment.id,
        name,
        mimeType: attachment.contentType || undefined,
        size: attachment.size,
        kind: attachment.contentType?.startsWith('image/') ? 'image' : 'file',
        url: attachment.url,
      };
      if (this.attachmentsDir && attachment.url) {
        if (this.attachmentsMaxBytes === 0) {
          results.push(entry);
          continue;
        }
        if (this.attachmentsMaxBytes && attachment.size && attachment.size > this.attachmentsMaxBytes) {
          log.warn(`Attachment ${name} exceeds size limit, skipping download.`);
          results.push(entry);
          continue;
        }
        const target = buildAttachmentPath(this.attachmentsDir, 'discord', channelId, name);
        try {
          await downloadToFile(attachment.url, target);
          entry.localPath = target;
          log.info(`Attachment saved to ${target}`);
        } catch (err) {
          log.warn('Failed to download attachment:', err);
        }
      }
      results.push(entry);
    }
    return results;
  }
}

// ── Status Persistence ───────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import { join as pathJoin, dirname } from 'node:path';

const STATUS_FILE = pathJoin(process.cwd(), 'data', 'bot-status.json');

async function saveDiscordStatus(text: string | null): Promise<void> {
  try {
    await fs.mkdir(dirname(STATUS_FILE), { recursive: true });
    if (text) {
      await fs.writeFile(STATUS_FILE, JSON.stringify({ message: text, timestamp: Date.now() }, null, 2));
    } else {
      await fs.unlink(STATUS_FILE).catch(() => {});
    }
  } catch (err) {
    log.warn('Failed to save status:', err);
  }
}

async function loadDiscordStatus(): Promise<string | null> {
  try {
    const data = await fs.readFile(STATUS_FILE, 'utf-8');
    const parsed = JSON.parse(data) as { message?: string };
    return parsed.message || null;
  } catch {
    return null;
  }
}

// ── Emoji Helpers ────────────────────────────────────────────────────────────

const DISCORD_EMOJI_ALIAS_TO_UNICODE: Record<string, string> = {
  eyes: '\u{1F440}',
  thumbsup: '\u{1F44D}',
  thumbs_up: '\u{1F44D}',
  '+1': '\u{1F44D}',
  heart: '\u2764\uFE0F',
  fire: '\u{1F525}',
  smile: '\u{1F604}',
  laughing: '\u{1F606}',
  tada: '\u{1F389}',
  clap: '\u{1F44F}',
  ok_hand: '\u{1F44C}',
  white_check_mark: '\u2705',
};

/**
 * Resolve a Discord emoji string for use with message.react().
 * 
 * Handles:
 * - Text aliases: "thumbsup", ":eyes:" → Unicode
 * - Custom emoji: "<:name:id>" or "<a:name:id>" → "name:id" (for discord.js react)
 * - Unicode emoji: passed through as-is
 * - Plain name: if no match, passed through (guild lookup happens in addReaction)
 */
function resolveDiscordEmoji(input: string): string {
  // Custom emoji format: <:name:id> or <a:name:id> (animated)
  const customMatch = input.match(/^<(a?):([^:]+):(\d+)>$/);
  if (customMatch) {
    const [, animated, name, id] = customMatch;
    // discord.js react() wants "name:id" or "a:name:id" for animated
    return animated ? `a:${name}:${id}` : `${name}:${id}`;
  }

  // Colon-wrapped alias: ":eyes:" → look up
  const aliasMatch = input.match(/^:([^:]+):$/);
  const alias = aliasMatch ? aliasMatch[1] : null;
  if (alias && DISCORD_EMOJI_ALIAS_TO_UNICODE[alias]) {
    return DISCORD_EMOJI_ALIAS_TO_UNICODE[alias];
  }

  // Bare alias: "thumbsup" → look up
  if (DISCORD_EMOJI_ALIAS_TO_UNICODE[input]) {
    return DISCORD_EMOJI_ALIAS_TO_UNICODE[input];
  }

  // Otherwise pass through (could be a Unicode emoji or a custom emoji name for guild lookup)
  return input;
}

// Discord limits
const DISCORD_MAX_LENGTH = 2000;
const DISCORD_STATUS_MAX_LENGTH = 128;
// Leave some headroom when choosing split points
const DISCORD_SPLIT_THRESHOLD = 1900;

/**
 * Split text into chunks that fit within Discord's 2000-char limit.
 * Splits at paragraph boundaries (double newlines), falling back to
 * single newlines, then hard-splitting at the threshold.
 */
function splitMessageText(text: string): string[] {
  if (text.length <= DISCORD_SPLIT_THRESHOLD) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > DISCORD_SPLIT_THRESHOLD) {
    let splitIdx = -1;

    const searchRegion = remaining.slice(0, DISCORD_SPLIT_THRESHOLD);
    // Try paragraph boundary (double newline)
    const lastParagraph = searchRegion.lastIndexOf('\n\n');
    if (lastParagraph > DISCORD_SPLIT_THRESHOLD * 0.3) {
      splitIdx = lastParagraph;
    }

    // Fall back to single newline
    if (splitIdx === -1) {
      const lastNewline = searchRegion.lastIndexOf('\n');
      if (lastNewline > DISCORD_SPLIT_THRESHOLD * 0.3) {
        splitIdx = lastNewline;
      }
    }

    // Hard split as last resort
    if (splitIdx === -1) {
      splitIdx = DISCORD_SPLIT_THRESHOLD;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }

  return chunks;
}

type DiscordAttachment = {
  id?: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  url?: string;
};
