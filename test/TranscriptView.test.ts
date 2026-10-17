/**
 * test/TranscriptView.test.ts — unit tests for the TranscriptView renderer.
 *
 * These tests exercise the `renderEvent` pure function — the per-event
 * renderer that the TranscriptView's ScrollBox iterates over. Testing
 * the JSX output by inspecting the React element tree directly (no
 * react-test-renderer required) keeps the test fast and framework-agnostic.
 *
 * What we test:
 *   - Every `TranscriptEvent` kind has a renderer (exhaustiveness).
 *   - Streaming events render a `▌` cursor / Spinner.
 *   - Finished events render their durationMs.
 *   - The renderer never throws on a well-formed event.
 *
 * What we DON'T test:
 *   - The actual pixel output (the termina-core reconciler handles that).
 *   - ScrollBox behavior (proven in step 1's PoC).
 *   - State transitions (covered by test/transcript.test.ts).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import React from 'react';
import { renderEvent } from '../src/components/TranscriptView.js';
import type { TranscriptEvent } from '../src/transcript/index.js';
import {
  makeAssistantEvent,
  makeErrorEvent,
  makePlanEvent,
  makeThinkingEvent,
  makeToolEvent,
  makeUsageEvent,
  makeUserEvent,
} from '../src/transcript/index.js';

/* ------------------------------------------------------------------ *
 * Tiny helpers to inspect React element trees without react-test-renderer.
 * We walk the tree and collect (tag, props, text) tuples. Good enough
 * for assertions like "the user event contains the text 'hello'" or
 * "the streaming assistant event renders a ▌ cursor".
 * ------------------------------------------------------------------ */
type NodeSnapshot = {
  tag: string;
  text: string;
  hasSpinner: boolean;
  hasCursor: boolean;
};

function walk(node: React.ReactNode, acc: NodeSnapshot[] = []): NodeSnapshot[] {
  if (node == null || typeof node === 'boolean') return acc;
  if (typeof node === 'number') {
    // Numbers render as text — capture them so {ev.tokens} assertions work.
    acc.push({ tag: '#text', text: String(node), hasSpinner: false, hasCursor: false });
    return acc;
  }
  if (typeof node === 'string') {
    acc.push({ tag: '#text', text: node, hasSpinner: false, hasCursor: false });
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n, acc);
    return acc;
  }
  if (typeof node === 'object' && 'type' in node) {
    const el = node as React.ReactElement;
    const tag = typeof el.type === 'string' ? el.type : (el.type as { name?: string }).name ?? 'Component';
    const children = (el.props as { children?: React.ReactNode }).children;
    const text = typeof children === 'string' ? children : '';
    const isSpinner = tag === 'Spinner';
    const hasCursor = typeof children === 'string' && children.includes('▌');
    acc.push({ tag, text, hasSpinner: isSpinner, hasCursor });
    walk(children, acc);
    return acc;
  }
  return acc;
}

function snapshot(ev: TranscriptEvent): NodeSnapshot[] {
  const snap = walk(renderEvent(ev));
  // Derive `hasCursor` from any descendant text node containing '▌'.
  // (The walk function only sees direct string children of an element,
  //  but JSX often splits text into arrays of strings/numbers, so we
  //  check the concatenated text instead.)
  const cursorPresent = snap.some((n) => n.tag === '#text' && n.text.includes('▌'));
  return snap.map((n) => ({ ...n, hasCursor: cursorPresent || n.hasCursor }));
}

function hasText(snap: NodeSnapshot[], needle: string): boolean {
  // Concatenate all #text nodes — JSX often splits a single phrase like
  // "Thought for 2.5s" across multiple string children of the same <Text>.
  const joined = snap
    .filter((n) => n.tag === '#text')
    .map((n) => n.text)
    .join('');
  return joined.includes(needle);
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('TranscriptView.renderEvent — user events', () => {
  test('renders the prompt marker and text', () => {
    const snap = snapshot(makeUserEvent(1, 'Fix the auth test'));
    assert.ok(hasText(snap, 'Fix the auth test'));
    assert.ok(hasText(snap, '❯'));
  });
});

describe('TranscriptView.renderEvent — thinking events', () => {
  test('streaming thinking shows a Spinner and accumulated text', () => {
    const ev: TranscriptEvent = { ...makeThinkingEvent(1), text: 'Inspecting auth...' } as TranscriptEvent;
    const snap = snapshot(ev);
    assert.ok(snap.some((n) => n.hasSpinner));
    assert.ok(hasText(snap, 'Inspecting auth...'));
  });

  test('finished thinking shows the duration, no Spinner', () => {
    const ev: TranscriptEvent = {
      kind: 'thinking',
      id: 1,
      text: 'done',
      streaming: false,
      timestamp: Date.now(),
      durationMs: 2500,
    };
    const snap = snapshot(ev);
    assert.ok(!snap.some((n) => n.hasSpinner));
    assert.ok(hasText(snap, 'Thought for 2.5s'));
  });
});

describe('TranscriptView.renderEvent — assistant events', () => {
  test('streaming assistant shows the ▌ cursor', () => {
    const ev: TranscriptEvent = { ...makeAssistantEvent(1), text: 'partial answer' } as TranscriptEvent;
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'partial answer'));
    assert.ok(snap.some((n) => n.hasCursor), 'expected a ▌ cursor on a streaming assistant event');
  });

  test('finished assistant does NOT show the ▌ cursor', () => {
    const ev: TranscriptEvent = {
      kind: 'assistant',
      id: 1,
      text: 'final answer',
      streaming: false,
      timestamp: Date.now(),
    };
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'final answer'));
    assert.ok(!snap.some((n) => n.hasCursor));
  });
});

describe('TranscriptView.renderEvent — plan events', () => {
  test('renders the task id, title, status, attempts', () => {
    const ev: TranscriptEvent = makePlanEvent(1, 'auth-fix', 'Fix auth test', 'Align expiresAt', 3);
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'auth-fix'));
    assert.ok(hasText(snap, 'Fix auth test'));
    assert.ok(hasText(snap, 'pending'));
    assert.ok(hasText(snap, '0/3'));
  });

  test('blocked plan renders the failureReason', () => {
    const ev: TranscriptEvent = {
      ...makePlanEvent(1, 'x', 'Task', 'Obj', 2),
      status: 'blocked' as const,
      attempts: 2,
      failureReason: 'Still failing after 2 attempts',
    } as TranscriptEvent;
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'Still failing after 2 attempts'));
    assert.ok(hasText(snap, 'blocked'));
  });
});

describe('TranscriptView.renderEvent — tool events', () => {
  test('running tool shows a Spinner', () => {
    const ev: TranscriptEvent = { ...makeToolEvent(1, 'read_file', { path: '/etc/hosts' }) } as TranscriptEvent;
    const snap = snapshot(ev);
    assert.ok(snap.some((n) => n.hasSpinner));
    assert.ok(hasText(snap, 'read_file'));
    assert.ok(hasText(snap, '/etc/hosts'));
  });

  test('successful tool shows ✓ and a truncated result', () => {
    const ev: TranscriptEvent = {
      ...makeToolEvent(1, 'read_file', { path: '/x' }),
      status: 'success',
      result: 'x'.repeat(200),
      durationMs: 12,
    } as TranscriptEvent;
    const snap = snapshot(ev);
    assert.ok(hasText(snap, '✓'));
    // Result truncation: 77 chars + '…' = 78 chars total in the rendered text
    assert.ok(snap.some((n) => n.text.includes('…')));
  });

  test('errored tool shows ✗ and the error', () => {
    const ev: TranscriptEvent = {
      ...makeToolEvent(1, 'run_shell', { command: 'rm -rf /' }),
      status: 'error',
      error: 'Permission denied',
      durationMs: 5,
    } as TranscriptEvent;
    const snap = snapshot(ev);
    assert.ok(hasText(snap, '✗'));
    assert.ok(hasText(snap, 'Permission denied'));
  });
});

describe('TranscriptView.renderEvent — file_op events', () => {
  test('renders op + path + byte count', () => {
    const ev: TranscriptEvent = {
      kind: 'file_op',
      id: 1,
      op: 'edit',
      path: '/src/auth.ts',
      timestamp: Date.now(),
      bytes: 1234,
    };
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'edit'));
    assert.ok(hasText(snap, '/src/auth.ts'));
    assert.ok(hasText(snap, '1234 bytes'));
  });

  test('rename renders the toPath', () => {
    const ev: TranscriptEvent = {
      kind: 'file_op',
      id: 1,
      op: 'rename',
      path: '/old.ts',
      toPath: '/new.ts',
      timestamp: Date.now(),
    };
    const snap = snapshot(ev);
    assert.ok(hasText(snap, '/old.ts'));
    assert.ok(hasText(snap, '/new.ts'));
  });
});

describe('TranscriptView.renderEvent — mcp events', () => {
  test('connected mcp server renders green', () => {
    const ev: TranscriptEvent = {
      kind: 'mcp',
      id: 1,
      server: 'filesystem',
      status: 'connected',
      timestamp: Date.now(),
    };
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'filesystem'));
    assert.ok(hasText(snap, 'connected'));
  });

  test('errored mcp server renders the error', () => {
    const ev: TranscriptEvent = {
      kind: 'mcp',
      id: 1,
      server: 'binance',
      status: 'error',
      error: 'API key missing',
      timestamp: Date.now(),
    };
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'binance'));
    assert.ok(hasText(snap, 'API key missing'));
  });
});

describe('TranscriptView.renderEvent — error events', () => {
  test('renders category + message', () => {
    const ev: TranscriptEvent = makeErrorEvent(
      1,
      'ollama_unreachable',
      'Failed to connect to localhost:11434',
    );
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'ollama_unreachable'));
    assert.ok(hasText(snap, 'Failed to connect to localhost:11434'));
  });
});

describe('TranscriptView.renderEvent — elicitation events', () => {
  test('unanswered elicitation shows awaiting response', () => {
    const ev: TranscriptEvent = {
      kind: 'elicitation' as const,
      id: 1,
      toolName: 'write_file',
      arguments: { path: '/etc/passwd' },
      prompt: 'Allow write to /etc/passwd?',
      timestamp: Date.now(),
    };
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'write_file'));
    assert.ok(hasText(snap, 'Allow write to /etc/passwd?'));
    assert.ok(hasText(snap, 'awaiting response'));
  });

  test('resolved elicitation shows the choice', () => {
    const ev: TranscriptEvent = {
      kind: 'elicitation' as const,
      id: 1,
      toolName: 'write_file',
      arguments: { path: '/etc/passwd' },
      prompt: 'Allow?',
      timestamp: Date.now(),
      choice: 'deny' as const,
      resolvedAt: Date.now(),
    };
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'deny'));
  });
});

describe('TranscriptView.renderEvent — usage events', () => {
  test('renders scope + tokens + context window', () => {
    const ev: TranscriptEvent = makeUsageEvent(1, 'total', 12345, 32768);
    const snap = snapshot(ev);
    assert.ok(hasText(snap, 'total'));
    assert.ok(hasText(snap, '12345'));
    assert.ok(hasText(snap, '32768'));
  });
});

describe('TranscriptView.renderEvent — exhaustiveness', () => {
  test('every event kind has a case (compile-time check via TS never type)', () => {
    // If a new event kind is added to types.ts without a renderEvent case,
    // the `default: { const _exhaustive: never = ev; }` line fails to compile.
    // So if this file compiles, every kind has a case. The runtime test
    // here just exercises one of each kind to make sure they don't throw.
    const samples: TranscriptEvent[] = [
      makeUserEvent(1, 'u'),
      makeThinkingEvent(2),
      makeAssistantEvent(3),
      makePlanEvent(4, 'p', 'P', 'O'),
      makeToolEvent(5, 't', {}),
      { kind: 'file_op', id: 6, op: 'read', path: '/x', timestamp: Date.now() },
      { kind: 'mcp', id: 7, server: 's', status: 'connected', timestamp: Date.now() },
      makeErrorEvent(8, 'c', 'm'),
      { kind: 'elicitation', id: 9, toolName: 't', arguments: {}, prompt: 'p', timestamp: Date.now() },
      makeUsageEvent(10, 'total', 1, 100),
      { kind: 'system' as const, id: 11, category: 'compacted', message: '5 events dropped', timestamp: Date.now() },
    ];
    for (const ev of samples) {
      const el = renderEvent(ev);
      assert.ok(el, `renderEvent(${ev.kind}) returned a falsy element`);
    }
  });
});

describe('TranscriptView.renderEvent — system events', () => {
  test('renders the ◈ marker, category, and message', () => {
    const ev: TranscriptEvent = {
      kind: 'system' as const,
      id: 1,
      category: 'compacted',
      message: '5 events dropped: user: Fix the auth test; thinking; assistant: I patched',
      timestamp: Date.now(),
    };
    const snap = snapshot(ev);
    assert.ok(hasText(snap, '◈'));
    assert.ok(hasText(snap, 'compacted'));
    assert.ok(hasText(snap, '5 events dropped'));
  });

  test('renders different categories (skill_loaded, model_switch)', () => {
    const ev1: TranscriptEvent = {
      kind: 'system' as const,
      id: 1,
      category: 'skill_loaded',
      message: 'Loaded skill: rails-architect',
      timestamp: Date.now(),
    };
    const ev2: TranscriptEvent = {
      kind: 'system' as const,
      id: 2,
      category: 'model_switch',
      message: 'Switched to qwen3:8b',
      timestamp: Date.now(),
    };
    assert.ok(hasText(snapshot(ev1), 'skill_loaded'));
    assert.ok(hasText(snapshot(ev1), 'rails-architect'));
    assert.ok(hasText(snapshot(ev2), 'model_switch'));
    assert.ok(hasText(snapshot(ev2), 'qwen3:8b'));
  });
});
