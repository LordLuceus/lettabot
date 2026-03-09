import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { createApiServer, deepMergeConfig } from './server.js';
import type { AgentRouter } from '../core/interfaces.js';

const TEST_API_KEY = 'test-key-12345';
const TEST_PORT = 0; // Let OS assign a free port

function createMockRouter(overrides: Partial<AgentRouter> = {}): AgentRouter {
  return {
    deliverToChannel: vi.fn().mockResolvedValue('msg-1'),
    sendToAgent: vi.fn().mockResolvedValue('Agent says hello'),
    streamToAgent: vi.fn().mockReturnValue((async function* () {
      yield { type: 'reasoning', content: 'thinking...' };
      yield { type: 'assistant', content: 'Hello ' };
      yield { type: 'assistant', content: 'world' };
      yield { type: 'result', success: true };
    })()),
    getAgentNames: vi.fn().mockReturnValue(['LettaBot']),
    ...overrides,
  };
}

function getPort(server: http.Server): number {
  const addr = server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('Server not listening');
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('POST /api/v1/chat', () => {
  let server: http.Server;
  let port: number;
  let router: AgentRouter;

  beforeAll(async () => {
    router = createMockRouter();
    server = createApiServer(router, {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    // Wait for server to start listening
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 401 without api key', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"hi"}', {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong api key', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"hi"}', {
      'content-type': 'application/json',
      'x-api-key': 'wrong-key',
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 without Content-Type application/json', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', 'hello', {
      'content-type': 'text/plain',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('application/json');
  });

  it('returns 400 with invalid JSON', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', 'not json', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Invalid JSON');
  });

  it('returns 400 without message field', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"agent":"LettaBot"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('message');
  });

  it('returns 404 for unknown agent name', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"hi","agent":"unknown"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain('Agent not found');
    expect(JSON.parse(res.body).error).toContain('LettaBot');
  });

  it('returns sync JSON response by default', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Hello"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.success).toBe(true);
    expect(parsed.response).toBe('Agent says hello');
    expect(parsed.agentName).toBe('LettaBot');
    expect(router.sendToAgent).toHaveBeenCalledWith(
      undefined,
      'Hello',
      { type: 'webhook', outputMode: 'silent' },
    );
  });

  it('routes to named agent', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Hi","agent":"LettaBot"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    expect(router.sendToAgent).toHaveBeenCalledWith(
      'LettaBot',
      'Hi',
      { type: 'webhook', outputMode: 'silent' },
    );
  });

  it('returns SSE stream when Accept: text/event-stream', async () => {
    // Need a fresh mock since the generator is consumed once
    (router as any).streamToAgent = vi.fn().mockReturnValue((async function* () {
      yield { type: 'reasoning', content: 'thinking...' };
      yield { type: 'assistant', content: 'Hello ' };
      yield { type: 'assistant', content: 'world' };
      yield { type: 'result', success: true };
    })());

    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Stream test"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
      'accept': 'text/event-stream',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');

    // Parse SSE events
    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.replace('data: ', '')));

    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('reasoning');
    expect(events[1].type).toBe('assistant');
    expect(events[1].content).toBe('Hello ');
    expect(events[2].type).toBe('assistant');
    expect(events[2].content).toBe('world');
    expect(events[3].type).toBe('result');
    expect(events[3].success).toBe(true);
  });

  it('handles stream errors gracefully', async () => {
    (router as any).streamToAgent = vi.fn().mockReturnValue((async function* () {
      yield { type: 'assistant', content: 'partial' };
      throw new Error('connection lost');
    })());

    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Error test"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
      'accept': 'text/event-stream',
    });
    expect(res.status).toBe(200);

    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.replace('data: ', '')));

    // Should have the partial chunk + error event
    expect(events.find((e: any) => e.type === 'assistant')).toBeTruthy();
    expect(events.find((e: any) => e.type === 'error')).toBeTruthy();
    expect(events.find((e: any) => e.type === 'error').error).toBe('connection lost');
  });
});

describe('POST /api/v1/chat/async', () => {
  let server: http.Server;
  let port: number;
  let router: AgentRouter;

  beforeAll(async () => {
    router = createMockRouter();
    server = createApiServer(router, {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reuses shared validation: content-type guard', async () => {
    const res = await request(port, 'POST', '/api/v1/chat/async', 'hello', {
      'content-type': 'text/plain',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('application/json');
  });

  it('reuses shared validation: missing message', async () => {
    const res = await request(port, 'POST', '/api/v1/chat/async', '{"agent":"LettaBot"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('message');
  });

  it('reuses shared validation: unknown agent', async () => {
    const res = await request(port, 'POST', '/api/v1/chat/async', '{"message":"hi","agent":"unknown"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain('Agent not found');
    expect(JSON.parse(res.body).error).toContain('LettaBot');
  });

  it('returns 202 and queues background delivery', async () => {
    (router as any).sendToAgent = vi.fn().mockResolvedValue('done');

    const res = await request(port, 'POST', '/api/v1/chat/async', '{"message":"queue me"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.status).toBe('queued');
    expect(body.agentName).toBe('LettaBot');
    expect((router as any).sendToAgent).toHaveBeenCalledWith(
      undefined,
      'queue me',
      { type: 'webhook', outputMode: 'silent' },
    );

  });
});

describe('GET /portal', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createApiServer(createMockRouter(), {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the pairing portal HTML without requiring an API key', async () => {
    const res = await request(port, 'GET', '/portal');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>LettaBot Portal</title>');
  });

  it('serves portal/index.html for /portal/', async () => {
    const res = await request(port, 'GET', '/portal/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>LettaBot Portal</title>');
  });

  it('serves the config editor at /portal/config', async () => {
    const res = await request(port, 'GET', '/portal/config');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>LettaBot Config</title>');
  });

  it('serves the config editor at /config (top-level alias)', async () => {
    const res = await request(port, 'GET', '/config');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>LettaBot Config</title>');
  });

  it('serves shared.css with correct MIME type', async () => {
    const res = await request(port, 'GET', '/portal/shared.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.body).toContain('box-sizing');
  });

  it('serves shared.js with correct MIME type', async () => {
    const res = await request(port, 'GET', '/portal/shared.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.body).toContain('apiFetch');
  });

  it('returns 404 for non-existent portal files', async () => {
    const res = await request(port, 'GET', '/portal/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('blocks path traversal attempts', async () => {
    const res = await request(port, 'GET', '/portal/../api/server.ts');
    expect(res.status).toBe(404);
  });
});

describe('Config API', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createApiServer(createMockRouter(), {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /api/v1/config returns 401 without API key', async () => {
    const res = await request(port, 'GET', '/api/v1/config');
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/config returns config with sensitive fields masked', async () => {
    const res = await request(port, 'GET', '/api/v1/config', undefined, {
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.config).toBeDefined();
    expect(body.config.server).toBeDefined();
    // API key should be masked if set
    if (body.config.server.apiKey) {
      expect(body.config.server.apiKey).toBe('\u2022\u2022\u2022\u2022\u2022\u2022');
    }
  });

  it('GET /api/v1/config/schema returns 401 without API key', async () => {
    const res = await request(port, 'GET', '/api/v1/config/schema');
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/config/schema returns global + agent schema', async () => {
    const res = await request(port, 'GET', '/api/v1/config/schema', undefined, {
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);

    // Global schema
    expect(Array.isArray(body.schema.global)).toBe(true);
    expect(body.schema.global.length).toBeGreaterThan(0);
    const globalIds = body.schema.global.map((g: any) => g.id);
    expect(globalIds).toContain('server');
    expect(globalIds).toContain('security');

    // Check structure of first global group
    const firstGroup = body.schema.global[0];
    expect(firstGroup.id).toBeDefined();
    expect(firstGroup.label).toBeDefined();
    expect(Array.isArray(firstGroup.fields)).toBe(true);
    expect(firstGroup.fields[0].key).toBeDefined();
    expect(firstGroup.fields[0].type).toBeDefined();

    // Agent schema
    expect(body.schema.agent).toBeDefined();
    expect(Array.isArray(body.schema.agent.info)).toBe(true);
    expect(Array.isArray(body.schema.agent.features)).toBe(true);
    expect(Array.isArray(body.schema.agent.conversations)).toBe(true);
    expect(body.schema.agent.channels.discord).toBeDefined();
    expect(body.schema.agent.channels.telegram).toBeDefined();
    expect(Array.isArray(body.schema.agent.groupConfig)).toBe(true);
  });

  it('PUT /api/v1/config returns 401 without API key', async () => {
    const res = await request(port, 'PUT', '/api/v1/config', '{"config":{}}', {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(401);
  });

  it('PUT /api/v1/config returns 400 without config object', async () => {
    const res = await request(port, 'PUT', '/api/v1/config', '{"notconfig":true}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('config');
  });
});

describe('deepMergeConfig', () => {
  it('merges top-level scalar changes', () => {
    const target = { server: { mode: 'docker', baseUrl: 'http://old' } };
    const source = { server: { baseUrl: 'http://new' } };
    const result = deepMergeConfig(target, source);
    expect(result.server.mode).toBe('docker');
    expect(result.server.baseUrl).toBe('http://new');
  });

  it('removes keys set to null', () => {
    const target = { server: { mode: 'docker', logLevel: 'debug' } };
    const source = { server: { logLevel: null } };
    const result = deepMergeConfig(target, source);
    expect(result.server.mode).toBe('docker');
    expect(result.server.logLevel).toBeUndefined();
  });

  it('skips masked sensitive values', () => {
    const target = { server: { apiKey: 'real-key' } };
    const source = { server: { apiKey: '••••••' } };
    const result = deepMergeConfig(target, source);
    expect(result.server.apiKey).toBe('real-key');
  });

  it('merges agents array element-by-element without nuking unset fields', () => {
    const target = {
      agents: [
        {
          name: 'LettaBot',
          channels: {
            discord: { enabled: true, token: 'secret-tok', streaming: true },
            telegram: { enabled: true, token: 'tg-tok' },
          },
          features: { cron: true, heartbeat: { enabled: true, intervalMin: 30 } },
          conversations: { mode: 'shared' },
        },
      ],
    };
    const source = {
      agents: [
        {
          features: { syncSystemPrompt: true },
          channels: { discord: { memberEvents: true } },
        },
      ],
    };
    const result = deepMergeConfig(target, source);

    // Original agent data preserved
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe('LettaBot');
    expect(result.agents[0].channels.discord.token).toBe('secret-tok');
    expect(result.agents[0].channels.discord.streaming).toBe(true);
    expect(result.agents[0].channels.discord.enabled).toBe(true);
    expect(result.agents[0].channels.telegram.token).toBe('tg-tok');
    expect(result.agents[0].features.cron).toBe(true);
    expect(result.agents[0].features.heartbeat.enabled).toBe(true);
    expect(result.agents[0].features.heartbeat.intervalMin).toBe(30);
    expect(result.agents[0].conversations.mode).toBe('shared');

    // New values applied
    expect(result.agents[0].features.syncSystemPrompt).toBe(true);
    expect(result.agents[0].channels.discord.memberEvents).toBe(true);
  });

  it('preserves other agents when only one is modified', () => {
    const target = {
      agents: [
        { name: 'Bot1', channels: { discord: { token: 'tok1' } } },
        { name: 'Bot2', channels: { telegram: { token: 'tok2' } } },
      ],
    };
    const source = {
      agents: [
        { features: { cron: true } },
      ],
    };
    const result = deepMergeConfig(target, source);

    expect(result.agents).toHaveLength(2);
    expect(result.agents[0].name).toBe('Bot1');
    expect(result.agents[0].channels.discord.token).toBe('tok1');
    expect(result.agents[0].features.cron).toBe(true);
    // Second agent untouched
    expect(result.agents[1].name).toBe('Bot2');
    expect(result.agents[1].channels.telegram.token).toBe('tok2');
  });
});
