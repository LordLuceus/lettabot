export type ResolvedMemfsSource = 'config' | 'env' | 'default-self-hosted';

export interface ResolveSessionMemfsInput {
  configuredMemfs?: boolean;
  envMemfs?: string;
}

export interface ResolveSessionMemfsResult {
  value: boolean;
  source: ResolvedMemfsSource;
}

function parseBooleanEnv(value?: string): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * Resolve the memfs value forwarded to SDK session options.
 *
 * Precedence:
 * 1) Per-agent config (`features.memfs`)
 * 2) `LETTABOT_MEMFS` env var (`true`/`false`)
 * 3) Default `false` (safety: self-hosted servers may not have memfs support)
 */
export function resolveSessionMemfs(input: ResolveSessionMemfsInput): ResolveSessionMemfsResult {
  // Runtime config parsing can surface non-boolean values (e.g. YAML `memfs:` -> null).
  // Only treat explicit booleans as configured; everything else falls through.
  if (typeof input.configuredMemfs === 'boolean') {
    return { value: input.configuredMemfs, source: 'config' };
  }

  const envMemfs = parseBooleanEnv(input.envMemfs);
  if (envMemfs !== undefined) {
    return { value: envMemfs, source: 'env' };
  }

  return { value: false, source: 'default-self-hosted' };
}
