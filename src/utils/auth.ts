/**
 * Bearer-token authentication shared by the agent API and the supervisor API.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Minimum length for a token the operator configures. Generated tokens are longer. */
export const MIN_CONFIGURED_TOKEN_LENGTH = 16;

/** True when an `Authorization` header carries the expected bearer token. Constant-time and length-safe. */
export function isBearerAuthorized(authorization: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1]!);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface ResolvedToken {
  token: string;
  /** True when the token was generated for this run rather than configured. */
  generated: boolean;
}

/**
 * Pick the token a server listens with. A configured token must be long enough.
 * A non-loopback bind must have a configured token. Otherwise a token is generated
 * for this run. Throws before the server starts, so a misconfiguration fails fast.
 */
export function resolveBearerToken(opts: { host: string; configured?: string; envName: string }): ResolvedToken {
  const configured = opts.configured?.trim() || undefined;
  if (configured && configured.length < MIN_CONFIGURED_TOKEN_LENGTH) {
    throw new Error(`${opts.envName} must be at least ${MIN_CONFIGURED_TOKEN_LENGTH} characters.`);
  }
  if (!LOOPBACK_HOSTS.has(opts.host) && !configured) {
    throw new Error(
      `Host ${opts.host} exposes the API beyond this machine. Set ${opts.envName} to a strong secret first.`,
    );
  }
  if (configured) return { token: configured, generated: false };
  return { token: randomBytes(24).toString('base64url'), generated: true };
}
