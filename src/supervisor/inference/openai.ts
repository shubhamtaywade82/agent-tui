/**
 * OpenAI backend — uses the official `openai` SDK pointed at `api.openai.com/v1`
 * (or `OPENAI_BASE_URL` for Azure OpenAI / compatible proxies).
 *
 * The supervisor engine never calls a model directly — it calls a `Backend`
 * implementation. This module is the OpenAI-specific adapter; the
 * OpenAI-compatible wire shape (chat/completions + embeddings) is shared with
 * the existing `vllm` backend (any OpenAI-compatible endpoint without the
 * `chat_template_kwargs` vLLM quirk goes through this backend).
 *
 * Capability notes (see docs/supervisor/adr/0009-multi-provider-inference.md):
 *
 *   - JSON mode: native via `response_format: { type: 'json_object' }`.
 *   - `max_tokens` is a generation cap (not a context-window hint) —
 *     OpenAI derives the context window from the deployed model.
 *   - `think` flag: OpenAI reasoning models (`o1`, `o3`) ignore temperature
 *     and `think=false`; reasoning is unconditional. We forward the field
 *     only for telemetry — it does not change the wire request.
 *   - System prompt: OpenAI accepts a `system` role message; this backend
 *     forwards the Modelfile-equivalent prompt as the system message when
 *     `SupervisorConfig.inference.systemPrompt` is set. (Phase 6 follow-up;
 *     today the system prompt lives in the Ollama Modelfile and is unused
 *     here — the supervisor constructs a self-contained user prompt.)
 */
import OpenAI from 'openai';
import type { SupervisorConfig } from '../config.js';
import { logger } from '../observability/logger.js';
import type { Backend, InferenceRequest, InferenceResponse } from './backend.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAIBackend implements Backend {
  readonly name = 'openai';
  protected readonly client: OpenAI;

  /** `fetchImpl` is the transport seam for tests; production uses the runtime's global fetch. */
  constructor(
    protected readonly config: SupervisorConfig,
    fetchImpl?: typeof fetch,
  ) {
    const openaiCfg = config.inference.openai;
    if (!openaiCfg.apiKey) {
      throw new Error(
        'OpenAIBackend: OPENAI_API_KEY is required when INFERENCE_BACKEND=openai. ' +
          'Set it in the environment or in config.inference.openai.apiKey.',
      );
    }
    this.client = new OpenAI({
      baseURL: openaiCfg.baseUrl,
      apiKey: openaiCfg.apiKey,
      organization: openaiCfg.organization,
      project: openaiCfg.project,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 2,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    logger.info({ baseUrl: openaiCfg.baseUrl }, 'OpenAIBackend: initialised');
  }

  async invoke(req: InferenceRequest): Promise<InferenceResponse> {
    const started = Date.now();
    const temperature = req.temperature ?? 0.1;

    // OpenAI's chat.completions.create accepts a max_tokens field that caps
    // generation length (NOT the context window — that's derived from the
    // model). Only forward when the caller explicitly set it.
    const completion = await this.client.chat.completions.create({
      model: req.model,
      messages: [{ role: 'user', content: req.prompt }],
      temperature,
      ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
      response_format: req.formatJson ? { type: 'json_object' } : undefined,
    });

    const content = (completion.choices[0]?.message?.content ?? '').trim();
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

    return {
      content,
      json,
      parsed,
      tokens: {
        prompt: completion.usage?.prompt_tokens ?? 0,
        completion: completion.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      model: completion.model ?? req.model,
    };
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.client.models.list();
      return Array.isArray(r.data);
    } catch {
      return false;
    }
  }
}
