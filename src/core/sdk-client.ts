/**
 * Shared Letta Code SDK client.
 *
 * WHY THIS EXISTS
 * ---------------
 * SDK >= 0.2.x changed the DEFAULT local transport from stdio to an
 * "app-server" WebSocket. The bare `createSession()` / `resumeSession()` /
 * `createAgent()` helpers therefore try to open a local WebSocket, which fails
 * outright in lettabot's environment:
 *
 *   App-server WebSocket failed to open: [object ErrorEvent]
 *
 * lettabot runs the CLI as a long-lived child process per conversation and
 * relies on the stdio transport (and on Session-class methods such as
 * initialize() / bootstrapState()). Routing every SDK entry point through one
 * explicitly stdio-configured client keeps that behaviour pinned in a single
 * place instead of depending on an SDK default that has already changed once.
 */

import {
  LettaCodeClient,
  type CreateAgentOptions,
  type LettaCodeClientSessionOptions,
  type Session,
} from "@letta-ai/letta-code-sdk";

/**
 * The SDK factories declare the narrower `LettaCodeSession` interface, but at
 * runtime the local stdio backend returns a real `Session` instance
 * (LettaCodeClient does `new Session(...)`). We depend on Session-only methods
 * (initialize(), bootstrapState()), so narrow the declared type back here --
 * in one place, rather than casting at every call site.
 */
type SdkSessionFactoryResult = ReturnType<LettaCodeClient["createSession"]>;

const asSession = (session: SdkSessionFactoryResult): Session =>
  session as unknown as Session;

let client: LettaCodeClient | undefined;

/**
 * Lazily-constructed singleton client pinned to the local stdio transport.
 */
export function getSdkClient(): LettaCodeClient {
  if (!client) {
    client = new LettaCodeClient({ backend: "local", transport: "stdio" });
  }
  return client;
}

/** Create a NEW conversation for an existing agent (stdio transport). */
export function createSdkSession(
  agentId: string,
  options?: LettaCodeClientSessionOptions,
): Session {
  return asSession(getSdkClient().createSession(agentId, options));
}

/**
 * Resume an existing conversation (stdio transport).
 * `id` may be an agent ID (resumes its default conversation) or a
 * conversation ID.
 */
export function resumeSdkSession(
  id: string,
  options?: LettaCodeClientSessionOptions,
): Session {
  return asSession(getSdkClient().resumeSession(id, options));
}

/** Create a brand new agent (stdio transport). Returns the new agent ID. */
export function createSdkAgent(options?: CreateAgentOptions): Promise<string> {
  return getSdkClient().createAgent(options);
}
