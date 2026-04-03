/**
 * Voice Module — Public API
 *
 * Phase 1: Half-duplex (playback only).
 * The bot joins Discord voice channels and plays TTS audio.
 * Audio receive (STT) is planned for Phase 2.
 */

export {
  isVoiceAvailable,
  joinChannel,
  leaveChannel,
  getSession,
  getAllSessions,
  destroyAll,
  type VoiceSessionInfo,
} from './connection.js';

export {
  playAudioFile,
  isPlaying,
  stopPlayback,
} from './player.js';
