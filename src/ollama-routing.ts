/**
 * Ollama model routing: upfront task scoring, optional router model, mid-run escalation.
 */

import type { AgentConfig } from './config.js';

const HEAVY_TASK = [
  { re: /\b(refactor|rewrite|re-?architect|migration|codebase)\b/i, w: 0.3 },
  { re: /\b(debug|diagnose|root cause|investigate)\b/i, w: 0.2 },
  { re: /\b(implement|build|scaffold|multi[- ]?step)\b/i, w: 0.15 },
  { re: /\b(production|deploy|security audit)\b/i, w: 0.25 },
];

export type { OllamaRouterBackend } from './ollama-endpoints.js';

export interface ModelPick {
  model: string;
  tier: 'local' | 'cloud' | 'explicit';
  reason: string;
}

export interface OllamaRunRoutingState {
  iterations: number;
  toolCalls: number;
  loopBlocks: number;
  escalated: boolean;
}

export function createOllamaRunRoutingState(): OllamaRunRoutingState {
  return { iterations: 0, toolCalls: 0, loopBlocks: 0, escalated: false };
}

export function taskScore(prompt: string, toolCount = 0): number {
  let s = 0;
  for (const t of HEAVY_TASK) {
    if (t.re.test(prompt)) s += t.w;
  }
  if (prompt.length > 1200) s += 0.15;
  else if (prompt.length > 500) s += 0.08;
  if (toolCount >= 8) s += 0.2;
  else if (toolCount >= 4) s += 0.1;
  return Math.min(1, s);
}

function modelOnCloud(model: string, cfg: AgentConfig): boolean {
  const cloud = cfg.provider.ollama.cloudModels;
  if (!cloud.length) return Boolean(cfg.provider.ollama.apiKey);
  return cloud.includes(model);
}

function routerPrompt(task: string): string {
  return `Classify if this coding task needs a large cloud model or a small local model.
Reply with exactly one word: local or cloud

Task: ${task.slice(0, 900)}`;
}

export async function classifyWithRouter(
  generate: (prompt: string) => Promise<string>,
  task: string,
): Promise<'local' | 'cloud'> {
  const raw = (await generate(routerPrompt(task))).trim().toLowerCase();
  return raw.includes('cloud') ? 'cloud' : 'local';
}

function shouldAskRouter(cfg: AgentConfig, score: number): boolean {
  const o = cfg.provider.ollama;
  if (!o.routerModel || o.routerBackend === 'heuristic') return false;
  if (o.routerBackend === 'model') return true;
  const lo = o.autoEscalateScore - 0.12;
  const hi = o.autoEscalateScore;
  return score >= lo && score < hi;
}

/** Resolve model at run start (sync heuristics; optional async router). */
export async function resolveOllamaModelForTaskAsync(
  cfg: AgentConfig,
  prompt: string,
  opts: {
    explicitModel?: string;
    toolCount?: number;
    routerGenerate?: (prompt: string) => Promise<string>;
  } = {},
): Promise<ModelPick> {
  const base = resolveOllamaModelForTask(cfg, prompt, opts);
  const o = cfg.provider.ollama;
  if (base.tier === 'cloud' || base.reason === 'explicit model' || o.routingMode !== 'auto') {
    return base;
  }
  if (!shouldAskRouter(cfg, taskScore(prompt, opts.toolCount ?? 0)) || !opts.routerGenerate || !o.cloudDefaultModel) {
    return base;
  }
  try {
    const verdict = await classifyWithRouter(opts.routerGenerate, prompt);
    if (verdict === 'cloud') {
      return { model: o.cloudDefaultModel, tier: 'cloud', reason: `router (${o.routerModel})` };
    }
  } catch {
    // Router failure — keep heuristic pick.
  }
  return base;
}

/** Sync pick (no router model call). */
export function resolveOllamaModelForTask(
  cfg: AgentConfig,
  prompt: string,
  opts: { explicitModel?: string; toolCount?: number } = {},
): ModelPick {
  const o = cfg.provider.ollama;
  const explicit = opts.explicitModel?.trim();
  if (explicit && explicit !== 'auto') {
    return {
      model: explicit,
      tier: modelOnCloud(explicit, cfg) ? 'cloud' : 'local',
      reason: 'explicit model',
    };
  }

  const baseModel = explicit === 'auto' ? o.defaultModel : (explicit || o.defaultModel);

  if (o.routingMode === 'cloud-first' && o.apiKey && o.cloudDefaultModel) {
    return { model: o.cloudDefaultModel, tier: 'cloud', reason: 'cloud-first' };
  }

  if (o.routingMode !== 'auto' || !o.apiKey) {
    return {
      model: baseModel,
      tier: modelOnCloud(baseModel, cfg) ? 'cloud' : 'local',
      reason: o.routingMode,
    };
  }

  const score = taskScore(prompt, opts.toolCount ?? 0);
  if (score >= o.autoEscalateScore && o.cloudDefaultModel) {
    return {
      model: o.cloudDefaultModel,
      tier: 'cloud',
      reason: `auto escalate (score ${score.toFixed(2)} ≥ ${o.autoEscalateScore})`,
    };
  }

  return { model: baseModel, tier: 'local', reason: `auto local (score ${score.toFixed(2)})` };
}

/** Upgrade local → cloud mid-run when work is dragging (tools / iterations / loops). */
export function maybeEscalateOllamaModel(
  cfg: AgentConfig,
  state: OllamaRunRoutingState,
  currentModel: string,
  explicitModel?: string,
): ModelPick | null {
  const o = cfg.provider.ollama;
  if (explicitModel || state.escalated || o.routingMode !== 'auto' || !o.apiKey || !o.cloudDefaultModel) {
    return null;
  }
  if (currentModel === o.cloudDefaultModel) {
    state.escalated = true;
    return null;
  }

  const reasons: string[] = [];
  if (state.toolCalls >= o.escalateAfterTools) reasons.push(`${state.toolCalls} tool calls`);
  if (state.iterations >= o.escalateAfterIterations) reasons.push(`${state.iterations} iterations`);
  if (state.loopBlocks >= 2) reasons.push(`${state.loopBlocks} loop-guard blocks`);

  if (!reasons.length) return null;

  state.escalated = true;
  return {
    model: o.cloudDefaultModel,
    tier: 'cloud',
    reason: `mid-run escalate (${reasons.join(', ')})`,
  };
}
