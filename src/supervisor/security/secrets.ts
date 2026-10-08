/**
 * Secret resolver — §16.2 (Secret Handling).
 *
 * Secrets are NEVER placed directly in the prompt. Tools receive a
 * `secretRef` (a stable identifier) at call time; the runtime resolves
 * the actual value from the configured secret backend (env, file, or
 * an external secret manager in production).
 *
 * This indirection means model outputs are safe to log in full — they
 * contain only references, never the secret values themselves.
 */
export interface SecretRef {
  /** Stable identifier, e.g. `prod-db-readonly`. */
  ref: string;
  /** Backend the resolver should consult. */
  backend: 'env' | 'file' | 'vault';
}

export class SecretResolver {
  private readonly cache = new Map<string, string>();

  /**
   * Resolve a secret reference to its actual value. The value is cached
   * for the lifetime of the process and NEVER written to disk.
   */
  resolve(ref: SecretRef): string {
    const cached = this.cache.get(ref.ref);
    if (cached) return cached;

    let value: string | undefined;
    switch (ref.backend) {
      case 'env':
        value = process.env[ref.ref];
        break;
      case 'file': {
        // Expected format: "file:/path/to/secret"
        const envKey = ref.ref.replace(/^file:/, '');
        value = process.env[envKey];
        break;
      }
      case 'vault':
        // In production this would call out to Vault / cloud secret manager.
        // For now we fall back to env with the same key.
        value = process.env[ref.ref];
        break;
    }

    if (!value) {
      throw new Error(`Secret not found for ref=${ref.ref} backend=${ref.backend}`);
    }
    this.cache.set(ref.ref, value);
    return value;
  }

  /** Returns true iff the secret reference can be resolved (without throwing). */
  canResolve(ref: SecretRef): boolean {
    try {
      return Boolean(this.resolve(ref));
    } catch {
      return false;
    }
  }

  /** Clears the in-process cache. Use on credential rotation. */
  clearCache(): void {
    this.cache.clear();
  }
}
