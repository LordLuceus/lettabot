/**
 * Shared utilities for model selection UI.
 *
 * Lettabot fetches the available model list from the configured Letta server.
 * The static `models.json` catalog is used as a fallback hint for the default
 * model handle.
 */

import type * as p from '@clack/prompts';
import modelsData from '../models.json' with { type: 'json' };

export const models = modelsData as ModelInfo[];

export interface ModelInfo {
  id: string;
  handle: string;
  label: string;
  description: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
}

/**
 * Get a sensible default model handle from the static catalog.
 */
export function getDefaultModelHandle(): string {
  const defaultModel = models.find(m => m.isDefault);
  return defaultModel?.handle ?? models[0]?.handle ?? 'anthropic/claude-sonnet-4-5-20250929';
}

/**
 * Build model selection options by listing models on the configured server.
 * Falls back to an empty "custom only" list if the server is unreachable.
 */
export async function buildModelOptions(): Promise<Array<{ value: string; label: string; hint: string }>> {
  const { listModels } = await import('../tools/letta-api.js');

  const serverModels = await listModels().catch(() => []);

  const result: Array<{ value: string; label: string; hint: string }> = [];

  // Sort by display name for readability.
  const sorted = serverModels.sort((a, b) =>
    (a.display_name || a.name).localeCompare(b.display_name || b.name)
  );

  result.push(...sorted.map(m => ({
    value: m.handle,
    label: m.display_name || m.name,
    hint: m.handle,
  })));

  // Add custom option so operators can always type a handle by hand.
  result.push({
    value: '__custom__',
    label: 'Other (specify handle)',
    hint: 'e.g. anthropic/claude-sonnet-4-5-20250929',
  });

  return result;
}

/**
 * Handle model selection including custom input.
 * Returns the selected model handle or null if cancelled/header selected.
 */
export async function handleModelSelection(
  selection: string | symbol,
  promptFn: typeof p.text,
): Promise<string | null> {
  const p = await import('@clack/prompts');
  if (p.isCancel(selection)) return null;

  if (selection === '__custom__') {
    const custom = await promptFn({
      message: 'Model handle',
      placeholder: 'provider/model-name (e.g., anthropic/claude-sonnet-4-5-20250929)',
    });
    if (p.isCancel(custom) || !custom) return null;
    return custom as string;
  }

  return selection as string;
}
