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
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface SecretRef {
  /** Stable identifier, e.g. `prod-db-readonly`. For `file`, the form is `file:/absolute/path`. */
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

    const value = this.readBackend(ref);
    if (!value) {
      throw new Error(`Secret not found for ref=${ref.ref} backend=${ref.backend}`);
    }
    this.cache.set(ref.ref, value);
    return value;
  }

  private readBackend(ref: SecretRef): string | undefined {
    switch (ref.backend) {
      case 'env':
        return process.env[ref.ref];
      case 'file': {
        // The reference names the file that holds the secret. Reading an environment
        // variable named by the path was the old behaviour, and it never read the file.
        const path = ref.ref.replace(/^file:/, '');
        if (!isAbsolute(path)) {
          throw new Error(`file secret ref must be an absolute path: ${ref.ref}`);
        }
        // The trailing newline most secret files end with is not part of the secret.
        return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
      }
      case 'vault':
        // No Vault client exists yet. Falling back to environment variables would
        // silently accept the wrong source, so this fails closed.
        throw new Error(
          `vault secret backend is not implemented (ref=${ref.ref}); refusing to read the environment instead`,
        );
    }
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
