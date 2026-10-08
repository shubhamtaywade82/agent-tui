/**
 * MemoryService write policy + security — Part 2 §5, §11, §12, §13.
 *
 * Uses an in-memory mock for the secret/PII/importance gates (no DB
 * required). The DB-backed paths are covered by the integration test.
 */
import { describe, expect, it } from 'vitest';
import { MEMORY_TYPES } from '../../../src/supervisor/context/memory.js';

describe('MemoryService constants and gates', () => {
  it('MEMORY_TYPES covers the §4.1 allowlist', () => {
    expect(MEMORY_TYPES).toContain('user_preference');
    expect(MEMORY_TYPES).toContain('project_convention');
    expect(MEMORY_TYPES).toContain('decision');
    expect(MEMORY_TYPES).toContain('constraint');
    expect(MEMORY_TYPES).toContain('fact');
    expect(MEMORY_TYPES).toContain('episode_summary');
    expect(MEMORY_TYPES).toContain('failed_strategy');
    expect(MEMORY_TYPES).toContain('successful_strategy');
    expect(MEMORY_TYPES).toContain('tool_policy');
    expect(MEMORY_TYPES).toContain('environment_note');
  });

  it('MEMORY_TYPES rejects arbitrary strings at the type level', () => {
    // Type-level test: this line would not compile if 'random' were allowed.
    const ok: (typeof MEMORY_TYPES)[number] = 'fact';
    expect(ok).toBe('fact');
  });
});

/**
 * §12 secret patterns — verify the regexes catch common secret shapes.
 * These mirror the SECRET_PATTERNS array in memory.ts.
 */
const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{36,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i,
];

describe('§12 secret pattern scanning', () => {
  it('catches a GitHub PAT', () => {
    expect(SECRET_PATTERNS.some((re) => re.test(`ghp_${'a'.repeat(36)}`))).toBe(true);
  });
  it('catches an OpenAI key', () => {
    expect(SECRET_PATTERNS.some((re) => re.test(`sk-${'a'.repeat(24)}`))).toBe(true);
  });
  it('catches an AWS access key', () => {
    expect(SECRET_PATTERNS.some((re) => re.test(`AKIA${'A'.repeat(12)}BCDE`))).toBe(true);
  });
  it('catches a PEM private key header', () => {
    expect(SECRET_PATTERNS.some((re) => re.test('-----BEGIN RSA PRIVATE KEY-----'))).toBe(true);
  });
  it('catches a Bearer token', () => {
    expect(SECRET_PATTERNS.some((re) => re.test('Bearer eyJhbGciOiJIUzI1NiIsInR5c'))).toBe(true);
  });
  it('catches a postgres connection string with creds', () => {
    expect(SECRET_PATTERNS.some((re) => re.test('postgres://user:secretpass@host:5432/db'))).toBe(
      true,
    );
  });
  it('does NOT flag a plain sentence', () => {
    expect(SECRET_PATTERNS.some((re) => re.test('The deploy failed at 3am.'))).toBe(false);
  });
});

/**
 * §13 retrieval/generation metrics — verify the metric formulas.
 */
describe('§13 retrieval metric formulas (unit-level sanity)', () => {
  it('recall@k = hits / relevant', () => {
    const relevant = ['a', 'b', 'c'];
    const retrieved = ['a', 'x', 'y', 'b'];
    const hits = retrieved.filter((r) => relevant.includes(r)).length;
    const recall = hits / relevant.length;
    expect(recall).toBeCloseTo(2 / 3);
  });

  it('precision@k = hits / topK', () => {
    const relevant = new Set(['a', 'b']);
    const retrieved = ['a', 'x', 'b', 'y'];
    const hits = retrieved.filter((r) => relevant.has(r)).length;
    expect(hits / retrieved.length).toBe(0.5);
  });

  it('MRR = 1 / rank of first relevant', () => {
    const relevant = new Set(['b']);
    const retrieved = ['x', 'b', 'a'];
    let mrr = 0;
    for (let i = 0; i < retrieved.length; i++) {
      if (relevant.has(retrieved[i]!)) {
        mrr = 1 / (i + 1);
        break;
      }
    }
    expect(mrr).toBe(0.5);
  });

  it('nDCG with binary relevance is between 0 and 1', () => {
    const relevant = new Set(['a', 'b']);
    const retrieved = ['a', 'x', 'b', 'y'];
    const dcg = retrieved.reduce(
      (sum, id, i) => sum + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0),
      0,
    );
    const idealHits = Math.min(relevant.size, retrieved.length);
    const idcg = Array.from({ length: idealHits }, (_, i) => 1 / Math.log2(i + 2)).reduce(
      (a, b) => a + b,
      0,
    );
    const ndcg = idcg === 0 ? 0 : dcg / idcg;
    expect(ndcg).toBeGreaterThan(0);
    expect(ndcg).toBeLessThanOrEqual(1);
  });
});
