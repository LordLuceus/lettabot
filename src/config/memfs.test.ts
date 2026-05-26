import { describe, expect, it } from 'vitest';

import { resolveSessionMemfs } from './memfs.js';

describe('resolveSessionMemfs', () => {
  it('uses explicit agent config first', () => {
    const result = resolveSessionMemfs({
      configuredMemfs: true,
      envMemfs: 'false',
    });

    expect(result).toEqual({ value: true, source: 'config' });
  });

  it('uses LETTABOT_MEMFS env override when config is unset', () => {
    const result = resolveSessionMemfs({
      envMemfs: 'false',
    });

    expect(result).toEqual({ value: false, source: 'env' });
  });

  it('defaults to memfs disabled for self-hosted servers when unset', () => {
    const result = resolveSessionMemfs({});

    expect(result).toEqual({ value: false, source: 'default-self-hosted' });
  });

  it('ignores invalid LETTABOT_MEMFS values', () => {
    const result = resolveSessionMemfs({
      envMemfs: 'yes',
    });

    expect(result).toEqual({ value: false, source: 'default-self-hosted' });
  });

  it('treats null configured memfs as unset and applies self-hosted default', () => {
    const result = resolveSessionMemfs({
      configuredMemfs: null as unknown as boolean,
    });

    expect(result).toEqual({ value: false, source: 'default-self-hosted' });
  });
});
