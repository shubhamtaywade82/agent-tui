/**
 * Mock backend — used by unit tests, golden evals, and local development
 * without an Ollama daemon. Behaviour is fully deterministic: the response
 * for a given (model, prompt) tuple is whatever was queued by the test.
 *
 * This is the keystone of the §15.3 evaluation strategy: golden tasks run
 * against the mock backend so prompt/retrieval/state-machine regressions
 * are detectable without spending GPU cycles.
 */

import type { Backend, InferenceRequest, InferenceResponse } from './backend.js';

type Responder = (req: InferenceRequest) => string | { json: unknown; content?: string };

interface QueuedResponse {
  model: string | '*';
  match?: RegExp;
  respond: Responder;
}

export class MockBackend implements Backend {
  readonly name = 'mock';
  private queue: QueuedResponse[] = [];
  private readonly calls: InferenceRequest[] = [];

  /**
   * Queue a deterministic response. The first matching entry is consumed.
   * Use `model: '*'` to match any model. If `match` is provided, the prompt
   * must match the regex.
   */
  enqueue(model: string | '*', respond: Responder, match?: RegExp): this {
    this.queue.push({ model, match, respond });
    return this;
  }

  /** Snapshot of all calls seen so far — useful for assertion in tests. */
  observedCalls(): readonly InferenceRequest[] {
    return this.calls;
  }

  async invoke(req: InferenceRequest): Promise<InferenceResponse> {
    this.calls.push(req);
    const idx = this.queue.findIndex(
      (q) => (q.model === '*' || q.model === req.model) && (!q.match || q.match.test(req.prompt)),
    );
    if (idx < 0) {
      throw new Error(
        `MockBackend: no queued response for model=${req.model} prompt=${req.prompt.slice(0, 80)}`,
      );
    }
    const [entry] = this.queue.splice(idx, 1);
    const out = entry?.respond(req);
    const content = typeof out === 'string' ? out : (out.content ?? JSON.stringify(out.json));
    let json: unknown;
    let parsed = false;
    if (req.formatJson) {
      try {
        json = typeof out === 'string' ? JSON.parse(out) : out.json;
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
        prompt: Math.ceil(req.prompt.length / 4),
        completion: Math.ceil(content.length / 4),
      },
      latencyMs: 1,
      model: req.model,
    };
  }

  async health(): Promise<boolean> {
    return true;
  }
}
