/**
 * Path utilities for persistent data storage
 * 
 * On Railway with a volume attached, RAILWAY_VOLUME_MOUNT_PATH is automatically set.
 * We use this to store all persistent data in the volume.
 * 
 * Priority:
 * 1. RAILWAY_VOLUME_MOUNT_PATH (Railway with volume)
 * 2. DATA_DIR env var (custom path)
 * 3. process.cwd() (default - local development)
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Resolve a working directory path into an absolute path.
 * Supports `~` for home directory and normalizes relative paths.
 */
export function resolveWorkingDirPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/tmp/lettabot';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(join(homedir(), trimmed.slice(2)));
  }
  return resolve(trimmed);
}

/**
 * Get the base directory for persistent data storage.
 * 
 * On Railway with a volume, this returns the volume mount path.
 * Locally, this returns the current working directory.
 */
export function getDataDir(): string {
  // Railway volume takes precedence
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return process.env.RAILWAY_VOLUME_MOUNT_PATH;
  }
  
  // Custom data directory
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }
  
  // Default to current working directory
  return process.cwd();
}

/**
 * Get the working directory for runtime data (attachments, skills, etc.)
 * 
 * On Railway with a volume, this returns {volume}/data
 * Otherwise uses WORKING_DIR env var or /tmp/lettabot
 */
export function getWorkingDir(configWorkingDir?: string): string {
  // Explicit WORKING_DIR env var always wins
  if (process.env.WORKING_DIR) {
    return resolveWorkingDirPath(process.env.WORKING_DIR);
  }
  
  // On Railway with volume, use volume/data subdirectory
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data');
  }

  // YAML config workingDir
  if (configWorkingDir) {
    return resolveWorkingDirPath(configWorkingDir);
  }
  
  // Default for local development
  return '/tmp/lettabot';
}

/**
 * Get the canonical directory for cron state (cron-jobs.json / cron-log.jsonl).
 *
 * This is intentionally deterministic across server and CLI contexts, and does
 * not depend on process.cwd().
 *
 * Priority:
 * 1. RAILWAY_VOLUME_MOUNT_PATH (Railway persistent volume)
 * 2. DATA_DIR (explicit persistent data override)
 * 3. WORKING_DIR (runtime workspace)
 * 4. /tmp/lettabot (deterministic local fallback)
 */
export function getCronDataDir(): string {
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return process.env.RAILWAY_VOLUME_MOUNT_PATH;
  }

  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }

  if (process.env.WORKING_DIR) {
    return resolveWorkingDirPath(process.env.WORKING_DIR);
  }

  return '/tmp/lettabot';
}

/**
 * Canonical cron store path.
 */
export function getCronStorePath(): string {
  return resolve(getCronDataDir(), 'cron-jobs.json');
}

/**
 * Canonical cron log path.
 */
export function getCronLogPath(): string {
  return resolve(getCronDataDir(), 'cron-log.jsonl');
}

/**
 * Legacy cron store path (used before deterministic cron path resolution).
 * Kept for migration of existing local files.
 */
export function getLegacyCronStorePath(): string {
  return resolve(getDataDir(), 'cron-jobs.json');
}

/**
 * Canonical bot-status.json path.
 *
 * The Discord adapter writes `bot-status.json` to persist the current custom
 * status across restarts and polls it for changes coming from the
 * `lettabot-status` CLI. The CLI and the bot server are separate processes
 * with potentially different `process.cwd()`, so the path needs to be
 * deterministic across both contexts.
 *
 * Priority (mirrors getCronDataDir, with an explicit workingDir fallback for
 * CLI tools that have loaded the YAML config but haven't been started by the
 * server entrypoint that exports WORKING_DIR):
 *
 * 1. RAILWAY_VOLUME_MOUNT_PATH (Railway persistent volume)
 * 2. DATA_DIR (explicit persistent data override)
 * 3. WORKING_DIR env var (set by main.ts at server startup)
 * 4. Caller-provided workingDir (e.g. CLI-loaded YAML agent.workingDir)
 * 5. /tmp/lettabot (deterministic local fallback, matches resolveWorkingDirPath)
 */
export function getBotStatusFilePath(workingDir?: string): string {
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'bot-status.json');
  }

  if (process.env.DATA_DIR) {
    return resolve(process.env.DATA_DIR, 'bot-status.json');
  }

  if (process.env.WORKING_DIR) {
    return resolve(resolveWorkingDirPath(process.env.WORKING_DIR), 'bot-status.json');
  }

  if (workingDir) {
    return resolve(resolveWorkingDirPath(workingDir), 'bot-status.json');
  }

  return resolve('/tmp/lettabot', 'bot-status.json');
}

/**
 * Canonical bio-request.json path.
 *
 * Used as a one-shot IPC channel from the `lettabot-bio` CLI to the running
 * bot: the CLI drops a JSON file here, the Discord adapter polls for it,
 * applies the change to the bot's Discord application description, and
 * deletes the file. Unlike bot-status.json, this file is NOT persistent
 * state — the bio itself lives on Discord's servers.
 *
 * Same resolution chain as getBotStatusFilePath() so the CLI and the bot
 * agree regardless of process.cwd() differences.
 */
export function getBioRequestFilePath(workingDir?: string): string {
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'bio-request.json');
  }

  if (process.env.DATA_DIR) {
    return resolve(process.env.DATA_DIR, 'bio-request.json');
  }

  if (process.env.WORKING_DIR) {
    return resolve(resolveWorkingDirPath(process.env.WORKING_DIR), 'bio-request.json');
  }

  if (workingDir) {
    return resolve(resolveWorkingDirPath(workingDir), 'bio-request.json');
  }

  return resolve('/tmp/lettabot', 'bio-request.json');
}

/**
 * Check if running on Railway
 */
export function isRailway(): boolean {
  return !!process.env.RAILWAY_ENVIRONMENT;
}

/**
 * Check if a Railway volume is mounted
 */
export function hasRailwayVolume(): boolean {
  return !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
}
