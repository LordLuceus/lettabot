import { existsSync, readFileSync, promises as fs } from 'node:fs';
import { sleep } from '../utils/time.js';
import { createLogger } from '../logger.js';

const log = createLogger('Config');

const DISCOVERY_LOCK_TIMEOUT_MS = 15_000;
const DISCOVERY_LOCK_STALE_MS = 60_000;
const DISCOVERY_LOCK_RETRY_MS = 100;

function warnServerMismatch(storedUrl: string, currentUrl: string, agentId: string): void {
  if (storedUrl === currentUrl) return;
  log.warn('⚠️  Server mismatch detected!');
  log.warn(`   Stored agent was created on: ${storedUrl}`);
  log.warn(`   Current server: ${currentUrl}`);
  log.warn(`   The agent ${agentId} may not exist on this server.`);
  log.warn(`   Run 'lettabot onboard' to select or create an agent for this server.`);
}

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * Best-effort load of stored agent ID into LETTA_AGENT_ID.
 * Handles both v1 and v2 store shapes and warns on base URL mismatch.
 */
export function loadStoredAgentId(storePath: string, currentBaseUrl: string): void {
  if (!existsSync(storePath)) return;

  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as {
      version?: number;
      agentId?: string;
      baseUrl?: string;
      agents?: Record<string, { agentId?: string; baseUrl?: string }>;
    };

    // V2 format
    if (raw.version === 2 && raw.agents) {
      const firstAgent = Object.values(raw.agents)[0];
      if (!firstAgent?.agentId) return;
      process.env.LETTA_AGENT_ID = firstAgent.agentId;
      if (!firstAgent.baseUrl) return;
      warnServerMismatch(
        normalizeUrl(firstAgent.baseUrl),
        normalizeUrl(currentBaseUrl),
        firstAgent.agentId,
      );
      return;
    }

    // V1 format (legacy)
    if (!raw.agentId) return;
    process.env.LETTA_AGENT_ID = raw.agentId;
    if (!raw.baseUrl) return;
    warnServerMismatch(
      normalizeUrl(raw.baseUrl),
      normalizeUrl(currentBaseUrl),
      raw.agentId,
    );
  } catch {
    // Best-effort load; ignore malformed store files.
  }
}

function getDiscoveryLockPath(storePath: string, agentName: string): string {
  const safe = agentName
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'agent';
  return `${storePath}.${safe}.discover.lock`;
}

/**
 * Inter-process lock to avoid startup races when discovering agents by name.
 */
export async function withDiscoveryLock<T>(
  storePath: string,
  agentName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = getDiscoveryLockPath(storePath, agentName);
  const start = Date.now();

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid}\n`, { encoding: 'utf-8' });
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }

      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > DISCOVERY_LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // Best-effort stale lock cleanup.
      }

      if (Date.now() - start >= DISCOVERY_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for startup discovery lock: ${lockPath}`);
      }
      await sleep(DISCOVERY_LOCK_RETRY_MS);
    }
  }
}
