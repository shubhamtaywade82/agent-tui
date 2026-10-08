/**
 * RouterClassifier — §13.1. Uses the MockBackend so no Ollama is required.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import { RouterClassifier } from '../../../src/supervisor/router/classifier.js';

describe('RouterClassifier', () => {
  let backend: MockBackend;
  let classifier: RouterClassifier;

  beforeEach(() => {
    backend = new MockBackend();
    classifier = new RouterClassifier(backend, 'minicpm5-router');
  });

  it('parses a clean JSON response', async () => {
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'TOOL_EXECUTION' } }));
    const r = await classifier.classify('Check deployment status');
    expect(r.intent).toBe('TOOL_EXECUTION');
    expect(r.repaired).toBe(false);
  });

  it('normalises lower-case intents', async () => {
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'tool execution' } }));
    const r = await classifier.classify('Check deployment status');
    expect(r.intent).toBe('TOOL_EXECUTION');
  });

  it('repairs via regex when JSON is malformed', async () => {
    backend.enqueue('minicpm5-router', () => 'Sure! The intent is CODE_REVIEW.');
    const r = await classifier.classify('Review this function');
    expect(r.intent).toBe('CODE_REVIEW');
    expect(r.repaired).toBe(true);
  });

  it('falls back to UNKNOWN when nothing parses', async () => {
    backend.enqueue('minicpm5-router', () => 'I have no idea what you mean');
    const r = await classifier.classify('xyzzy');
    expect(r.intent).toBe('UNKNOWN');
    expect(r.repaired).toBe(true);
  });
});
