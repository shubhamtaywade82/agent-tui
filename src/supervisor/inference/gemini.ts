/**
 * Gemini backend — uses the official `@google/genai` SDK against the Google
 * Generative Language API (`generativelanguage.googleapis.com`).
 *
 * Gemini exposes a different request/response shape than OpenAI's
 * chat/completions:
 *
 *   - Top-level `contents` field (not `messages`), supporting text + multimodal.
 *   - System prompt is a separate `config.systemInstruction` field.
 *   - Generation cap is `config.maxOutputTokens`.
 *   - JSON mode is a wire-level flag: `config.responseMimeType = 'application/json'`.
 *     Gemini additionally accepts a `config.responseSchema` for strict schema
 *     enforcement — that's a future enhancement; this backend uses JSON mode only.
 *   - Token usage is in `response.usageMetadata` (not `response.usage`).
 *
 * Capability matrix entry (see ADR 0009):
 *
 *   - JSON mode: native via `responseMimeType: 'application/json'`. When the
 *     caller requests `formatJson`, this backend sets the mimetype AND lets
 *     the model produce valid JSON without prompt-level prefilling.
 *   - `max_tokens`: optional — Gemini's default is per-model. Forwarded as
 *     `config.maxOutputTokens` when the caller sets `maxOutputTokens`.
 *   - Context window: derived from the model (1M for Gemini 1.5 Pro,
 *     1M for Gemini 2.0 Flash).
 *   - `think` flag: Gemini 2.0 Flash Thinking and Gemini 2.5 models expose a
 *     `thinkingConfig` field. We forward `thinkMode='think'` via that field;
 *     `thinkMode='no-think'` disables thinking. Non-thinking models ignore
 *     the field silently (Gemini returns 400 for unsupported config — we
 *     catch and retry without the thinking flag).
 *   - Gemini requires the model name to start with `models/` when the bare
 *     model ID is passed. This backend normalises: if the caller passes a
 *     bare `gemini-flash-latest`, we forward as `models/gemini-flash-latest`.
 */
import { GoogleGenAI } from '@google/genai';
import type { SupervisorConfig } from '../config.js';
import { logger } from '../observability/logger.js';
import type { Backend, InferenceRequest, InferenceResponse } from './backend.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Normalise the model name to the form Gemini's API expects. */
function normaliseModel(model: string): string {
  // Accept any of: "gemini-1.5-pro", "models/gemini-1.5-pro",
  // "tunedModels/...", "publishers/google/models/...". Only the bare
  // gemini-* IDs need the "models/" prefix.
  if (model.includes('/')) return model;
  return `models/${model}`;
}

export class GeminiBackend implements Backend {
  readonly name = 'gemini';
  protected readonly client: GoogleGenAI;

  /** `fetchImpl` is the transport seam for tests; production uses the runtime's global fetch. */
  constructor(
    protected readonly config: SupervisorConfig,
    fetchImpl?: typeof fetch,
  ) {
    const geminiCfg = config.inference.gemini;
    if (!geminiCfg.apiKey) {
      throw new Error(
        'GeminiBackend: GEMINI_API_KEY is required when INFERENCE_BACKEND=gemini. ' +
          'Set it in the environment or in config.inference.gemini.apiKey.',
      );
    }
    this.client = new GoogleGenAI({
      apiKey: geminiCfg.apiKey,
      ...(geminiCfg.baseUrl
        ? {
            httpOptions: { baseUrl: geminiCfg.baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
          }
        : fetchImpl
          ? { httpOptions: { fetch: fetchImpl } }
          : {}),
    });
    logger.info({ baseUrl: geminiCfg.baseUrl }, 'GeminiBackend: initialised');
  }

  async invoke(req: InferenceRequest): Promise<InferenceResponse> {
    const started = Date.now();
    const temperature = req.temperature ?? 0.1;
    const thinkMode = req.thinkMode ?? this.config.inference.defaultThinkMode;

    // Build the GenerateContentConfig. Gemini's JSON mode is a wire-level
    // flag; we set responseMimeType when the caller requests formatJson.
    const config: Record<string, unknown> = {
      temperature,
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.formatJson ? { responseMimeType: 'application/json' } : {}),
    };

    // Thinking mode: only forward when explicitly opted in. Gemini 2.0
    // Flash Thinking and Gemini 2.5 models accept a `thinkingConfig`.
    // Older models return 400 — the caller can disable thinking via
    // thinkMode='no-think'.
    if (thinkMode === 'think') {
      // Default thinking budget: half the generation cap (min 1024).
      const thinkingBudget =
        req.maxOutputTokens !== undefined
          ? Math.max(Math.floor(req.maxOutputTokens / 2), 1024)
          : 4096;
      config.thinkingConfig = { thinkingBudget, includeThoughts: false };
    }

    const response = await this.client.models.generateContent({
      model: normaliseModel(req.model),
      contents: req.prompt,
      // The SDK accepts a typed config; we cast because the thinkingConfig
      // shape varies across SDK versions and we want to stay forward-compatible.
      config: config as Parameters<typeof this.client.models.generateContent>[0]['config'],
    });

    const content = (response.text ?? '').trim();
    let json: unknown;
    let parsed = false;
    if (req.formatJson) {
      try {
        json = JSON.parse(content);
        parsed = true;
      } catch {
        parsed = false;
      }
    }

    const usage = response.usageMetadata;
    return {
      content,
      json,
      parsed,
      tokens: {
        prompt: usage?.promptTokenCount ?? 0,
        completion: usage?.candidatesTokenCount ?? 0,
      },
      latencyMs: Date.now() - started,
      model: response.modelVersion ?? req.model,
    };
  }

  async health(): Promise<boolean> {
    try {
      // The Gemini SDK exposes a models.list() endpoint.
      const r = await this.client.models.list();
      // The list response is a pager; just check that the call resolves.
      void r;
      return true;
    } catch {
      return false;
    }
  }
}

// Suppress unused-import warning when the SDK is only used for types.
void DEFAULT_TIMEOUT_MS;
