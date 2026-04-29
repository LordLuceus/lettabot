import { describe, it, expect } from 'vitest';
import { deepMergeConfig } from './mutations.js';

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
