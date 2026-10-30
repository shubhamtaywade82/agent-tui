/**
 * Public barrel for the System One co-hosted agent harness.
 *
 * Quick start:
 *
 *   import { createHarnessClient, loadHarnessConfigFromEnv, createDomainRegistries, CoHostedAgentHarness } from './system-one-harness/index.js';
 *
 *   const config = loadHarnessConfigFromEnv();
 *   const client = createHarnessClient(config);
 *   const registries = createDomainRegistries();
 *   const harness = new CoHostedAgentHarness(client, config, registries);
 *
 *   await harness.verifyCoHosting();   // confirm both models in VRAM
 *   const result = await harness.runTurn('Fetch BTCUSDT 1m klines and summarize the trend.');
 *   console.log(result.answer);
 *
 * See docs/system-one-harness/README.md for the full guide.
 */

export {
  listLocalModels,
  NoModelAvailableError,
  pickFirstAvailable,
  resolveModels,
} from './catalog.js';
export { createHarnessClient } from './client.js';
export {
  DEFAULT_CONFIG,
  DEFAULT_SYSTEM_ONE_CATALOG,
  DEFAULT_SYSTEM_TWO_CATALOG,
  type HarnessConfig,
  loadHarnessConfigFromEnv,
} from './config.js';
export { CoHostedAgentHarness, KEEP_ALIVE_INDEFINITE, VerificationGateError } from './harness.js';
export { attachMcpServer, rankToolsForPrompt } from './mcp.js';
export {
  createBacktestRegistry,
  createDomainRegistries,
  createMarketDataRegistry,
  toSdkTool,
} from './registries.js';
export {
  DEFAULT_BLAST_RADIUS_CRITERIA,
  DEFAULT_GATE_THRESHOLDS,
  evaluateToolCallGate,
  type ToolGateOptions,
} from './tool-gate.js';
export type { DomainRoute, HarnessResult, HarnessTool, ToolGateResult } from './types.js';
