/**
 * Model catalog + auto-pick logic. The harness walks an ordered catalog
 * and selects the first model installed on the daemon via `ollama list`
 * (`client.models.list()`). This lets the same code run on any operator's
 * machine without code changes — they just `ollama pull` whichever <4B
 * controller they prefer and the harness picks it up.
 */

import type { OllamaClient } from '@nemesis-oss/ollama-sdk';

/**
 * List the model tags installed on the local Ollama daemon (`/api/tags`),
 * not just the ones currently resident in VRAM. Returns an empty array
 * when the daemon is unreachable so the auto-pick falls through to a
 * helpful error rather than crashing.
 */
export async function listLocalModels(client: OllamaClient): Promise<string[]> {
  try {
    const models = await client.models.list();
    return models.map((m) => m.name);
  } catch {
    return [];
  }
}

/**
 * Walk `catalog` in order and return the first model that appears in
 * `available`. When nothing matches, throws a {@link NoModelAvailableError}
 * listing the missing pulls the operator needs to run.
 */
export function pickFirstAvailable(
  catalog: readonly string[],
  available: readonly string[],
): string {
  for (const candidate of catalog) {
    if (available.includes(candidate)) return candidate;
  }
  throw new NoModelAvailableError(catalog, available);
}

/**
 * Auto-pick both System 1 and System 2 models in one daemon round-trip.
 * Honors pinned overrides from the config (`systemOneModel` /
 * `systemTwoModel`) — when set, the catalog is skipped entirely.
 */
export async function resolveModels(
  client: OllamaClient,
  config: {
    systemOneModel?: string;
    systemOneCatalog: readonly string[];
    systemTwoModel?: string;
    systemTwoCatalog: readonly string[];
  },
): Promise<{ systemOne: string; systemTwo: string; available: string[] }> {
  const available = await listLocalModels(client);
  const systemOne =
    config.systemOneModel && available.includes(config.systemOneModel)
      ? config.systemOneModel
      : config.systemOneModel && !available.includes(config.systemOneModel)
        ? (() => {
            throw new NoModelAvailableError([config.systemOneModel], available);
          })()
        : pickFirstAvailable(config.systemOneCatalog, available);
  const systemTwo = config.systemTwoModel
    ? config.systemTwoModel
    : pickFirstAvailable(config.systemTwoCatalog, available);
  return { systemOne, systemTwo, available };
}

/**
 * Raised when no catalog model is locally available. The message lists
 * the exact `ollama pull` commands to run, so an operator hitting this
 * for the first time can fix it in one paste.
 */
export class NoModelAvailableError extends Error {
  constructor(
    private readonly catalog: readonly string[],
    private readonly available: readonly string[],
  ) {
    const pulls = catalog.map((m) => `  ollama pull ${m}`).join('\n');
    super(
      `No catalog model is locally available.\n` +
        `Catalog tried (in order): ${catalog.join(', ')}\n` +
        `Locally available: ${available.length > 0 ? available.join(', ') : '(none — is ollama running?)'}\n` +
        `Pull one and retry:\n${pulls}`,
    );
    this.name = 'NoModelAvailableError';
  }
}
