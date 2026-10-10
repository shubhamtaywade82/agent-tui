/**
 * Shared Ollama local + cloud endpoint wiring for TUI, agent, and providers.
 */

import { OLLAMA_CLOUD_BASE_URL } from '@nemesis-oss/ollama-sdk';

export type OllamaRoutingMode = 'local-first' | 'cloud-first' | 'auto';

export interface OllamaEndpointWire {
  name: string;
  baseUrl: string;
  apiKey?: string;
  priority?: number;
  models?: readonly string[];
}

export interface OllamaEndpointBuildInput {
  localHost: string;
  cloudBaseUrl: string;
  apiKey?: string;
  cloudModels: string[];
  localModels: string[];
  routingMode: OllamaRoutingMode;
}

export function buildOllamaEndpoints(input: OllamaEndpointBuildInput): OllamaEndpointWire[] {
  const localPri = input.routingMode === 'cloud-first' ? 5 : 10;
  const cloudPri = input.routingMode === 'cloud-first' ? 10 : 5;

  const endpoints: OllamaEndpointWire[] = [
    {
      name: 'local',
      baseUrl: input.localHost,
      priority: localPri,
      ...(input.localModels.length ? { models: input.localModels } : {}),
    },
  ];

  if (input.apiKey) {
    endpoints.push({
      name: 'cloud',
      baseUrl: input.cloudBaseUrl,
      apiKey: input.apiKey,
      priority: cloudPri,
      ...(input.cloudModels.length ? { models: input.cloudModels } : {}),
    });
  }

  return endpoints;
}

export function buildOllamaClientOptions(input: OllamaEndpointBuildInput, wallTimeMs: number) {
  return {
    endpoints: buildOllamaEndpoints(input),
    timeoutMs: wallTimeMs,
    retries: 3,
    endpointHealth: {
      strategy: 'least-connections' as const,
      maxConcurrentPerEndpoint: 4,
    },
  };
}

export { OLLAMA_CLOUD_BASE_URL };
