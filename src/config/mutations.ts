/**
 * Config mutation utilities — masking, merging, restart detection.
 *
 * Used by the config API endpoints to:
 *   - Mask sensitive fields when reading config (so secrets aren't exposed)
 *   - Deep-merge partial config updates (preserving masked values)
 *   - Detect when changes require a process restart
 */

import type { LettaBotConfig } from './types.js';

/** Marker placeholder shown in API responses for sensitive fields. */
export const SENSITIVE_MARKER = '••••••';

/** Paths to mask in config responses (dot-notation). */
export const SENSITIVE_PATHS = [
  'server.apiKey',
  'channels.telegram.token',
  'channels.discord.token',
  'channels.slack.botToken',
  'channels.slack.appToken',
  'channels.signal.phone',
  'transcription.apiKey',
  'tts.apiKey',
];

/** Mask sensitive fields, replacing values with a marker + isSet flag. */
export function maskSensitiveFields(config: LettaBotConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config));

  for (const dotPath of SENSITIVE_PATHS) {
    maskPath(clone, dotPath.split('.'));
  }

  // Also mask tokens in agents[] array
  if (Array.isArray(clone.agents)) {
    for (const agent of clone.agents) {
      if (agent.channels) {
        for (const chKey of Object.keys(agent.channels)) {
          const ch = agent.channels[chKey];
          if (!ch || typeof ch !== 'object') continue;
          for (const field of ['token', 'botToken', 'appToken', 'appPassword', 'apiKey', 'apiHash']) {
            if (ch[field] && typeof ch[field] === 'string') {
              ch[field] = SENSITIVE_MARKER;
              ch[field + '_isSet'] = true;
            }
          }
        }
      }
    }
  }

  // Mask provider API keys
  if (Array.isArray(clone.providers)) {
    for (const p of clone.providers) {
      if (p.apiKey) { p.apiKey = SENSITIVE_MARKER; p.apiKey_isSet = true; }
    }
  }

  return clone;
}

function maskPath(obj: Record<string, any>, parts: string[]): void {
  const [head, ...rest] = parts;
  if (!obj || typeof obj !== 'object' || !(head in obj)) return;
  if (rest.length === 0) {
    if (obj[head] && typeof obj[head] === 'string') {
      obj[head] = SENSITIVE_MARKER;
      obj[head + '_isSet'] = true;
    }
  } else {
    maskPath(obj[head], rest);
  }
}

/** Deep-merge partial config into current config. Null values remove keys. */
export function deepMergeConfig(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    // Skip masked sensitive values (don't overwrite real token with marker)
    if (val === SENSITIVE_MARKER) continue;
    // Null means delete
    if (val === null) {
      delete result[key];
      continue;
    }
    // Deep-merge arrays element-by-element (e.g. agents[])
    if (Array.isArray(val) && Array.isArray(target[key])) {
      result[key] = target[key].map((item: any, i: number) => {
        if (i < val.length && val[i] != null && typeof val[i] === 'object' && typeof item === 'object') {
          return deepMergeConfig(item, val[i]);
        }
        return item;
      });
      // Append new elements if source array is longer
      for (let i = target[key].length; i < val.length; i++) {
        result[key].push(val[i]);
      }
    // Deep-merge plain objects
    } else if (val && typeof val === 'object' && !Array.isArray(val) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMergeConfig(target[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/** Check if structural fields changed (requiring restart). */
export function needsRestart(prev: LettaBotConfig, next: LettaBotConfig): boolean {
  if (prev.server.mode !== next.server.mode) return true;
  if (prev.server.baseUrl !== next.server.baseUrl) return true;
  if (prev.server.apiKey !== next.server.apiKey) return true;
  if (JSON.stringify(prev.channels) !== JSON.stringify(next.channels)) return true;
  if (JSON.stringify(prev.agents) !== JSON.stringify(next.agents)) return true;
  return false;
}
