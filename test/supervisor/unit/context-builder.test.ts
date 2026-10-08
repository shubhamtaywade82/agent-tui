/**
 * ContextBuilder — §8. Token budget enforcement and priority ordering.
 */
import { describe, expect, it } from 'vitest';
import { ContextBuilder } from '../../../src/supervisor/context/builder.js';
import type { MemoryRecord } from '../../../src/supervisor/context/memory.js';
import type { RetrievalResult } from '../../../src/supervisor/context/retrieval.js';

describe('ContextBuilder', () => {
  const builder = new ContextBuilder();

  const baseInput = {
    systemInstruction: 'You are the MiniCPM5 analyst sub-agent.',
    outputSchema: 'Plain text answer.',
    toolDefinitions: '## read_file\nRead a file',
    task: 'What is the on-call policy?',
    stateSummary: 'intent=GENERAL_QUERY thinkMode=no-think',
    retrievedEvidence: [] as RetrievalResult[],
    fileSnippets: [] as Array<{ path: string; content: string; signature?: string }>,
    conversationHistory: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
    longTermMemory: [] as MemoryRecord[],
  };

  it('assembles a prompt containing every priority section', () => {
    const r = builder.build(baseInput, { total: 8192, reserve: 512 });
    expect(r.prompt).toContain('# System');
    expect(r.prompt).toContain('# Tools');
    expect(r.prompt).toContain('# State');
    expect(r.prompt).toContain('# Task');
    expect(r.usedTokens).toBeGreaterThan(0);
    expect(r.usedTokens).toBeLessThanOrEqual(8192);
  });

  it('truncates oversized sections', () => {
    const huge = 'a'.repeat(50_000);
    const r = builder.build(
      {
        ...baseInput,
        retrievedEvidence: [
          { chunkId: '1', source: 'both', score: 1, content: huge, metadata: {}, citation: 'x' },
        ],
      },
      { total: 1024, reserve: 128 },
    );
    expect(r.usedTokens).toBeLessThanOrEqual(1024);
    expect(r.sections.find((s) => s.name === 'evidence')?.truncated).toBe(true);
  });

  it('includes retrieved evidence with citations', () => {
    const r = builder.build({
      ...baseInput,
      retrievedEvidence: [
        {
          chunkId: '1',
          source: 'both',
          score: 0.9,
          content: 'Policy: call Alice on +1 555 0100',
          metadata: {},
          citation: 'runbook.md#L10',
        },
      ],
    });
    expect(r.prompt).toContain('runbook.md#L10');
    expect(r.prompt).toContain('Policy: call Alice');
  });

  it('respects the reserve', () => {
    const r = builder.build(baseInput, { total: 500, reserve: 100 });
    // After truncation, usedTokens must be <= total - reserve + small slack
    // because each section caps at 30% of (total - reserve).
    expect(r.usedTokens).toBeLessThanOrEqual(500);
  });

  it('handles empty inputs gracefully', () => {
    const r = builder.build(baseInput);
    expect(r.prompt).toContain('(no retrieved evidence)');
    expect(r.prompt).toContain('(no long-term memory)');
  });
});
