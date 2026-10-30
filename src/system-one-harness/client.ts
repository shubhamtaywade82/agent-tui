/**
 * OllamaClient factory for the harness. Centralizes baseUrl/apiKey/
 * endpoints resolution so the harness, the tool gate, and the MCP
 * bridge all share one client instance (and therefore one connection
 * pool, one retry config, and one HA failover registry).
 */

import { OllamaClient, type OllamaEndpoint } from '@nemesis-oss/ollama-sdk';

import type { HarnessConfig } from './config.js';

/**
 * Construct an {@link OllamaClient} from a {@link HarnessConfig}.
 *
 * - Single-endpoint mode (default): `baseUrl` + optional `apiKey` for
 *   `:cloud` models.
 * - HA failover mode: when `config.endpoints` has 2+ entries, the SDK's
 *   `EndpointRegistry` round-robins on retryable failures (5xx, network
 *   errors). Order = priority.
 *
 * The client is the only Ollama-side dependency the harness holds —
 * pass the same instance to {@link CoHostedAgentHarness},
 * {@link evaluateToolCallGate}, and {@link attachMcpServer}.
 */
export function createHarnessClient(config: HarnessConfig): OllamaClient {
  if (config.endpoints && config.endpoints.length > 0) {
    const endpoints: OllamaEndpoint[] = config.endpoints.map((url, i) => ({
      // EndpointRegistry requires a name — derive one from the URL host
      // so it shows up legibly in HA failover logs.
      name: `endpoint-${i}-${new URL(url).host}`,
      baseUrl: url,
      apiKey: config.apiKey,
    }));
    return new OllamaClient({ endpoints });
  }
  return new OllamaClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
}
