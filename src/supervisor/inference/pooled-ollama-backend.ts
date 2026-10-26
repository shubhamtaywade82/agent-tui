/**
 * PooledOllamaBackend — wraps OllamaBackend so every invoke() goes
 * through the model residency pool.
 *
 * The pool guarantees that at most `maxResident` MiniCPM5 variants
 * are loaded in Ollama at any time. The wrapper is transparent to
 * the engine — it implements the same `Backend` interface — but
 * `acquire()` is called before each inference request and
 * `release()` is called in the finally block.
 *
 * Models not on the pool's allowlist (e.g. the cloud fallback when
 * escalation hands off to a different backend) bypass the pool
 * entirely.
 */
import { logger } from '../observability/logger.js';
import type { Backend, InferenceRequest, InferenceResponse } from './backend.js';
import type { ModelPool } from './model-pool.js';

export class PooledOllamaBackend implements Backend {
  readonly name = 'ollama';

  constructor(
    private readonly inner: Backend,
    private readonly pool: ModelPool,
  ) {
    if (inner.name !== 'ollama') {
      logger.warn(
        { innerName: inner.name },
        'PooledOllamaBackend wraps a non-ollama backend — pool semantics may not apply',
      );
    }
  }

  async invoke(req: InferenceRequest): Promise<InferenceResponse> {
    const handle = await this.pool.acquire(req.model);
    try {
      return await this.inner.invoke(req);
    } finally {
      await handle.release();
    }
  }

  async health(): Promise<boolean> {
    return this.inner.health();
  }
}
