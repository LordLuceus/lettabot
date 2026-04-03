/**
 * Voice Audio Player
 *
 * Plays audio files (TTS output) through the Discord voice connection.
 * Supports OGG/Opus, MP3, and other formats via @discordjs/voice's AudioResource.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createLogger } from '../logger.js';
import { getSession, type VoiceSessionInfo } from './connection.js';

const log = createLogger('VoicePlayer');

// Dynamic imports
let createAudioResource: typeof import('@discordjs/voice').createAudioResource;
let AudioPlayerStatus: typeof import('@discordjs/voice').AudioPlayerStatus;
let entersState: typeof import('@discordjs/voice').entersState;

let playerLoaded = false;

async function loadPlayerDeps(): Promise<boolean> {
  if (playerLoaded) return true;
  try {
    const voice = await import('@discordjs/voice');
    createAudioResource = voice.createAudioResource;
    AudioPlayerStatus = voice.AudioPlayerStatus;
    entersState = voice.entersState;
    playerLoaded = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Play an audio file in a guild's voice channel.
 *
 * @param guildId - The guild where the bot is connected to voice
 * @param filePath - Path to the audio file (OGG, MP3, WAV, etc.)
 * @param options - Optional settings
 * @returns true if playback started, false if not possible
 */
export async function playAudioFile(
  guildId: string,
  filePath: string,
  options?: { waitForCompletion?: boolean },
): Promise<boolean> {
  if (!(await loadPlayerDeps())) {
    log.warn('Cannot play audio: @discordjs/voice not available');
    return false;
  }

  const session = getSession(guildId);
  if (!session) {
    log.warn(`Cannot play audio: not connected to voice in guild ${guildId}`);
    return false;
  }

  // Verify file exists
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      log.warn(`Cannot play audio: not a file: ${filePath}`);
      return false;
    }
    log.info(`Playing audio file ${filePath} (${stats.size} bytes) in guild ${guildId}`);
  } catch {
    log.warn(`Cannot play audio: file not found: ${filePath}`);
    return false;
  }

  const resource = createAudioResource(createReadStream(filePath));
  session.player.play(resource);

  if (options?.waitForCompletion) {
    try {
      await entersState(session.player, AudioPlayerStatus.Idle, 120_000);
    } catch {
      log.warn('Audio playback timed out after 120s');
    }
  }

  return true;
}

/**
 * Check whether the bot is currently playing audio in a guild.
 */
export async function isPlaying(guildId: string): Promise<boolean> {
  if (!(await loadPlayerDeps())) return false;
  const session = getSession(guildId);
  if (!session) return false;
  return session.player.state.status === AudioPlayerStatus.Playing;
}

/**
 * Stop current audio playback in a guild.
 */
export function stopPlayback(guildId: string): boolean {
  const session = getSession(guildId);
  if (!session) return false;
  session.player.stop();
  return true;
}
