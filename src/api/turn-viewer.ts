/**
 * Turn viewer SSE infrastructure.
 *
 * Watches turn log files (JSONL) for changes and streams updates to connected
 * SSE clients. Used by the /turns endpoint to provide a live view of agent
 * activity in the admin portal.
 */

import * as http from 'http';
import * as fs from 'fs';
import { readFile } from 'node:fs/promises';

interface SSEClient {
  res: http.ServerResponse;
  sentCount: number;
  lastTurnId?: string;
}

/**
 * Manages SSE clients and file watchers for turn log files.
 *
 * One instance per server. Tracks clients per agent name and watches the
 * underlying JSONL files for changes, broadcasting deltas as they appear.
 */
export class TurnViewer {
  private readonly sseClientsByAgent = new Map<string, Set<SSEClient>>();
  private readonly broadcastQueues = new Map<string, Promise<void>>();
  private readonly watchers = new Map<string, fs.FSWatcher>();

  constructor(turnLogFiles?: Record<string, string>) {
    if (turnLogFiles) {
      for (const agentName of Object.keys(turnLogFiles)) {
        this.sseClientsByAgent.set(agentName, new Set());
      }
    }
  }

  /** Read all turns from a JSONL file. Returns empty array if file is missing or unreadable. */
  async readTurns(filePath: string): Promise<unknown[]> {
    try {
      const content = await readFile(filePath, 'utf8');
      return content.split('\n').filter(l => l.trim()).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  /** Register a new SSE client for an agent. Returns a function to unregister it. */
  addClient(agentName: string, filePath: string, res: http.ServerResponse, initialTurns: unknown[]): () => void {
    const clients = this.sseClientsByAgent.get(agentName);
    if (!clients) {
      throw new Error(`Unknown agent: ${agentName}`);
    }
    const client: SSEClient = {
      res,
      sentCount: initialTurns.length,
      lastTurnId: getTurnId(initialTurns[initialTurns.length - 1]),
    };
    clients.add(client);
    this.ensureWatching(agentName, filePath);
    return () => {
      clients.delete(client);
      this.maybeUnwatch(filePath, clients);
    };
  }

  /** Whether the viewer knows about the given agent (i.e. has a turn log configured). */
  hasAgent(agentName: string): boolean {
    return this.sseClientsByAgent.has(agentName);
  }

  // ── Internal: broadcast / watch lifecycle ───────────────────────────────────

  private async broadcastNewTurns(agentName: string, filePath: string): Promise<void> {
    const clients = this.sseClientsByAgent.get(agentName);
    if (!clients || clients.size === 0) return;
    const allTurns = await this.readTurns(filePath);
    const currentLastTurnId = getTurnId(allTurns[allTurns.length - 1]);

    for (const client of clients) {
      // If the log was cleared, reset the client snapshot and UI.
      if (allTurns.length === 0) {
        const shouldReset = client.sentCount !== 0 || !!client.lastTurnId;
        client.sentCount = 0;
        client.lastTurnId = undefined;
        if (shouldReset) {
          const payload = `data: ${JSON.stringify({ type: 'init', turns: [] })}\n\n`;
          try { client.res.write(payload); } catch { clients.delete(client); }
        }
        continue;
      }

      if (client.lastTurnId === currentLastTurnId && client.sentCount === allTurns.length) {
        continue;
      }

      let turnsToAppend: unknown[] | null = null;
      if (client.lastTurnId) {
        let previousIndex = -1;
        for (let i = allTurns.length - 1; i >= 0; i--) {
          if (getTurnId(allTurns[i]) === client.lastTurnId) {
            previousIndex = i;
            break;
          }
        }
        if (previousIndex >= 0) {
          turnsToAppend = allTurns.slice(previousIndex + 1);
        }
      } else if (client.sentCount < allTurns.length) {
        // Fallback for older records without turnId.
        turnsToAppend = allTurns.slice(client.sentCount);
      }

      const appendTurns = turnsToAppend ?? [];
      const shouldResync = turnsToAppend === null
        || (appendTurns.length === 0 && (client.sentCount !== allTurns.length || client.lastTurnId !== currentLastTurnId));

      const payload = shouldResync
        ? `data: ${JSON.stringify({ type: 'init', turns: allTurns })}\n\n`
        : appendTurns.length > 0
          ? `data: ${JSON.stringify({ type: 'append', turns: appendTurns })}\n\n`
          : null;

      if (payload) {
        try {
          client.res.write(payload);
        } catch {
          clients.delete(client);
          continue;
        }
      }

      client.sentCount = allTurns.length;
      client.lastTurnId = currentLastTurnId;
    }
  }

  private enqueueBroadcast(agentName: string, filePath: string): void {
    const prev = this.broadcastQueues.get(filePath) ?? Promise.resolve();
    const next = prev.then(() => this.broadcastNewTurns(agentName, filePath)).catch(() => {});
    this.broadcastQueues.set(filePath, next);
  }

  private ensureWatching(agentName: string, filePath: string): void {
    if (this.watchers.has(filePath)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
        if (eventType === 'rename') {
          // Inode replaced (trim via atomic rename on Linux). Restart watcher.
          watcher.close();
          this.watchers.delete(filePath);
          setTimeout(() => {
            const clients = this.sseClientsByAgent.get(agentName);
            if (clients && clients.size > 0) {
              this.enqueueBroadcast(agentName, filePath);
              this.ensureWatching(agentName, filePath);
            }
          }, 200);
          return;
        }
        this.enqueueBroadcast(agentName, filePath);
      });
    } catch {
      setTimeout(() => {
        const clients = this.sseClientsByAgent.get(agentName);
        if (clients && clients.size > 0) this.ensureWatching(agentName, filePath);
      }, 2000);
      return;
    }
    watcher.on('error', () => {
      watcher.close();
      this.watchers.delete(filePath);
      // Auto-restart watcher after trim (inode replacement on Linux)
      setTimeout(() => {
        const clients = this.sseClientsByAgent.get(agentName);
        if (clients && clients.size > 0) this.ensureWatching(agentName, filePath);
      }, 500);
    });
    this.watchers.set(filePath, watcher);
  }

  private maybeUnwatch(filePath: string, clients: Set<SSEClient>): void {
    if (clients.size === 0 && this.watchers.has(filePath)) {
      this.watchers.get(filePath)!.close();
      this.watchers.delete(filePath);
      this.broadcastQueues.delete(filePath);
    }
  }
}

function getTurnId(turn: unknown): string | undefined {
  if (!turn || typeof turn !== 'object') return undefined;
  const id = (turn as { turnId?: unknown }).turnId;
  return typeof id === 'string' && id.trim() ? id : undefined;
}
