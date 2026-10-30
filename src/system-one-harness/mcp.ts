/**
 * MCP HTTP bridge (§4 in the reference). Connects a remote MCP server,
 * bridges its tools into a local {@link ToolRegistry}, and (optionally)
 * uses `client.decision.rank` to triage which bridged tools are relevant
 * to the current prompt before handing the registry to an Agent.
 *
 * The bridge is transport-agnostic at the registry level — once tools
 * are registered, the Agent treats them identically to native tools.
 * The decision gate (`evaluateToolCallGate` in tool-gate.ts) applies
 * to them too, so a bridged tool that fails the injection/alignment/
 * blast-radius check is rejected just like a native one.
 */

import {
  McpBridge,
  type OllamaClient,
  type ToolDefinition,
  type ToolRegistry,
} from '@nemesis-oss/ollama-sdk';
import { connectMcpHttpClient } from '@nemesis-oss/ollama-sdk/mcp/http';

export interface AttachMcpOptions {
  /** Abort signal forwarded to the bridge's `register` call. */
  readonly signal?: AbortSignal;
}

/**
 * Connect to a remote MCP HTTP server and bridge its tools into `registry`.
 * Returns the underlying {@link HttpMcpConnection} so the caller can close
 * it later; the {@link McpBridge} used internally is also returned for
 * `refresh()` calls (the MCP spec lets servers add tools dynamically).
 *
 * @example
 *   const registry = new ToolRegistry();
 *   const { connection, bridge } = await attachMcpServer(registry, 'http://localhost:8080/mcp');
 *   // ... use registry with an Agent ...
 *   await bridge.refresh(registry);  // pick up newly-published tools
 *   await connection.close();
 */
export async function attachMcpServer(
  registry: ToolRegistry,
  url: string,
  _options: AttachMcpOptions = {},
): Promise<{
  connection: import('@nemesis-oss/ollama-sdk/mcp/http').HttpMcpConnection;
  bridge: McpBridge;
}> {
  const connection = await connectMcpHttpClient({ url });
  // HttpMcpConnection exposes the underlying McpClientLike on `.client`;
  // McpBridge wraps it to translate MCP tool descriptors into SDK Tools
  // and register them on a ToolRegistry.
  const bridge = new McpBridge(connection.client);
  await bridge.register(registry, _options.signal);
  return { connection, bridge };
}

/**
 * Use System 1 (`client.decision.rank`) to triage which tools in a
 * registry are relevant to `prompt`. Returns the tool definitions sorted
 * by relevance score descending, so an Agent can be handed a pre-filtered
 * registry (or the caller can log which tools were considered).
 *
 * Note: `decision.rank` issues one System One call per candidate (N
 * parallel requests). For large registries, prefer a single `choice`
 * question with all tools as options instead — see the SDK docs.
 */
export async function rankToolsForPrompt(
  client: OllamaClient,
  model: string,
  prompt: string,
  tools: readonly ToolDefinition[],
  options: { keepAlive?: number; minConfidence?: number; signal?: AbortSignal } = {},
): Promise<ReadonlyArray<{ tool: ToolDefinition; score: number; confident: boolean }>> {
  if (tools.length === 0) return [];
  const candidates = tools.map((t) => ({
    id: t.function.name,
    state: {
      prompt,
      tool_name: t.function.name,
      tool_description: t.function.description ?? '',
    },
  }));
  const ranked = await client.decision.rank<string>({
    model,
    keepAlive: options.keepAlive,
    instructions: 'How relevant is `tool` to `prompt`?',
    criteria: [
      '0: Tool is irrelevant to the prompt',
      '1: Tool is tangentially relevant',
      '2: Tool directly addresses the prompt',
    ],
    candidates,
    ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
  });
  return ranked
    .map((r) => {
      // RankResult uses `candidate` (the id we passed in), not `id`.
      const tool = tools.find((t) => t.function.name === r.candidate);
      if (!tool) return null;
      return {
        tool,
        score: r.score,
        confident: r.isConfident ?? false,
      };
    })
    .filter((x): x is { tool: ToolDefinition; score: number; confident: boolean } => x !== null)
    .sort((a, b) => b.score - a.score);
}
