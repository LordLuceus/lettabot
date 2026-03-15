/**
 * HTTP API server for LettaBot
 * Provides endpoints for CLI to send messages across Docker boundaries
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { readFile } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { validateApiKey } from './auth.js';
import type { SendMessageResponse, ChatRequest, ChatResponse, AsyncChatResponse, PairingListResponse, PairingApproveRequest, PairingApproveResponse } from './types.js';
import { listPairingRequests, approvePairingCode } from '../pairing/store.js';
import { parseMultipart } from './multipart.js';
import type { AgentRouter } from '../core/interfaces.js';
import type { ChannelId } from '../core/types.js';
import type { Store } from '../core/store.js';
import {
  generateCompletionId, extractLastUserMessage, buildCompletion,
  buildChunk, buildToolCallChunk, formatSSE, SSE_DONE,
  buildErrorResponse, buildModelList, validateChatRequest,
} from './openai-compat.js';
import type { OpenAIChatRequest } from './openai-compat.js';
import { getTurnViewerHtml } from '../core/turn-viewer.js';

import { createLogger } from '../logger.js';
import { loadConfigStrict, saveConfig, resolveConfigPath } from '../config/io.js';
import type { LettaBotConfig } from '../config/types.js';

const log = createLogger('API');
const VALID_CHANNELS: ChannelId[] = ['telegram', 'slack', 'discord', 'whatsapp', 'signal'];
const MAX_BODY_SIZE = 10 * 1024; // 10KB
const MAX_TEXT_LENGTH = 10000; // 10k chars
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const WEBHOOK_CONTEXT = { type: 'webhook' as const, outputMode: 'silent' as const };

// Portal static file serving
const PORTAL_DIR = new URL('../portal/', import.meta.url);
const PORTAL_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

function servePortalFile(res: http.ServerResponse, filePath: string): boolean {
  const ext = path.extname(filePath);
  const mime = PORTAL_MIME[ext];
  if (!mime) return false;

  // Resolve relative to portal dir, prevent traversal
  const resolved = new URL(filePath, PORTAL_DIR);
  if (!resolved.pathname.startsWith(new URL('.', PORTAL_DIR).pathname)) return false;

  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

type ResolvedChatRequest = {
  message: string;
  agentName: string | undefined;
  resolvedName: string;
};

interface ServerOptions {
  port: number;
  apiKey: string;
  host?: string;       // Bind address (default: 127.0.0.1 for security)
  corsOrigin?: string; // CORS origin (default: same-origin only)
  turnLogFiles?: Record<string, string>; // agentName -> filePath; enables GET /turns viewer
  stores?: Map<string, Store>; // Agent stores for management endpoints
  agentChannels?: Map<string, string[]>; // Channel IDs per agent name
  sessionInvalidators?: Map<string, (key?: string) => void>; // Invalidate live sessions after store writes
}

/**
 * Create and start the HTTP API server
 */
export function createApiServer(deliverer: AgentRouter, options: ServerOptions): http.Server {
  // ── Turn viewer SSE infrastructure ──────────────────────────────────────
  interface SSEClient {
    res: http.ServerResponse;
    sentCount: number;
    lastTurnId?: string;
  }
  const sseClientsByAgent = new Map<string, Set<SSEClient>>();
  const broadcastQueues = new Map<string, Promise<void>>();

  function getTurnId(turn: unknown): string | undefined {
    if (!turn || typeof turn !== 'object') return undefined;
    const id = (turn as { turnId?: unknown }).turnId;
    return typeof id === 'string' && id.trim() ? id : undefined;
  }

  async function readTurns(filePath: string): Promise<unknown[]> {
    try {
      const content = await readFile(filePath, 'utf8');
      return content.split('\n').filter(l => l.trim()).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  async function broadcastNewTurns(agentName: string, filePath: string): Promise<void> {
    const clients = sseClientsByAgent.get(agentName);
    if (!clients || clients.size === 0) return;
    const allTurns = await readTurns(filePath);
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

  function enqueueBroadcast(agentName: string, filePath: string): void {
    const prev = broadcastQueues.get(filePath) ?? Promise.resolve();
    const next = prev.then(() => broadcastNewTurns(agentName, filePath)).catch(() => {});
    broadcastQueues.set(filePath, next);
  }

  const watchers = new Map<string, fs.FSWatcher>();

  function ensureWatching(agentName: string, filePath: string): void {
    if (watchers.has(filePath)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
        if (eventType === 'rename') {
          // Inode replaced (trim via atomic rename on Linux). Restart watcher.
          watcher.close();
          watchers.delete(filePath);
          setTimeout(() => {
            const clients = sseClientsByAgent.get(agentName);
            if (clients && clients.size > 0) {
              enqueueBroadcast(agentName, filePath);
              ensureWatching(agentName, filePath);
            }
          }, 200);
          return;
        }
        enqueueBroadcast(agentName, filePath);
      });
    } catch {
      setTimeout(() => {
        const clients = sseClientsByAgent.get(agentName);
        if (clients && clients.size > 0) ensureWatching(agentName, filePath);
      }, 2000);
      return;
    }
    watcher.on('error', () => {
      watcher.close();
      watchers.delete(filePath);
      // Auto-restart watcher after trim (inode replacement on Linux)
      setTimeout(() => {
        const clients = sseClientsByAgent.get(agentName);
        if (clients && clients.size > 0) ensureWatching(agentName, filePath);
      }, 500);
    });
    watchers.set(filePath, watcher);
  }

  function maybeUnwatch(filePath: string, clients: Set<SSEClient>): void {
    if (clients.size === 0 && watchers.has(filePath)) {
      watchers.get(filePath)!.close();
      watchers.delete(filePath);
      broadcastQueues.delete(filePath);
    }
  }

  if (options.turnLogFiles) {
    for (const agentName of Object.keys(options.turnLogFiles)) {
      sseClientsByAgent.set(agentName, new Set());
    }
  }

  const server = http.createServer(async (req, res) => {
    // Set CORS headers (configurable origin, defaults to same-origin for security)
    const corsOrigin = options.corsOrigin || req.headers.origin || 'null';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');

    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route: GET /health or GET /
    if ((req.url === '/health' || req.url === '/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // Turn viewer routes
    if (options.turnLogFiles && req.method === 'GET') {
      const agentNames = Object.keys(options.turnLogFiles);
      const parsedUrl = new URL(req.url ?? '/', `http://localhost`);

      const validateTurnAuth = (): boolean => {
        if (validateApiKey(req.headers, options.apiKey)) return true;
        const qKey = parsedUrl.searchParams.get('key') || '';
        if (!qKey) return false;
        const a = Buffer.from(qKey);
        const b = Buffer.from(options.apiKey);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      };

      if (parsedUrl.pathname === '/turns') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getTurnViewerHtml(agentNames));
        return;
      }
      if (parsedUrl.pathname === '/turns/data') {
        if (!validateTurnAuth()) { sendError(res, 401, 'Unauthorized'); return; }
        const agentName = parsedUrl.searchParams.get('agent') || agentNames[0];
        const filePath = options.turnLogFiles[agentName];
        if (!filePath) { res.writeHead(404); res.end('Unknown agent'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(await readTurns(filePath)));
        return;
      }
      if (parsedUrl.pathname === '/turns/stream') {
        if (!validateTurnAuth()) { sendError(res, 401, 'Unauthorized'); return; }
        const agentName = parsedUrl.searchParams.get('agent') || agentNames[0];
        const filePath = options.turnLogFiles[agentName];
        if (!filePath) { res.writeHead(404); res.end('Unknown agent'); return; }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const allTurns = await readTurns(filePath);
        res.write(`data: ${JSON.stringify({ type: 'init', turns: allTurns })}\n\n`);
        const clients = sseClientsByAgent.get(agentName)!;
        const client: SSEClient = {
          res,
          sentCount: allTurns.length,
          lastTurnId: getTurnId(allTurns[allTurns.length - 1]),
        };
        clients.add(client);
        ensureWatching(agentName, filePath);
        req.on('close', () => {
          clients.delete(client);
          maybeUnwatch(filePath, clients);
        });
        return;
      }
    }

    // Route: POST /api/v1/messages (unified: supports both text and files)
    if (req.url === '/api/v1/messages' && req.method === 'POST') {
      try {
        // Validate authentication
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const contentType = req.headers['content-type'] || '';

        // Parse multipart/form-data (supports both text-only and file uploads)
        if (!contentType.includes('multipart/form-data')) {
          sendError(res, 400, 'Content-Type must be multipart/form-data');
          return;
        }

        // Parse multipart data
        const { fields, files } = await parseMultipart(req, MAX_FILE_SIZE);

        // Validate required fields
        if (!fields.channel || !fields.chatId) {
          sendError(res, 400, 'Missing required fields: channel, chatId');
          return;
        }

        if (!VALID_CHANNELS.includes(fields.channel as ChannelId)) {
          sendError(res, 400, `Invalid channel: ${fields.channel}`, 'channel');
          return;
        }

        // Validate that either text or file is provided
        if (!fields.text && files.length === 0) {
          sendError(res, 400, 'Either text or file must be provided');
          return;
        }

        const file = files.length > 0 ? files[0] : undefined;

        // Send via unified deliverer method
        const messageId = await deliverer.deliverToChannel(
          fields.channel as ChannelId,
          fields.chatId,
          {
            text: fields.text,
            filePath: file?.tempPath,
            kind: fields.kind as 'image' | 'file' | 'audio' | undefined,
          }
        );

        // Cleanup temp file if any
        if (file) {
          try {
            fs.unlinkSync(file.tempPath);
          } catch (err) {
            log.warn('Failed to cleanup temp file:', err);
          }
        }

        // Success response
        const response: SendMessageResponse = {
          success: true,
          messageId,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        log.error('Error handling request:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/chat (send a message to the agent, get response)
    if (req.url === '/api/v1/chat' && req.method === 'POST') {
      try {
        const resolved = await parseWebhookChatRequest(req, res, options.apiKey, deliverer);
        if (!resolved) {
          return;
        }
        log.info(`Chat request for agent "${resolved.resolvedName}": ${resolved.message.slice(0, 100)}...`);
        const wantsStream = (req.headers.accept || '').includes('text/event-stream');

        if (wantsStream) {
          // SSE streaming: forward SDK stream chunks as events
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          let clientDisconnected = false;
          req.on('close', () => { clientDisconnected = true; });

          try {
            for await (const msg of deliverer.streamToAgent(resolved.agentName, resolved.message, WEBHOOK_CONTEXT)) {
              if (clientDisconnected) break;
              res.write(`data: ${JSON.stringify(msg)}\n\n`);
              if (msg.type === 'result') break;
            }
          } catch (streamError: any) {
            if (!clientDisconnected) {
              res.write(`data: ${JSON.stringify({ type: 'error', error: streamError.message })}\n\n`);
            }
          }
          res.end();
        } else {
          // Sync: wait for full response
          const response = await deliverer.sendToAgent(resolved.agentName, resolved.message, WEBHOOK_CONTEXT);

          const chatRes: ChatResponse = {
            success: true,
            response,
            agentName: resolved.resolvedName,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(chatRes));
        }
      } catch (error: any) {
        log.error('Chat error:', error);
        const chatRes: ChatResponse = {
          success: false,
          error: error.message || 'Internal server error',
        };
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(chatRes));
      }
      return;
    }

    // Route: POST /api/v1/chat/async (fire-and-forget: returns 202, processes in background)
    if (req.url === '/api/v1/chat/async' && req.method === 'POST') {
      try {
        const resolved = await parseWebhookChatRequest(req, res, options.apiKey, deliverer);
        if (!resolved) {
          return;
        }
        log.info(`Async chat request for agent "${resolved.resolvedName}": ${resolved.message.slice(0, 100)}...`);

        // Return 202 immediately
        const asyncRes: AsyncChatResponse = {
          success: true,
          status: 'queued',
          agentName: resolved.resolvedName,
        };
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(asyncRes));

        // Process in background (detached promise)
        deliverer.sendToAgent(resolved.agentName, resolved.message, WEBHOOK_CONTEXT).catch((error: any) => {
          log.error(`Async chat background error for agent "${resolved.resolvedName}":`, error);
        });
      } catch (error: any) {
        log.error('Async chat error:', error);
        const asyncRes: AsyncChatResponse = {
          success: false,
          status: 'error',
          error: error.message || 'Internal server error',
        };
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(asyncRes));
      }
      return;
    }

    // Route: GET /api/v1/pairing/:channel - List pending pairing requests
    const pairingListMatch = req.url?.match(/^\/api\/v1\/pairing\/([a-z0-9-]+)$/);
    if (pairingListMatch && req.method === 'GET') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const channel = pairingListMatch[1];
        if (!VALID_CHANNELS.includes(channel as ChannelId)) {
          sendError(res, 400, `Invalid channel: ${channel}`, 'channel');
          return;
        }

        const requests = await listPairingRequests(channel);
        const response: PairingListResponse = { requests };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        log.error('Pairing list error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/pairing/:channel/approve - Approve a pairing code
    const pairingApproveMatch = req.url?.match(/^\/api\/v1\/pairing\/([a-z0-9-]+)\/approve$/);
    if (pairingApproveMatch && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const channel = pairingApproveMatch[1];
        if (!VALID_CHANNELS.includes(channel as ChannelId)) {
          sendError(res, 400, `Invalid channel: ${channel}`, 'channel');
          return;
        }

        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
          sendError(res, 400, 'Content-Type must be application/json');
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let approveReq: PairingApproveRequest;
        try {
          approveReq = JSON.parse(body);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }

        if (!approveReq.code || typeof approveReq.code !== 'string') {
          sendError(res, 400, 'Missing required field: code');
          return;
        }

        const result = await approvePairingCode(channel, approveReq.code);
        if (!result) {
          const response: PairingApproveResponse = {
            success: false,
            error: 'Code not found or expired',
          };
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          return;
        }

        log.info(`Pairing approved: ${channel} user ${result.userId}`);
        const response: PairingApproveResponse = {
          success: true,
          userId: result.userId,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        log.error('Pairing approve error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: GET /v1/models (OpenAI-compatible)
    if (req.url === '/v1/models' && req.method === 'GET') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          const err = buildErrorResponse('Invalid API key', 'invalid_request_error', 401);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const models = buildModelList(deliverer.getAgentNames());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (error: any) {
        log.error('Models error:', error);
        const err = buildErrorResponse(error.message || 'Internal server error', 'server_error', 500);
        res.writeHead(err.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err.body));
      }
      return;
    }

    // Route: POST /v1/chat/completions (OpenAI-compatible)
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          const err = buildErrorResponse('Invalid API key', 'invalid_request_error', 401);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
          const err = buildErrorResponse('Content-Type must be application/json', 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          const err = buildErrorResponse('Invalid JSON body', 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        // Validate OpenAI request shape
        const validationError = validateChatRequest(parsed);
        if (validationError) {
          res.writeHead(validationError.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(validationError.body));
          return;
        }

        const chatReq = parsed as OpenAIChatRequest;

        // Extract the last user message
        const userMessage = extractLastUserMessage(chatReq.messages);
        if (!userMessage) {
          const err = buildErrorResponse('No user message found in messages array', 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        if (userMessage.length > MAX_TEXT_LENGTH) {
          const err = buildErrorResponse(`Message too long (max ${MAX_TEXT_LENGTH} chars)`, 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        // Resolve agent from model field
        const agentNames = deliverer.getAgentNames();
        const modelName = chatReq.model || agentNames[0];
        const agentName = agentNames.includes(modelName) ? modelName : undefined;

        // If an explicit model was requested but doesn't match any agent, error
        if (chatReq.model && !agentNames.includes(chatReq.model)) {
          const err = buildErrorResponse(
            `Model not found: ${chatReq.model}. Available: ${agentNames.join(', ')}`,
            'model_not_found',
            404,
          );
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const completionId = generateCompletionId();
        const context = { type: 'webhook' as const, outputMode: 'silent' as const };

        log.info(`OpenAI chat: model="${modelName}", stream=${!!chatReq.stream}, msg="${userMessage.slice(0, 100)}..."`);

        if (chatReq.stream) {
          // ---- Streaming response ----
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          let clientDisconnected = false;
          req.on('close', () => { clientDisconnected = true; });

          // First chunk: role announcement
          res.write(formatSSE(buildChunk(completionId, modelName, { role: 'assistant' })));

          try {
            let toolIndex = 0;

            for await (const msg of deliverer.streamToAgent(agentName, userMessage, context)) {
              if (clientDisconnected) break;

              if (msg.type === 'assistant' && msg.content) {
                // Text content delta
                res.write(formatSSE(buildChunk(completionId, modelName, { content: msg.content })));
              } else if (msg.type === 'tool_call') {
                // Tool call delta (emit name + args in one chunk)
                const toolCallId = msg.toolCallId || `call_${msg.uuid || 'unknown'}`;
                const toolName = msg.toolName || 'unknown';
                const args = msg.toolInput ? JSON.stringify(msg.toolInput) : '{}';
                res.write(formatSSE(buildToolCallChunk(
                  completionId, modelName, toolIndex++, toolCallId, toolName, args,
                )));
              } else if (msg.type === 'result') {
                if (!(msg as any).success) {
                  const errMsg = (msg as any).error || 'Agent run failed';
                  res.write(formatSSE(buildChunk(completionId, modelName, {
                    content: `\n\n[Error: ${errMsg}]`,
                  })));
                }
                break;
              }
              // Skip 'reasoning', 'tool_result', and other internal types
            }
          } catch (streamError: any) {
            if (!clientDisconnected) {
              // Emit error as a content delta so clients see it
              res.write(formatSSE(buildChunk(completionId, modelName, {
                content: `\n\n[Error: ${streamError.message}]`,
              })));
            }
          }

          // Finish chunk + done sentinel
          if (!clientDisconnected) {
            res.write(formatSSE(buildChunk(completionId, modelName, {}, 'stop')));
            res.write(SSE_DONE);
          }
          res.end();
        } else {
          // ---- Sync response ----
          const response = await deliverer.sendToAgent(agentName, userMessage, context);
          const completion = buildCompletion(completionId, modelName, response);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(completion));
        }
      } catch (error: any) {
        log.error('OpenAI chat error:', error);
        const err = buildErrorResponse(error.message || 'Internal server error', 'server_error', 500);
        res.writeHead(err.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err.body));
      }
      return;
    }

    // Route: GET /api/v1/status - Agent status (conversation IDs, channels)
    if (req.url === '/api/v1/status' && req.method === 'GET') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        const agents: Record<string, any> = {};
        if (options.stores) {
          for (const [name, store] of options.stores) {
            const info = store.getInfo();
            agents[name] = {
              agentId: info.agentId,
              conversationId: info.conversationId || null,
              conversations: info.conversations || {},
              channels: options.agentChannels?.get(name) || [],
              baseUrl: info.baseUrl,
              createdAt: info.createdAt,
              lastUsedAt: info.lastUsedAt,
            };
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents }));
      } catch (error: any) {
        log.error('Status error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/conversation - Set conversation ID
    if (req.url === '/api/v1/conversation' && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        if (!options.stores || options.stores.size === 0) {
          sendError(res, 500, 'No stores configured');
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let request: { conversationId?: string; agent?: string; key?: string };
        try {
          request = JSON.parse(body);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }

        if (!request.conversationId || typeof request.conversationId !== 'string') {
          sendError(res, 400, 'Missing required field: conversationId');
          return;
        }

        // Resolve agent name (default to first store)
        const agentName = request.agent || options.stores.keys().next().value!;
        const store = options.stores.get(agentName);
        if (!store) {
          sendError(res, 404, `Agent not found: ${agentName}`);
          return;
        }

        const key = request.key || 'shared';
        if (key === 'shared') {
          store.conversationId = request.conversationId;
        } else {
          store.setConversationId(key, request.conversationId);
        }

        // Invalidate the live session so the next message uses the new conversation
        const invalidate = options.sessionInvalidators?.get(agentName);
        if (invalidate) {
          invalidate(key === 'shared' ? undefined : key);
        }

        log.info(`API set conversation: agent=${agentName} key=${key} conv=${request.conversationId}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, agent: agentName, key, conversationId: request.conversationId }));
      } catch (error: any) {
        log.error('Set conversation error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: GET /api/v1/conversations - List conversations from Letta API
    if (req.url?.startsWith('/api/v1/conversations') && req.method === 'GET') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        if (!options.stores || options.stores.size === 0) {
          sendError(res, 500, 'No stores configured');
          return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const agentName = url.searchParams.get('agent') || options.stores.keys().next().value!;
        const store = options.stores.get(agentName);
        if (!store) {
          sendError(res, 404, `Agent not found: ${agentName}`);
          return;
        }

        const agentId = store.getInfo().agentId;
        if (!agentId) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ conversations: [] }));
          return;
        }

        const { Letta } = await import('@letta-ai/letta-client');
        const client = new Letta({
          apiKey: process.env.LETTA_API_KEY || '',
          baseURL: process.env.LETTA_BASE_URL || 'https://api.letta.com',
        });
        const convos = await client.conversations.list({
          agent_id: agentId,
          limit: 50,
          order: 'desc',
          order_by: 'last_run_completion',
        });

        const conversations = convos.map(c => ({
          id: c.id,
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          summary: c.summary || null,
          messageCount: c.in_context_message_ids?.length || 0,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conversations }));
      } catch (error: any) {
        log.error('List conversations error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: GET /api/v1/config - Read config (sensitive fields masked)
    if (req.url === '/api/v1/config' && req.method === 'GET') {
      if (!validateApiKey(req.headers, options.apiKey)) { sendError(res, 401, 'Unauthorized'); return; }
      try {
        const config = loadConfigStrict();
        const masked = maskSensitiveFields(config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ config: masked }));
      } catch (error: any) {
        log.error('Config read error:', error);
        sendError(res, 500, error.message || 'Failed to read config');
      }
      return;
    }

    // Route: PUT /api/v1/config - Update config
    if (req.url === '/api/v1/config' && req.method === 'PUT') {
      if (!validateApiKey(req.headers, options.apiKey)) { sendError(res, 401, 'Unauthorized'); return; }
      try {
        const body = await readBody(req, MAX_BODY_SIZE);
        const parsed = JSON.parse(body);
        if (!parsed.config || typeof parsed.config !== 'object') {
          sendError(res, 400, 'Request body must contain a "config" object');
          return;
        }

        // Load current config, deep-merge changes, save
        const current = loadConfigStrict();
        const merged = deepMergeConfig(current as Record<string, any>, parsed.config) as LettaBotConfig;

        // When using multi-agent format, strip redundant legacy top-level keys
        // that loadConfigStrict() adds during normalization
        if (Array.isArray(merged.agents) && merged.agents.length > 0) {
          const m = merged as Record<string, any>;
          delete m.agent;
          if (m.channels && Object.keys(m.channels).length === 0) delete m.channels;
          // Only delete these if they exist on agents (not global overrides)
          if (merged.agents[0]?.features && m.features) delete m.features;
          if (merged.agents[0]?.conversations && m.conversations) delete m.conversations;
        }

        // Save and validate by re-reading (loadConfigStrict throws on invalid config)
        saveConfig(merged);
        try {
          loadConfigStrict();
        } catch (validationError: any) {
          // Revert: re-save the original config
          saveConfig(current);
          throw new Error('Validation failed after save (reverted): ' + validationError.message);
        }
        log.info('Config updated via API');

        // Check if restart-requiring fields changed
        const restartRequired = needsRestart(current, merged as LettaBotConfig);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, restartRequired }));
      } catch (error: any) {
        log.error('Config write error:', error);
        sendError(res, error.message?.includes('Conflicting') ? 400 : 500, error.message || 'Failed to write config');
      }
      return;
    }

    // Route: GET /api/v1/config/schema - Config field schema
    if (req.url === '/api/v1/config/schema' && req.method === 'GET') {
      if (!validateApiKey(req.headers, options.apiKey)) { sendError(res, 401, 'Unauthorized'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ schema: CONFIG_SCHEMA }));
      return;
    }

    // Route: GET /portal/* and /config — Admin portal static files
    // Serve /config as a top-level alias for the config editor
    const portalPrefix = req.url?.startsWith('/portal') ? '/portal' : req.url?.startsWith('/config') ? '/config' : null;
    if (portalPrefix && req.method === 'GET') {
      let portalPath: string;
      if (portalPrefix === '/config') {
        // /config → config.html, /config/foo → not found (config is a single page)
        const rest = req.url!.replace(/^\/config\/?/, '').split('?')[0];
        portalPath = rest ? rest : 'config.html';
      } else {
        // /portal → index.html, /portal/ → index.html, /portal/shared.css → shared.css
        portalPath = req.url!.replace(/^\/portal\/?/, '').split('?')[0] || 'index.html';
      }
      // Extensionless paths → .html (e.g. /portal/config → config.html)
      if (portalPath && !path.extname(portalPath)) portalPath += '.html';

      if (servePortalFile(res, portalPath)) return;
      // Fall through to 404
    }

    // Route: 404 Not Found
    sendError(res, 404, 'Not found');
  });

  // Bind to localhost by default for security (prevents network exposure on bare metal)
  // Use API_HOST=0.0.0.0 in Docker to expose on all interfaces
  const host = options.host || '127.0.0.1';
  server.listen(options.port, host, () => {
    log.info(`Server listening on ${host}:${options.port}`);
  });

  return server;
}

/**
 * Read request body with size limit
 */
function readBody(req: http.IncomingMessage, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error(`Request body too large (max ${maxSize} bytes)`));
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      resolve(body);
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

function ensureAuthorized(req: http.IncomingMessage, res: http.ServerResponse, apiKey: string): boolean {
  if (validateApiKey(req.headers, apiKey)) {
    return true;
  }
  sendError(res, 401, 'Unauthorized');
  return false;
}

function ensureJsonContentType(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    return true;
  }
  sendError(res, 400, 'Content-Type must be application/json');
  return false;
}

async function parseJsonBody<T>(req: http.IncomingMessage, res: http.ServerResponse): Promise<T | null> {
  const body = await readBody(req, MAX_BODY_SIZE);
  try {
    return JSON.parse(body) as T;
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return null;
  }
}

function resolveAgentNameOrError(
  deliverer: AgentRouter,
  requestedAgentName: string | undefined,
  res: http.ServerResponse,
): { agentName: string | undefined; resolvedName: string } | null {
  const agentNames = deliverer.getAgentNames();
  const resolvedName = requestedAgentName || agentNames[0];
  if (requestedAgentName && !agentNames.includes(requestedAgentName)) {
    sendError(res, 404, `Agent not found: ${requestedAgentName}. Available: ${agentNames.join(', ')}`);
    return null;
  }
  return { agentName: requestedAgentName, resolvedName };
}

async function parseWebhookChatRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  apiKey: string,
  deliverer: AgentRouter,
): Promise<ResolvedChatRequest | null> {
  if (!ensureAuthorized(req, res, apiKey)) {
    return null;
  }
  if (!ensureJsonContentType(req, res)) {
    return null;
  }

  const chatReq = await parseJsonBody<ChatRequest>(req, res);
  if (!chatReq) {
    return null;
  }
  if (!chatReq.message || typeof chatReq.message !== 'string') {
    sendError(res, 400, 'Missing required field: message');
    return null;
  }
  if (chatReq.message.length > MAX_TEXT_LENGTH) {
    sendError(res, 400, `Message too long (max ${MAX_TEXT_LENGTH} chars)`);
    return null;
  }

  const agent = resolveAgentNameOrError(deliverer, chatReq.agent, res);
  if (!agent) {
    return null;
  }

  return {
    message: chatReq.message,
    agentName: agent.agentName,
    resolvedName: agent.resolvedName,
  };
}

/**
 * Send error response
 */
function sendError(res: http.ServerResponse, status: number, message: string, field?: string): void {
  const response: SendMessageResponse = {
    success: false,
    error: message,
    field,
  };
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

// ── Config API helpers ────────────────────────────────────────────────────────

const SENSITIVE_MARKER = '••••••';

/** Paths to mask in config responses (dot-notation). */
const SENSITIVE_PATHS = [
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
function maskSensitiveFields(config: LettaBotConfig): Record<string, unknown> {
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
function needsRestart(prev: LettaBotConfig, next: LettaBotConfig): boolean {
  if (prev.server.mode !== next.server.mode) return true;
  if (prev.server.baseUrl !== next.server.baseUrl) return true;
  if (prev.server.apiKey !== next.server.apiKey) return true;
  if (JSON.stringify(prev.channels) !== JSON.stringify(next.channels)) return true;
  if (JSON.stringify(prev.agents) !== JSON.stringify(next.agents)) return true;
  return false;
}

// ── Config schema (drives the config editor UI) ──────────────────────────────

type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'secret' | 'string[]';
interface SchemaField {
  key: string;
  type: FieldType;
  label: string;
  description?: string;
  default?: unknown;
  options?: string[];     // for enum type
  required?: boolean;
  restartRequired?: boolean;
}
interface SchemaGroup {
  id: string;
  label: string;
  fields: SchemaField[];
}

// Group channel config fields (shared across Discord, Telegram, Slack, etc.)
const GROUP_CONFIG_FIELDS: SchemaField[] = [
  { key: 'mode', type: 'enum', label: 'Mode', options: ['open', 'listen', 'mention-only', 'disabled'], default: 'open', description: 'How the bot engages in this group' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users', description: 'Only process messages from these user IDs' },
  { key: 'receiveBotMessages', type: 'boolean', label: 'Receive Bot Messages', default: false, description: 'Process messages from other bots' },
  { key: 'dailyLimit', type: 'number', label: 'Daily Limit', description: 'Max bot triggers per day in this group' },
  { key: 'dailyUserLimit', type: 'number', label: 'Daily User Limit', description: 'Max triggers per user per day' },
  { key: 'threadMode', type: 'enum', label: 'Thread Mode', options: ['any', 'thread-only'], default: 'any', description: 'Discord: require messages to be in a thread (thread-only) or respond anywhere (any)' },
  { key: 'autoCreateThreadOnMention', type: 'boolean', label: 'Auto-Create Thread on Mention', default: false, description: 'Discord: auto-create a thread when the bot is @mentioned in a channel' },
];

// Per-channel schema definitions (key prefix is relative to the channel object)
const DISCORD_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'token', type: 'secret', label: 'Bot Token', restartRequired: true },
  { key: 'dmPolicy', type: 'enum', label: 'DM Policy', options: ['pairing', 'allowlist', 'open'], default: 'pairing' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users', description: 'User IDs for allowlist policy' },
  { key: 'streaming', type: 'boolean', label: 'Streaming', description: 'Stream responses via progressive edits' },
  { key: 'groupDebounceSec', type: 'number', label: 'Group Debounce (sec)', default: 5, description: 'Debounce interval for group messages' },
  { key: 'instantGroups', type: 'string[]', label: 'Instant Groups', description: 'Guild/channel IDs that bypass batching' },
  { key: 'excludeChannels', type: 'string[]', label: 'Exclude Channels', description: 'Channel/guild IDs to completely ignore' },
  { key: 'ignoreBotReactions', type: 'boolean', label: 'Ignore Bot Reactions', default: true, description: 'Ignore emoji reactions from bots' },
  { key: 'memberEvents', type: 'boolean', label: 'Member Events', description: 'Enable member join/leave events' },
  { key: 'welcomeChannel', type: 'string', label: 'Welcome Channel', description: 'Channel ID for join/leave events' },
];

const TELEGRAM_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'token', type: 'secret', label: 'Bot Token', restartRequired: true },
  { key: 'dmPolicy', type: 'enum', label: 'DM Policy', options: ['pairing', 'allowlist', 'open'], default: 'pairing' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users' },
  { key: 'streaming', type: 'boolean', label: 'Streaming' },
  { key: 'groupDebounceSec', type: 'number', label: 'Group Debounce (sec)', default: 5 },
  { key: 'instantGroups', type: 'string[]', label: 'Instant Groups' },
  { key: 'mentionPatterns', type: 'string[]', label: 'Mention Patterns', description: 'Regex patterns for mention detection' },
  { key: 'excludeChannels', type: 'string[]', label: 'Exclude Channels' },
];

const SLACK_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'botToken', type: 'secret', label: 'Bot Token (xoxb-...)', restartRequired: true },
  { key: 'appToken', type: 'secret', label: 'App Token (xapp-...)', restartRequired: true },
  { key: 'dmPolicy', type: 'enum', label: 'DM Policy', options: ['pairing', 'allowlist', 'open'], default: 'pairing' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users' },
  { key: 'streaming', type: 'boolean', label: 'Streaming' },
  { key: 'groupDebounceSec', type: 'number', label: 'Group Debounce (sec)', default: 5 },
  { key: 'instantGroups', type: 'string[]', label: 'Instant Groups' },
  { key: 'excludeChannels', type: 'string[]', label: 'Exclude Channels' },
];

const SIGNAL_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'phone', type: 'secret', label: 'Phone Number', restartRequired: true },
  { key: 'dmPolicy', type: 'enum', label: 'DM Policy', options: ['pairing', 'allowlist', 'open'], default: 'pairing' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users' },
  { key: 'selfChat', type: 'boolean', label: 'Self Chat', default: true },
  { key: 'mentionPatterns', type: 'string[]', label: 'Mention Patterns' },
  { key: 'groupDebounceSec', type: 'number', label: 'Group Debounce (sec)', default: 5 },
  { key: 'instantGroups', type: 'string[]', label: 'Instant Groups' },
  { key: 'excludeChannels', type: 'string[]', label: 'Exclude Channels' },
  { key: 'readReceipts', type: 'boolean', label: 'Read Receipts', default: true, description: 'Send read receipts for incoming messages' },
];

const WHATSAPP_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'dmPolicy', type: 'enum', label: 'DM Policy', options: ['pairing', 'allowlist', 'open'], default: 'pairing' },
  { key: 'allowedUsers', type: 'string[]', label: 'Allowed Users' },
  { key: 'selfChat', type: 'boolean', label: 'Self Chat' },
  { key: 'groupPolicy', type: 'enum', label: 'Group Policy', options: ['open', 'disabled', 'allowlist'], default: 'open' },
  { key: 'mentionPatterns', type: 'string[]', label: 'Mention Patterns' },
  { key: 'groupDebounceSec', type: 'number', label: 'Group Debounce (sec)', default: 5 },
  { key: 'instantGroups', type: 'string[]', label: 'Instant Groups' },
];

const BLUESKY_FIELDS: SchemaField[] = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, restartRequired: true },
  { key: 'handle', type: 'string', label: 'Handle', description: 'Bluesky handle (for posting)' },
  { key: 'appPassword', type: 'secret', label: 'App Password', restartRequired: true },
  { key: 'serviceUrl', type: 'string', label: 'Service URL', description: 'ATProto service URL (default: https://bsky.social)' },
  { key: 'appViewUrl', type: 'string', label: 'AppView URL', description: 'For list/notification APIs' },
  { key: 'jetstreamUrl', type: 'string', label: 'Jetstream URL', description: 'Jetstream WebSocket URL' },
  { key: 'wantedDids', type: 'string[]', label: 'Wanted DIDs', description: 'DID(s) to follow (e.g. did:plc:...)' },
  { key: 'wantedCollections', type: 'string[]', label: 'Wanted Collections', description: 'e.g. app.bsky.feed.post' },
  { key: 'notifications.enabled', type: 'boolean', label: 'Notifications', description: 'Poll notifications API' },
  { key: 'notifications.intervalSec', type: 'number', label: 'Notification Poll Interval (sec)', default: 60 },
  { key: 'notifications.reasons', type: 'string[]', label: 'Notification Reasons', description: 'Filter: mention, reply, etc.' },
];

const AGENT_INFO_FIELDS: SchemaField[] = [
  { key: 'name', type: 'string', label: 'Name', required: true, restartRequired: true },
  { key: 'id', type: 'string', label: 'Agent ID', description: 'Existing Letta agent ID (skip creation)' },
  { key: 'displayName', type: 'string', label: 'Display Name', description: 'Prefix for outbound messages' },
  { key: 'model', type: 'string', label: 'Model', description: 'Model for initial agent creation' },
  { key: 'workingDir', type: 'string', label: 'Working Directory', description: 'Runtime data directory (default: /tmp/lettabot)', restartRequired: true },
];

const FEATURES_FIELDS: SchemaField[] = [
  { key: 'features.cron', type: 'boolean', label: 'Cron Jobs', description: 'Enable scheduled cron tasks' },
  { key: 'features.heartbeat.enabled', type: 'boolean', label: 'Heartbeat', description: 'Send periodic heartbeat messages' },
  { key: 'features.heartbeat.intervalMin', type: 'number', label: 'Heartbeat Interval (min)', default: 60 },
  { key: 'features.heartbeat.skipRecentUserMin', type: 'number', label: 'Skip After User (min)', default: 0 },
  { key: 'features.heartbeat.skipRecentPolicy', type: 'enum', label: 'Skip Recent Policy', options: ['fixed', 'fraction', 'off'], default: 'fixed', description: 'How to calculate skip window: fixed minutes, fraction of interval, or disabled' },
  { key: 'features.heartbeat.skipRecentFraction', type: 'number', label: 'Skip Recent Fraction', description: 'Fraction of intervalMin when policy=fraction (0-1)' },
  { key: 'features.heartbeat.interruptOnUserMessage', type: 'boolean', label: 'Interrupt on User Message', description: 'Cancel in-flight heartbeat when a user messages' },
  { key: 'features.heartbeat.prompt', type: 'string', label: 'Heartbeat Prompt' },
  { key: 'features.heartbeat.promptFile', type: 'string', label: 'Heartbeat Prompt File', description: 'Path to prompt file (re-read each tick for live editing)' },
  { key: 'features.heartbeat.target', type: 'string', label: 'Heartbeat Target', description: 'e.g. telegram:12345' },
  { key: 'features.memfs', type: 'boolean', label: 'Memory Filesystem', description: 'Enable git-backed context repository' },
  { key: 'features.syncSystemPrompt', type: 'boolean', label: 'Sync System Prompt', default: true },
  { key: 'features.maxToolCalls', type: 'number', label: 'Max Tool Calls', default: 100 },
  { key: 'features.inlineImages', type: 'boolean', label: 'Inline Images', default: true },
  { key: 'features.display.toolCalls', type: 'boolean', label: 'Show Tool Calls' },
  { key: 'features.display.reasoning', type: 'boolean', label: 'Show Reasoning' },
  { key: 'features.sleeptime.trigger', type: 'enum', label: 'Sleeptime Trigger', options: ['off', 'step-count', 'compaction-event'], default: 'off', description: 'When to trigger SDK reflection' },
  { key: 'features.sleeptime.behavior', type: 'enum', label: 'Sleeptime Behavior', options: ['reminder', 'auto-launch'], default: 'reminder', description: 'How to handle sleeptime (reminder prompt or auto-launch)' },
  { key: 'features.sleeptime.stepCount', type: 'number', label: 'Sleeptime Step Count', description: 'Trigger after N steps (when trigger = step-count)' },
  { key: 'features.logging.turnLogFile', type: 'string', label: 'Turn Log File', description: 'Path to JSONL file for turn logging' },
  { key: 'features.logging.maxTurns', type: 'number', label: 'Max Log Turns', default: 1000, description: 'Max turns to retain in log file' },
  { key: 'features.allowedTools', type: 'string[]', label: 'Allowed Tools' },
  { key: 'features.disallowedTools', type: 'string[]', label: 'Disallowed Tools' },
];

const CONVERSATIONS_FIELDS: SchemaField[] = [
  { key: 'conversations.mode', type: 'enum', label: 'Mode', options: ['disabled', 'shared', 'per-channel', 'per-chat'], default: 'shared' },
  { key: 'conversations.heartbeat', type: 'string', label: 'Heartbeat Routing', description: 'dedicated, last-active, or channel name' },
  { key: 'conversations.perChannel', type: 'string[]', label: 'Per-Channel Keys' },
  { key: 'conversations.maxSessions', type: 'number', label: 'Max Sessions', default: 10 },
  { key: 'conversations.reuseSession', type: 'boolean', label: 'Reuse Session', default: true },
];

const CONFIG_SCHEMA = {
  global: [
    {
      id: 'server', label: 'Server', fields: [
        { key: 'server.mode', type: 'enum' as FieldType, label: 'Mode', options: ['api', 'docker'], default: 'api', description: 'api = Letta Cloud, docker = self-hosted', restartRequired: true },
        { key: 'server.baseUrl', type: 'string' as FieldType, label: 'Base URL', description: 'Letta server URL (docker mode only)', restartRequired: true },
        { key: 'server.apiKey', type: 'secret' as FieldType, label: 'API Key', description: 'Letta API key', restartRequired: true },
        { key: 'server.logLevel', type: 'enum' as FieldType, label: 'Log Level', options: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'], default: 'info' },
        { key: 'server.api.port', type: 'number' as FieldType, label: 'API Port', default: 8080, restartRequired: true },
        { key: 'server.api.host', type: 'string' as FieldType, label: 'API Host', default: '127.0.0.1', restartRequired: true },
        { key: 'server.api.corsOrigin', type: 'string' as FieldType, label: 'CORS Origin' },
      ],
    },
    {
      id: 'transcription', label: 'Transcription', fields: [
        { key: 'transcription.provider', type: 'enum' as FieldType, label: 'Provider', options: ['openai', 'mistral'] },
        { key: 'transcription.apiKey', type: 'secret' as FieldType, label: 'API Key' },
        { key: 'transcription.model', type: 'string' as FieldType, label: 'Model' },
      ],
    },
    {
      id: 'tts', label: 'Text-to-Speech', fields: [
        { key: 'tts.provider', type: 'enum' as FieldType, label: 'Provider', options: ['elevenlabs', 'openai'], default: 'elevenlabs' },
        { key: 'tts.apiKey', type: 'secret' as FieldType, label: 'API Key' },
        { key: 'tts.voiceId', type: 'string' as FieldType, label: 'Voice ID' },
        { key: 'tts.model', type: 'string' as FieldType, label: 'Model' },
      ],
    },
    {
      id: 'attachments', label: 'Attachments', fields: [
        { key: 'attachments.maxMB', type: 'number' as FieldType, label: 'Max Size (MB)' },
        { key: 'attachments.maxAgeDays', type: 'number' as FieldType, label: 'Max Age (days)' },
      ],
    },
    {
      id: 'security', label: 'Security', fields: [
        { key: 'security.redaction.secrets', type: 'boolean' as FieldType, label: 'Redact Secrets', default: true },
        { key: 'security.redaction.pii', type: 'boolean' as FieldType, label: 'Redact PII', default: false },
      ],
    },
  ] as SchemaGroup[],
  agent: {
    info: AGENT_INFO_FIELDS,
    features: FEATURES_FIELDS,
    conversations: CONVERSATIONS_FIELDS,
    channels: {
      discord: { label: 'Discord', fields: DISCORD_FIELDS },
      telegram: { label: 'Telegram', fields: TELEGRAM_FIELDS },
      slack: { label: 'Slack', fields: SLACK_FIELDS },
      signal: { label: 'Signal', fields: SIGNAL_FIELDS },
      whatsapp: { label: 'WhatsApp', fields: WHATSAPP_FIELDS },
      bluesky: { label: 'Bluesky', fields: BLUESKY_FIELDS },
    },
    groupConfig: GROUP_CONFIG_FIELDS,
  },
};
