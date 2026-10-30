/**
 * CoHostedAgentHarness — the 3-stage turn controller from §2.
 *
 *   STAGE 1 — System 1 routes the prompt to a domain (`client.decision.route`).
 *   STAGE 2 — System 2 runs an autonomous tool loop against the domain's
 *             scoped ToolRegistry (`Agent.run`). Bypassed for `direct_reply`.
 *   STAGE 3 — System 1 verifies the answer before it is returned
 *             (`client.decision.verify`).
 *
 * Both models are kept pinned in VRAM via `keepAlive: KEEP_ALIVE_INDEFINITE`
 * (-1) so the co-hosted pair stays resident across turns — System 1's
 * ~1 GB footprint plus System 2's footprint fit an 8 GB GPU when S2 is
 * also <4B (see the catalog in config.ts).
 */

import { Agent, KEEP_ALIVE_INDEFINITE, type OllamaClient } from '@nemesis-oss/ollama-sdk';

import { resolveModels } from './catalog.js';
import type { HarnessConfig } from './config.js';
import type { DomainRoute, HarnessResult } from './types.js';

/**
 * The harness. Construct once per process; the {@link OllamaClient} it
 * holds keeps the connection pool, retry config, and (when configured) HA
 * failover registry alive across turns.
 */
export class CoHostedAgentHarness {
  private readonly client: OllamaClient;
  private readonly config: HarnessConfig;
  private readonly registries: Record<string, import('@nemesis-oss/ollama-sdk').ToolRegistry>;
  private resolvedModels?: { systemOne: string; systemTwo: string };

  constructor(
    client: OllamaClient,
    config: HarnessConfig,
    registries: Record<string, import('@nemesis-oss/ollama-sdk').ToolRegistry>,
  ) {
    this.client = client;
    this.config = config;
    this.registries = registries;
  }

  /**
   * Verify both System 1 and System 2 models are resident in VRAM via
   * `GET /api/ps` (`client.models.ps()`). Returns which models are loaded
   * so an operator can confirm co-hosting before serving traffic.
   */
  async verifyCoHosting(): Promise<{
    systemOneLoaded: boolean;
    systemTwoLoaded: boolean;
    loaded: string[];
  }> {
    const { systemOne, systemTwo } = await this.resolveModels();
    const ps = await this.client.models.ps();
    const loaded = ps.models.map((m) => m.name);
    return {
      systemOneLoaded: loaded.includes(systemOne),
      systemTwoLoaded: loaded.includes(systemTwo),
      loaded,
    };
  }

  /**
   * Run one full 3-stage turn. The returned {@link HarnessResult} carries
   * the routing decision, verification outcome, and final answer — enough
   * for a caller to log or display the turn without re-running it.
   *
   * @throws when System 1's verification gate rejects the answer (probability
   *   below `minVerifyProbability`). The error message includes the
   *   probability so the caller can decide whether to retry or surface.
   */
  async runTurn(userPrompt: string): Promise<HarnessResult> {
    const { systemOne, systemTwo } = await this.resolveModels();

    // ── STAGE 1: System 1 routing with confidence gate ──────────────
    const routeResult = await this.client.decision.route<DomainRoute>({
      model: systemOne,
      keepAlive: this.config.keepAlive,
      state: { prompt: userPrompt },
      instructions: 'Which specialist domain should handle `prompt`?',
      criteria: {
        market_data: 'Fetching live Binance klines, orderbook, or funding rates',
        backtest: 'Running historical strategy backtests or parameter optimization',
        direct_reply: 'General questions requiring no external tools',
      },
      minConfidence: this.config.minRouteConfidence,
    });

    const routeConfident = routeResult.isConfident ?? false;
    const route = routeResult.route;

    // Bypass the tool loop when the gate fails OR System 1 routes to
    // direct_reply — both mean "no specialist tools needed".
    if (!routeConfident || route === 'direct_reply') {
      const answer = await this.client.chatText({
        model: systemTwo,
        keep_alive: this.config.keepAlive,
        messages: [{ role: 'user', content: userPrompt }],
        options: { num_ctx: this.config.contextWindow },
      });
      return {
        answer,
        route: 'direct_reply',
        routeConfidence: routeResult.confidence,
        routeConfident,
        // The bypass path skips verification — there is no tool-sourced
        // claim to verify, just a direct LLM reply. Surface 0 + verified=true
        // so the result shape stays consistent for callers.
        verifyProbability: 0,
        verified: true,
        iterations: 0,
        systemOneModel: systemOne,
        systemTwoModel: systemTwo,
      };
    }

    const activeRegistry = this.registries[route];
    if (!activeRegistry) {
      // The config allowed a route the registries map doesn't cover. Fall
      // back to direct_reply rather than crashing — the operator's
      // registries are the source of truth for what the harness can do.
      const answer = await this.client.chatText({
        model: systemTwo,
        keep_alive: this.config.keepAlive,
        messages: [{ role: 'user', content: userPrompt }],
        options: { num_ctx: this.config.contextWindow },
      });
      return {
        answer,
        route: 'direct_reply',
        routeConfidence: routeResult.confidence,
        routeConfident,
        verifyProbability: 0,
        verified: true,
        iterations: 0,
        systemOneModel: systemOne,
        systemTwoModel: systemTwo,
      };
    }

    // ── STAGE 2: System 2 autonomous Agent loop with scoped registry ──
    const agent = new Agent(this.client, {
      tools: activeRegistry,
      maxIterations: this.config.maxIterations,
      maxToolCalls: this.config.maxToolCalls,
    });
    // Note: AgentRunInput does not expose keep_alive — the Agent's internal
    // chat calls use the server default. System 1 stays pinned via the
    // decision.route/verify calls (which do set keepAlive), and System 2
    // stays warm during the multi-turn loop because turns are rapid.
    const agentResult = await agent.run({
      model: systemTwo,
      messages: [{ role: 'user', content: userPrompt }],
      options: {
        num_ctx: this.config.contextWindow,
        temperature: this.config.temperature,
      },
    });
    const agentAnswer = agentResult.finalMessage.content;

    // ── STAGE 3: System 1 post-generation verification ──────────────
    const verification = await this.client.decision.verify({
      model: systemOne,
      keepAlive: this.config.keepAlive,
      claim: agentAnswer,
      evidence: userPrompt,
      instructions:
        'Does `claim` directly and accurately address `evidence` without fabricated numbers?',
      minProbability: this.config.minVerifyProbability,
    });

    if (!verification.verified) {
      throw new VerificationGateError(
        verification.probability,
        this.config.minVerifyProbability,
        agentAnswer,
      );
    }

    return {
      answer: agentAnswer,
      route,
      routeConfidence: routeResult.confidence,
      routeConfident,
      verifyProbability: verification.probability,
      verified: true,
      iterations: agentResult.totalIterations,
      systemOneModel: systemOne,
      systemTwoModel: systemTwo,
    };
  }

  /**
   * Resolve (and cache) the System 1 + System 2 model names. The first call
   * hits `ollama list`; subsequent turns reuse the cached names so the
   * daemon round-trip happens once per harness lifetime.
   */
  private async resolveModels(): Promise<{ systemOne: string; systemTwo: string }> {
    if (this.resolvedModels) return this.resolvedModels;
    this.resolvedModels = await resolveModels(this.client, this.config);
    return this.resolvedModels;
  }
}

/**
 * Raised when System 1's verification gate rejects System 2's answer.
 * Carries the rejected answer and the probability so the caller can
 * decide whether to retry with a lower threshold or surface the failure.
 */
export class VerificationGateError extends Error {
  constructor(
    public readonly probability: number,
    public readonly threshold: number,
    public readonly rejectedAnswer: string,
  ) {
    super(
      `System 1 Verification Gate rejected answer (P=${probability.toFixed(3)} < threshold ${threshold})`,
    );
    this.name = 'VerificationGateError';
  }
}

/** Re-export the keep-alive constant for callers building their own configs. */
export { KEEP_ALIVE_INDEFINITE };
