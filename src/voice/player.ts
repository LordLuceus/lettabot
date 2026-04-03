/**
 * Voice Audio Player
 *
 * Plays audio files (TTS output) through the Discord voice connection.
 * Supports OGG/Opus, MP3, and other formats via @discordjs/voice's AudioResource.
 */

import { createReadStream, readSync, openSync, closeSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createLogger } from '../logger.js';
import { getSession, type VoiceSessionInfo } from './connection.js';

const log = createLogger('VoicePlayer');

// Dynamic imports
let createAudioResource: typeof import('@discordjs/voice').createAudioResource;
let AudioPlayerStatus: typeof import('@discordjs/voice').AudioPlayerStatus;
let StreamType: typeof import('@discordjs/voice').StreamType;
let entersState: typeof import('@discordjs/voice').entersState;

let playerLoaded = false;

async function loadPlayerDeps(): Promise<boolean> {
  if (playerLoaded) return true;
  try {
    const voice = await import('@discordjs/voice');
    createAudioResource = voice.createAudioResource;
    AudioPlayerStatus = voice.AudioPlayerStatus;
    StreamType = voice.StreamType;
    entersState = voice.entersState;
    playerLoaded = true;
    return true;
  } catch {
    return false;
  }
}

/** OGG files start with "OggS" magic bytes */
const OGG_MAGIC = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // "OggS"

/**
 * Read the first 4 bytes of a file to determine the actual audio format.
 * Returns StreamType.OggOpus if it's a real OGG container, otherwise Arbitrary.
 */
function detectStreamType(filePath: string): typeof StreamType.OggOpus | typeof StreamType.Arbitrary {
  try {
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    return buf.equals(OGG_MAGIC) ? StreamType.OggOpus : StreamType.Arbitrary;
  } catch {
    return StreamType.Arbitrary;
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

  // Detect actual format from magic bytes — don't trust the file extension.
  // ElevenLabs outputs real OGG/Opus, but OpenAI defaults to MP3 even with .ogg extension.
  const inputType = detectStreamType(filePath);
  log.info(`Audio format detected: ${inputType === StreamType.OggOpus ? 'OGG/Opus (native)' : 'arbitrary (needs FFmpeg)'}`);

  const resource = createAudioResource(createReadStream(filePath), { inputType });

  // Catch playback errors so they don't crash the process
  const playbackPromise = new Promise<boolean>((resolve) => {
    const onError = (err: Error) => {
      log.warn(`Audio playback error: ${err.message}`);
      cleanup();
      resolve(false);
    };
    const onIdle = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      session.player.removeListener('error', onError);
      session.player.removeListener(AudioPlayerStatus.Idle, onIdle);
    };

    session.player.on('error', onError);
    // Auto-resolve when playback finishes (even if not waiting for completion)
    session.player.once(AudioPlayerStatus.Idle, onIdle);

    // Timeout safety net
    setTimeout(() => {
      cleanup();
      resolve(false);
      log.warn('Audio playback timed out after 120s');
    }, 120_000);
  });

  session.player.play(resource);

  if (options?.waitForCompletion) {
    return playbackPromise;
  }

  // Even when not waiting, attach error handler so it doesn't crash
  playbackPromise.catch(() => {}); // Prevent unhandled rejection
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
