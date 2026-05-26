/**
 * Startup banner with LETTABOT block text and runtime status lines.
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Read version from package.json and git commit hash. */
function getVersionString(): string {
  let version = 'unknown';
  try {
    const pkg = require('../../package.json');
    version = pkg.version || version;
  } catch {}

  let commit = '';
  try {
    commit = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}

  return commit ? `v${version} (${commit})` : `v${version}`;
}

interface BannerAgent {
  name: string;
  agentId?: string | null;
  conversationId?: string | null;
  channels: string[];
  features?: {
    cron?: boolean;
    heartbeatIntervalMin?: number;
  };
}

const BLOCK_TEXT = `
░██         ░██████████ ░██████████ ░██████████   ░███    ░████████     ░██████   ░██████████
░██         ░██             ░██        ░██      ░██░██   ░██    ░██   ░██   ░██      ░██
░██         ░██             ░██        ░██     ░██  ░██  ░██    ░██  ░██     ░██     ░██
░██         ░█████████      ░██        ░██    ░█████████ ░████████   ░██     ░██     ░██
░██         ░██             ░██        ░██    ░██    ░██ ░██     ░██ ░██     ░██     ░██
░██         ░██             ░██        ░██    ░██    ░██ ░██     ░██  ░██   ░██      ░██
░██████████ ░██████████     ░██        ░██    ░██    ░██ ░█████████    ░██████       ░██
`.trim();

export function printStartupBanner(agents: BannerAgent[]): void {
  // Block text
  console.log('');
  console.log(BLOCK_TEXT);
  console.log('');

  // Status lines
  const versionStr = getVersionString();
  console.log(`  Version:  ${versionStr}`);
  for (const agent of agents) {
    const ch = agent.channels.length > 0 ? agent.channels.join(', ') : 'none';
    if (agent.agentId) {
      const qs = agent.conversationId ? `?conversation=${agent.conversationId}` : '';
      const url = `https://app.letta.com/agents/${agent.agentId}${qs}`;
      console.log(`  Agent:    ${agent.name} [${ch}]`);
      console.log(`  URL:      ${url}`);
    } else {
      console.log(`  Agent:    ${agent.name} (pending) [${ch}]`);
    }
  }

  const features: string[] = [];
  for (const agent of agents) {
    if (agent.features?.cron) features.push('cron');
    if (agent.features?.heartbeatIntervalMin) {
      features.push(`heartbeat (${agent.features.heartbeatIntervalMin}m)`);
    }
  }
  if (features.length > 0) {
    console.log(`  Features: ${features.join(', ')}`);
  }
  console.log('');
}
