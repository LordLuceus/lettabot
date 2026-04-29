/**
 * HTTP utilities — generic request/response plumbing for the API server.
 *
 * Shared helpers used across multiple route handlers in server.ts.
 */

import * as http from 'http';
import { validateApiKey } from './auth.js';
import type { SendMessageResponse, ChatRequest } from './types.js';
import type { AgentRouter } from '../core/interfaces.js';
import type { ChannelId } from '../core/types.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const VALID_CHANNELS: ChannelId[] = ['telegram', 'slack', 'discord', 'whatsapp', 'signal'];
export const MAX_BODY_SIZE = 10 * 1024; // 10KB
export const MAX_TEXT_LENGTH = 10000; // 10k chars
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const WEBHOOK_CONTEXT = { type: 'webhook' as const, outputMode: 'silent' as const };

// ── Types ────────────────────────────────────────────────────────────────────

export type ResolvedChatRequest = {
  message: string;
  agentName: string | undefined;
  resolvedName: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read request body with size limit.
 */
export function readBody(req: http.IncomingMessage, maxSize: number): Promise<string> {
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

/**
 * Send error response.
 */
export function sendError(res: http.ServerResponse, status: number, message: string, field?: string): void {
  const response: SendMessageResponse = {
    success: false,
    error: message,
    field,
  };
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

export function ensureAuthorized(req: http.IncomingMessage, res: http.ServerResponse, apiKey: string): boolean {
  if (validateApiKey(req.headers, apiKey)) {
    return true;
  }
  sendError(res, 401, 'Unauthorized');
  return false;
}

export function ensureJsonContentType(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    return true;
  }
  sendError(res, 400, 'Content-Type must be application/json');
  return false;
}

export async function parseJsonBody<T>(req: http.IncomingMessage, res: http.ServerResponse): Promise<T | null> {
  const body = await readBody(req, MAX_BODY_SIZE);
  try {
    return JSON.parse(body) as T;
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return null;
  }
}

export function resolveAgentNameOrError(
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

export async function parseWebhookChatRequest(
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
