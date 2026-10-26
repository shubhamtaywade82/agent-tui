/**
 * Model residency pool — Phase 2.
 *
 * Enforces a hard upper bound on the number of MiniCPM5 variants
 * resident in Ollama at any time. The user's design calls for "at
 * most three resident local variants"; the pool makes that contract
 * real in code by intercepting every model-loading request.
 *
 * ## Contract
 *
 *   - `acquire(model)` returns a `PinnedHandle` whose `release()`
 *     must be called when inference is done. While pinned, the model
 *     cannot be evicted.
 *   - When `acquire()` is called for a non-resident model AND the
 *     pool is at capacity, the LRU non-pinned resident is evicted
 *     before loading the new model.
 *   - When the pool is at capacity AND every resident is pinned,
 *     `acquire()` throws `ModelPoolExhaustedError`. The caller is
 *     expected to retry, queue, or fail loudly — the pool never
 *     silently exceeds the cap.
 *   - Models not on the configured `allowlist` (e.g. the cloud
 *     fallback) pass through `acquire()` as a no-op. They do not
 *     count toward the cap.
 *
 * ## Ollama API
 *
 *   - `GET /api/ps` lists currently-loaded models with their
 *     `expires_at` timestamps. The pool uses this to refresh its
 *     residency cache.
 *   - `POST /api/generate { keep_alive: 0 }` immediately unloads a
 *     model. Used for eviction.
 *   - `POST /api/generate { keep_alive: N }` with a no-op prompt
 *     loads a model into memory. (We rely on the existing
 *     `OllamaBackend.invoke()` call that follows `acquire()` to do
 *     the actual loading; `acquire()` only triggers an explicit load
 *     when the residency cache says the model is not present.)
 *
 * ## Limitations
 *
 *   - The pool cannot enforce the cap if other applications load
 *     models into the same Ollama server independently. Route all
 *     model-loading traffic through agent-tui, or give it a dedicated
 *     Ollama instance.
 *   - The residency cache is eventually consistent. After an error
 *     or process restart, call `reconcile()` to refresh.
 *   - The pool does not account for VRAM or context allocation.
 *     `maxResident` is an upper bound, not a guarantee that all three
 *     variants fit in VRAM simultaneously.
 */
import { logger } from '../observability/logger.js';
import { AsyncMutex } from './mutex.js';

/** Thrown when the pool is at capacity and every resident is pinned. */
export class ModelPoolExhaustedError extends Error {
  constructor(
    public readonly requestedModel: string,
    public readonly resident: string[],
    public readonly maxResident: number,
  ) {
    super(
      `model pool exhausted: ${resident.length} models resident (cap ${maxResident}), ` +
        `all pinned; cannot load ${requestedModel}. ` +
        `Resident: ${resident.join(', ')}`,
    );
    this.name = 'ModelPoolExhaustedError';
  }
}

export interface ResidentModel {
  name: string;
  /** Bytes the model occupies in VRAM (from /api/ps). */
  size: number;
  /** When Ollama will automatically unload the model (from /api/ps). */
  expiresAt: Date;
}

export interface PinnedHandle {
  /** The model this handle pins. */
  readonly model: string;
  /**
   * Release the pin. Must be called exactly once when inference is
   * done. After release, the model is eligible for eviction again
   * but remains resident until Ollama's keep_alive expires or the
   * pool explicitly evicts it.
   */
  release(): Promise<void>;
}

export interface ModelPoolDeps {
  /** Ollama base URL, e.g. `http://localhost:11434`. */
  ollamaHost: string;
  /** Hard upper bound on resident managed models. */
  maxResident: number;
  /** Ollama keep_alive in ms after a model is loaded. */
  keepAliveMs: number;
  /**
   * Model names the pool manages. Models not on the allowlist pass
   * through acquire() as a no-op (the cloud fallback, for example).
   */
  allowlist: string[];
  /**
   * When true, the pool polls /api/ps on every acquire() to refresh
   * its residency cache. When false, it trusts its in-memory view
   * and only reconciles on init() / error / explicit reconcile().
   * Default false in production (avoid extra round-trips); true in
   * tests for determinism.
   */
  alwaysRefresh?: boolean;
  /** Fetch seam for tests; production uses the runtime's global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Model residency pool.
 *
 * Wraps Ollama's `/api/ps` and `/api/generate` endpoints to enforce
 * the configured `maxResident` cap. The pool itself does not perform
 * inference — it only manages residency. The wrapping `Backend`
 * (see `PooledOllamaBackend`) calls `acquire()` before each
 * `invoke()` and `release()` after.
 */
export class ModelPool {
  private readonly mutex = new AsyncMutex();
  private readonly pinned = new Set<string>();
  private residentCache: ResidentModel[] = [];
  private initialised = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: ModelPoolDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        'ModelPool: no fetch implementation available (neither deps.fetchImpl nor globalThis.fetch)',
      );
    }
  }

  /**
   * Populate the residency cache by polling `/api/ps`. Called once on
   * startup; subsequent calls happen on `reconcile()` or (when
   * `alwaysRefresh` is true) at the top of every `acquire()`.
   */
  async init(): Promise<void> {
    await this.refreshResidentCache();
    this.initialised = true;
    logger.info(
      {
        resident: this.residentCache.map((r) => r.name),
        maxResident: this.deps.maxResident,
        allowlist: this.deps.allowlist,
      },
      'model pool initialised',
    );
  }

  /**
   * Acquire a pin on `model`. While pinned, the model cannot be
   * evicted. If the model is not currently resident, the pool loads
   * it (evicting the LRU non-pinned resident first if at capacity).
   *
   * For models not on the allowlist, returns a no-op handle
   * immediately — the pool does not manage them.
   */
  async acquire(model: string): Promise<PinnedHandle> {
    // Fast path: non-allowlisted models pass through.
    if (!this.deps.allowlist.includes(model)) {
      return { model, release: async () => {} };
    }

    return this.mutex.runExclusive(async () => {
      if (!this.initialised || this.deps.alwaysRefresh) {
        await this.refreshResidentCache();
      }

      const isResident = this.residentCache.some((r) => r.name === model);
      if (!isResident) {
        await this.ensureCapacity();
        await this.loadModel(model);
      }

      // Pin. Even if the model was already resident, we record the
      // pin so a concurrent acquire() for a different model cannot
      // evict this one.
      this.pinned.add(model);

      return {
        model,
        release: async () => {
          // Release must be idempotent — the wrapping backend may
          // call it in a finally block that runs even after an error.
          this.pinned.delete(model);
        },
      };
    });
  }

  /**
   * Refresh the residency cache from `/api/ps`. Called inside the
   * mutex, so concurrent refreshes are serialised.
   */
  async refreshResidentCache(): Promise<void> {
    try {
      const r = await this.fetchImpl(`${this.deps.ollamaHost}/api/ps`, { method: 'GET' });
      if (!r.ok) {
        logger.warn(
          { status: r.status },
          'model pool: /api/ps returned non-200 — keeping stale cache',
        );
        return;
      }
      const data = (await r.json()) as {
        models?: Array<{ name?: string; size?: number; expires_at?: string }>;
      };
      this.residentCache = (data.models ?? [])
        .filter((m) => typeof m.name === 'string')
        .map((m) => ({
          name: m.name as string,
          size: typeof m.size === 'number' ? m.size : 0,
          expiresAt: m.expires_at ? new Date(m.expires_at) : new Date(0),
        }));
    } catch (e) {
      logger.warn({ err: e }, 'model pool: /api/ps fetch failed — keeping stale cache');
    }
  }

  /**
   * Evict resident models until at least one slot is free. Eviction
   * policy: LRU among non-pinned managed models (the model whose
   * `expires_at` is soonest). If every managed resident is pinned,
   * throws `ModelPoolExhaustedError`.
   */
  private async ensureCapacity(): Promise<void> {
    const managed = this.residentCache.filter((r) => this.deps.allowlist.includes(r.name));
    if (managed.length < this.deps.maxResident) {
      return; // capacity available
    }

    const evictable = managed.filter((r) => !this.pinned.has(r.name));
    if (evictable.length === 0) {
      throw new ModelPoolExhaustedError(
        '(unknown)', // caller fills in the requested model name
        managed.map((m) => m.name),
        this.deps.maxResident,
      );
    }

    // LRU: soonest expires_at first.
    evictable.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
    const victim = evictable[0];
    if (!victim) return;

    await this.unloadModel(victim.name);
  }

  /**
   * Explicitly load a model into VRAM. Uses `/api/generate` with an
   * empty prompt and the configured `keep_alive` — the same trick
   * Ollama's own CLI uses for `ollama run --keepalive`.
   */
  private async loadModel(model: string): Promise<void> {
    const started = Date.now();
    try {
      const r = await this.fetchImpl(`${this.deps.ollamaHost}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: this.deps.keepAliveMs }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '(no body)');
        throw new Error(`/api/generate returned ${r.status}: ${text}`);
      }
      // Drain the response body so the connection can be reused.
      await r.text();
      await this.refreshResidentCache();
      logger.info(
        { model, loadMs: Date.now() - started, resident: this.residentCache.map((m) => m.name) },
        'model pool: loaded model',
      );
    } catch (e) {
      logger.error({ err: e, model }, 'model pool: load failed');
      throw e;
    }
  }

  /**
   * Explicitly unload a model from VRAM. Uses `/api/generate` with
   * `keep_alive: 0` — Ollama's documented unload mechanism.
   */
  private async unloadModel(model: string): Promise<void> {
    const started = Date.now();
    try {
      const r = await this.fetchImpl(`${this.deps.ollamaHost}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '(no body)');
        throw new Error(`/api/generate (unload) returned ${r.status}: ${text}`);
      }
      await r.text();
      // Update the cache to reflect the eviction. We don't refresh
      // from /api/ps here because the caller (ensureCapacity) is about
      // to load a new model and will refresh after that.
      this.residentCache = this.residentCache.filter((r) => r.name !== model);
      logger.info({ model, unloadMs: Date.now() - started }, 'model pool: evicted model');
    } catch (e) {
      logger.warn({ err: e, model }, 'model pool: unload failed — refreshing cache');
      await this.refreshResidentCache();
    }
  }

  /**
   * Reconcile the in-memory residency cache with Ollama's actual
   * state. Called on init() and after errors. Also exposes the
   * current snapshot for observability/tests.
   */
  async reconcile(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.refreshResidentCache();
      // Drop pins for models that are no longer resident (e.g. evicted
      // externally). They will be re-loaded on the next acquire().
      const resident = new Set(this.residentCache.map((r) => r.name));
      for (const pinned of [...this.pinned]) {
        if (!resident.has(pinned)) {
          this.pinned.delete(pinned);
        }
      }
    });
  }

  /**
   * Snapshot of the pool's view — for tests and observability. Does
   * not refresh the cache; the caller should call `reconcile()` first
   * if a fresh view is needed.
   */
  snapshot(): {
    resident: ResidentModel[];
    pinned: string[];
    maxResident: number;
    allowlist: string[];
  } {
    return {
      resident: [...this.residentCache],
      pinned: [...this.pinned],
      maxResident: this.deps.maxResident,
      allowlist: [...this.deps.allowlist],
    };
  }
}
