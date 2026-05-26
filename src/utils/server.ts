/**
 * Letta server URL utilities.
 *
 * Lettabot only knows how to talk to a self-hosted Letta server at a URL the
 * operator provides. Defaults to localhost when nothing is configured.
 */

export const DEFAULT_LETTA_BASE_URL = 'http://localhost:8283';

/**
 * Resolve the configured Letta server URL, falling back to localhost.
 */
export function resolveLettaBaseUrl(configuredBaseUrl?: string | null): string {
  const url =
    configuredBaseUrl ||
    process.env.LETTA_BASE_URL ||
    DEFAULT_LETTA_BASE_URL;
  return url.replace(/\/$/, '');
}
