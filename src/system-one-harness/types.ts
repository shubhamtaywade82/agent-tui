/**
 * Shared types for the System One co-hosted agent harness.
 *
 * @nemesis-oss/ollama-sdk ships the decision primitives (`client.decision.*`,
 * `client.systemOne`) and the Agent/ToolRegistry/McpBridge building blocks.
 * This harness composes them into a deterministic 3-stage turn:
 *
 *   1. System 1 routes the prompt to a domain (client.decision.route).
 *   2. System 2 runs an autonomous tool loop against a scoped registry (Agent).
 *   3. System 1 verifies the answer before it is returned (client.decision.verify).
 *
 * See docs/system-one-harness/README.md and ADR 0001 for the full design.
 */

import type { ZodType } from 'zod';

/**
 * Domain names the harness routes between. Each maps to a ToolRegistry
 * built by {@link createDomainRegistries}. `direct_reply` is the bypass
 * route — when System 1 picks it (or its confidence gate fails), the turn
 * skips the tool loop and answers directly from System 2.
 */
export type DomainRoute = 'market_data' | 'backtest' | 'direct_reply';

/**
 * Result of a single harness turn. Carries the routing decision, the
 * verification outcome, and the final answer string — enough for a caller
 * to log, display, or audit the turn without re-running it.
 */
export interface HarnessResult {
  /** The final answer text returned to the user. */
  readonly answer: string;
  /** Which domain System 1 routed to. `direct_reply` means the tool loop was skipped. */
  readonly route: DomainRoute;
  /** System 1's routing confidence (Shannon-normalized, 0–1). */
  readonly routeConfidence: number;
  /** Whether the routing confidence met the `minConfidence` gate. */
  readonly routeConfident: boolean;
  /** System 1's verification probability that the answer is correct (0–1). */
  readonly verifyProbability: number;
  /** Whether the verification probability met the `minProbability` gate. */
  readonly verified: boolean;
  /** Number of Agent iterations System 2 took (0 for `direct_reply`). */
  readonly iterations: number;
  /** Which System 1 model handled routing + verification. */
  readonly systemOneModel: string;
  /** Which System 2 model handled reasoning. */
  readonly systemTwoModel: string;
}

/**
 * Outcome of a multi-axis tool-call gate (§3 in the reference). The gate
 * evaluates alignment, injection risk, and blast radius in a single
 * batched `/v1/systemone` call before a sensitive tool is executed.
 */
export interface ToolGateResult {
  /** True when the call may proceed without human review. */
  readonly approved: boolean;
  /** Human-readable reason when `approved` is false. */
  readonly reason?: string;
  /**
   * When true the call is not outright rejected but must be confirmed by a
   * human operator first — set when `blast_radius >= riskCeiling` but
   * alignment is high and no injection is detected.
   */
  readonly requireHumanApproval?: boolean;
  /** The blast-radius score (0 = read-only, N-1 = production write). */
  readonly riskScore?: number;
  /** The injection probability System 1 returned (0–1). */
  readonly injectionProbability?: number;
  /** The alignment probability System 1 returned (0–1). */
  readonly alignmentProbability?: number;
}

/**
 * A tool definition suitable for {@link ToolRegistry.register}. Mirrors the
 * SDK's `AnyTool` shape so callers can build registries without importing
 * the SDK's internal types. Use {@link defineTool} from the SDK to build
 * one with full type inference from a Zod schema.
 */
export interface HarnessTool {
  readonly name: string;
  readonly description: string;
  readonly schema: ZodType<Record<string, unknown>>;
  readonly execute: (params: Record<string, unknown>) => Promise<unknown> | unknown;
  readonly timeoutMs?: number;
}
