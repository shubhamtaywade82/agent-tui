/**
 * Web search and page fetch tools, backed by Ollama Cloud's hosted `web_search`
 * and `web_fetch` endpoints. The tool definitions, schemas, and output trimming
 * come from `createWebTools` in @nemesis-oss/ollama-sdk.
 *
 * Requires OLLAMA_API_KEY in .env. Calls always go to https://ollama.com,
 * regardless of the local Ollama host or the active chat provider.
 */
import {
  createWebTools,
  OllamaClient,
  type WebFetchRequestOptions,
  type WebFetchResponse,
  type WebSearchRequestOptions,
  type WebSearchResponse,
  type WebToolsClient,
} from '@nemesis-oss/ollama-sdk';
import { loadConfig } from '../config.js';

let cloud: { key: string; client: OllamaClient } | null = null;

function requireCloudClient(): OllamaClient {
  const apiKey = loadConfig().provider.ollama.apiKey;
  if (!apiKey) throw new Error('Web tools require OLLAMA_API_KEY (Ollama Cloud) in .env.');
  if (cloud?.key !== apiKey) cloud = { key: apiKey, client: new OllamaClient({ apiKey }) };
  return cloud.client;
}

/** The two OllamaClient methods the web tools need. */
export interface CloudWebApi {
  webSearch(req: { query: string; max_results?: number }): Promise<WebSearchResponse>;
  webFetch(req: { url: string }): Promise<WebFetchResponse>;
}

/**
 * Adapter between `createWebTools` and the cloud client. It forwards only the
 * documented request fields. The SDK's `webSearch` and `webFetch` serialize the whole
 * request object into the JSON body, so the `signal` that `createWebTools` passes
 * through would be sent as `"signal":{}`. Cancellation still happens at the
 * tool-registry level through `timeoutMs`.
 */
export function createCloudWebClient(cloud: () => CloudWebApi): WebToolsClient {
  return {
    webSearch(req: WebSearchRequestOptions): Promise<WebSearchResponse> {
      return cloud().webSearch({
        query: req.query,
        ...(req.max_results !== undefined ? { max_results: req.max_results } : {}),
      });
    },
    webFetch(req: WebFetchRequestOptions): Promise<WebFetchResponse> {
      return cloud().webFetch({ url: req.url });
    },
  };
}

/** `web_search` and `web_fetch`, ready to register. */
export const webTools = createWebTools(createCloudWebClient(requireCloudClient), { timeoutMs: 30_000 });
