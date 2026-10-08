/**
 * vLLM backend — alternate inference engine for server-side deployments
 * with larger GPUs (§17 recommended stack). vLLM exposes an
 * OpenAI-compatible API, so we use the official `openai` SDK pointed at
 * the vLLM base URL.
 *
 * Tool-call parsing in vLLM converts XML outputs into OpenAI-shaped
 * `tool_calls` — that conversion happens upstream and is consumed by the
 * tool validator (§10). This backend only handles raw text/JSON inference.
 */
import OpenAI from 'openai';
import type { SupervisorConfig } from '../config.js';
import type { Backend, InferenceRequest, InferenceResponse } from './backend.js';

export class VllmBackend implements Backend {
  readonly name = 'vllm';
  private readonly client: OpenAI;

  constructor(private readonly config: SupervisorConfig) {
    this.client = new OpenAI({
      baseURL: config.inference.vllmBaseUrl,
      apiKey: config.inference.vllmApiKey,
    });
  }

  async invoke(req: InferenceRequest): Promise<InferenceResponse> {
    const started = Date.now();
    const thinkMode = req.thinkMode ?? this.config.inference.defaultThinkMode;
    const temperature = req.temperature ?? 0.1;

    // vLLM supports a `chat_template_kwargs` field for toggling think mode
    // when the served model exposes one (e.g. MiniCPM5's `enable_thinking`).
    const completion = await this.client.chat.completions.create({
      model: req.model,
      messages: [{ role: 'user', content: req.prompt }],
      temperature,
      max_tokens: req.maxTokens ?? this.config.context.budgetTokens,
      response_format: req.formatJson ? { type: 'json_object' } : undefined,
      // @ts-expect-error - chat_template_kwargs is supported by vLLM but not in the OpenAI SDK types
      chat_template_kwargs: { enable_thinking: thinkMode === 'think' },
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
