/**
 * Discord Voice Connection Manager
 *
 * Manages voice channel connections using @discordjs/voice.
 * Phase 1: Playback only (selfDeaf: true, no audio receive).
 * DAVE E2EE is handled by @snazzah/davey (auto-detected by @discordjs/voice).
 */

import { createLogger } from '../logger.js';

const log = createLogger('Voice');

// Dynamic imports — voice deps are optional
let joinVoiceChannel: typeof import('@discordjs/voice').joinVoiceChannel;
let getVoiceConnection: typeof import('@discordjs/voice').getVoiceConnection;
let VoiceConnectionStatus: typeof import('@discordjs/voice').VoiceConnectionStatus;
let entersState: typeof import('@discordjs/voice').entersState;
let createAudioPlayer: typeof import('@discordjs/voice').createAudioPlayer;
let createAudioResource: typeof import('@discordjs/voice').createAudioResource;
let AudioPlayerStatus: typeof import('@discordjs/voice').AudioPlayerStatus;
let StreamType: typeof import('@discordjs/voice').StreamType;

let voiceLoaded = false;

async function loadVoiceDeps(): Promise<boolean> {
  if (voiceLoaded) return true;
  try {
    const voice = await import('@discordjs/voice');
    joinVoiceChannel = voice.joinVoiceChannel;
    getVoiceConnection = voice.getVoiceConnection;
    VoiceConnectionStatus = voice.VoiceConnectionStatus;
    entersState = voice.entersState;
    createAudioPlayer = voice.createAudioPlayer;
    createAudioResource = voice.createAudioResource;
    AudioPlayerStatus = voice.AudioPlayerStatus;
    StreamType = voice.StreamType;
    voiceLoaded = true;
    return true;
  } catch {
    log.warn('Voice support unavailable: @discordjs/voice not installed');
    return false;
  }
}

export interface VoiceSessionInfo {
  guildId: string;
  channelId: string;
  connection: ReturnType<typeof joinVoiceChannel>;
  player: ReturnType<typeof createAudioPlayer>;
}

/** Active voice sessions keyed by guild ID */
const sessions = new Map<string, VoiceSessionInfo>();

/**
 * Check whether voice dependencies are available at runtime.
 */
export async function isVoiceAvailable(): Promise<boolean> {
  return loadVoiceDeps();
}

/**
 * Join a Discord voice channel.
 *
 * @param channelId - The voice channel ID to join
 * @param guildId - The guild (server) ID containing the channel
 * @param adapterCreator - The guild's voice adapter creator from discord.js
 * @returns The voice session info, or null on failure
 */
export async function joinChannel(
  channelId: string,
  guildId: string,
  adapterCreator: Parameters<typeof joinVoiceChannel>[0]['adapterCreator'],
): Promise<VoiceSessionInfo | null> {
  if (!(await loadVoiceDeps())) return null;

  // If already connected to this guild, destroy first
  const existing = sessions.get(guildId);
  if (existing) {
    if (existing.channelId === channelId) {
      log.info(`Already connected to voice channel ${channelId} in guild ${guildId}`);
      return existing;
    }
    log.info(`Switching voice channel in guild ${guildId}: ${existing.channelId} → ${channelId}`);
    existing.connection.destroy();
    sessions.delete(guildId);
  }

  try {
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: true,   // Phase 1: don't receive audio
      selfMute: false,  // We want to send audio (TTS)
    });

    const player = createAudioPlayer();
    // Default error handler prevents unhandled 'error' events from crashing the process.
    // Per-playback error handling in player.ts provides more context.
    player.on('error', (err) => {
      log.warn(`AudioPlayer error in guild ${guildId}: ${err.message}`);
    });
    connection.subscribe(player);

    // Wait for the connection to be ready (up to 30s)
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

    const session: VoiceSessionInfo = { guildId, channelId, connection, player };
    sessions.set(guildId, session);

    log.info(`Joined voice channel ${channelId} in guild ${guildId}`);

    // Handle disconnection
    connection.on('stateChange', (_oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        log.warn(`Voice disconnected in guild ${guildId}, attempting reconnect...`);
        try {
          // Try to reconnect
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
            .catch(() => {
              log.warn(`Voice reconnect failed in guild ${guildId}, cleaning up`);
              connection.destroy();
              sessions.delete(guildId);
            });
        } catch {
          connection.destroy();
          sessions.delete(guildId);
        }
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        sessions.delete(guildId);
        log.info(`Voice session destroyed in guild ${guildId}`);
      }
    });

    return session;
  } catch (err) {
    log.error(`Failed to join voice channel ${channelId}:`, err instanceof Error ? err.message : err);
    // Clean up on failure
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
    sessions.delete(guildId);
    return null;
  }
}

/**
 * Leave a voice channel in a guild.
 */
export function leaveChannel(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.player.stop();
  session.connection.destroy();
  sessions.delete(guildId);
  log.info(`Left voice channel ${session.channelId} in guild ${guildId}`);
  return true;
}

/**
 * Get the active voice session for a guild.
 */
export function getSession(guildId: string): VoiceSessionInfo | undefined {
  return sessions.get(guildId);
}

/**
 * Get all active voice sessions.
 */
export function getAllSessions(): Map<string, VoiceSessionInfo> {
  return sessions;
}

/**
 * Destroy all voice sessions (for shutdown).
 */
export function destroyAll(): void {
  for (const [guildId, session] of sessions) {
    try {
      session.player.stop();
      session.connection.destroy();
    } catch {
      // Ignore cleanup errors
    }
    sessions.delete(guildId);
  }
  log.info('All voice sessions destroyed');
}
