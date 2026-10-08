/**
 * Ollama backend — default inference engine (§13, §17).
 *
 * Uses the official `ollama` npm SDK's async client. The SYSTEM prompt and
 * runtime options (temperature, num_ctx) live in the Modelfile; we only
 * override per-call `temperature` and `think` here as a failsafe.
 */
import { Ollama } from 'ollama';
import type { SupervisorConfig } from '../config.js';
import type { Backend, InferenceRequest, InferenceResponse } from './backend.js';

export class OllamaBackend implements Backend {
  readonly name = 'ollama';
  private readonly client: Ollama;

  constructor(private readonly config: SupervisorConfig) {
    this.client = new Ollama({ host: config.inference.ollamaHost });
  }

  async invoke(req: InferenceRequest): Promise<InferenceResponse> {
    const started = Date.now();
    const thinkMode = req.thinkMode ?? this.config.inference.defaultThinkMode;
    const temperature = req.temperature ?? 0.1;

    const response = await this.client.chat({
      model: req.model,
      messages: [{ role: 'user', content: req.prompt }],
      format: req.formatJson ? 'json' : undefined,
      options: {
        temperature,
        num_ctx: req.maxTokens ?? this.config.context.budgetTokens,
      },
      think: thinkMode === 'think',
    });

    const content = (response.message?.content ?? '').trim();
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
        prompt: response.prompt_eval_count ?? 0,
        completion: response.eval_count ?? 0,
      },
      latencyMs: Date.now() - started,
      model: req.model,
    };
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.client.list();
      return Array.isArray(r.models);
    } catch {
      return false;
    }
  }
}
