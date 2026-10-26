/**
 * Lightweight async mutex — no external dependency.
 *
 * Used by the ModelPool to serialise load/unload decisions. Without
 * serialisation, two concurrent `acquire()` calls for non-resident
 * models could each observe an under-capacity state and both load a
 * model, breaching the residency cap.
 *
 * The implementation is a single-linked queue of pending continuations.
 * `runExclusive` resolves them in FIFO order; the lock is held until
 * the returned promise settles (resolves OR rejects).
 */
export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  /**
   * Run `fn` while holding the mutex. Other callers of `runExclusive`
   * on the same mutex instance will wait until `fn` settles.
   *
   * The returned promise rejects iff `fn` rejects — the mutex is
   * always released, even on error.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the previous tail. Each caller waits for the prior
    // caller's `fn` to settle before running its own.
    const next = this.chain.then(fn, fn);
    // Advance the chain tail so subsequent callers wait for us.
    // `catch` swallows the rejection for the chain itself; the
    // rejection is still propagated to `next` (the caller's handle).
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
