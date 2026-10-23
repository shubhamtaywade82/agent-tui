/**
 * Secret redaction for log output. Applied by the logger to every message and
 * context value, so a token that reaches a log call is not written to disk.
 */

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // Provider and platform tokens, by their well-known prefixes.
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '***'],
  // Authorization headers and bearer tokens, in any casing.
  [/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1***'],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  // Credentials embedded in URLs: https://x-access-token:TOKEN@host and https://user:pass@host.
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@'],
  // Assignments and flags that name a secret: GITHUB_TOKEN=..., --api-key=..., --token ...
  [/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key)[A-Za-z0-9_]*=)\S+/gi, '$1***'],
  [/(--(?:token|password|passwd|api[_-]?key|secret)(?:=|\s+))\S+/gi, '$1***'],
];

/** Keys whose values are secrets. Matches apiKey, accessKey, githubToken and token, not inputTokens. */
const SENSITIVE_KEY = /api[_-]?key|access[_-]?key|secret|passw|authoriz|credential|cookie|token$/i;

export function redactText(s: string): string {
  let out = s;
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Deep copy of a log context with secret-named keys masked and secrets in strings redacted. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k) && v !== undefined && v !== null && v !== '') out[k] = '***';
      else out[k] = redactValue(v);
    }
    return out as T;
  }
  return value;
}
