/**
 * transcript-poc.tsx — Step 1 vertical slice, updated for Step 3.
 *
 * GOAL (unchanged from step 1): prove event-patch streaming renders
 * smoothly in termina-ui's `ScrollBox`. 50+ patches/sec for ~5 seconds,
 * no flicker, `followTail` keeps the view pinned to the bottom, no
 * visible lag, wrapped long lines don't break layout.
 *
 * WHAT'S NEW IN STEP 3: the inline `Ev` / `Action` / `reducer` are gone.
 * The slice now consumes the REAL step-2 contract:
 *   - `transcriptReducer` from src/transcript/reducer.ts
 *   - `createTranscriptCallbacks` + factories from src/transcript/callbacks.ts
 *   - `runOllamaChat` from src/transcript/ollama-bridge.ts
 *
 * RUN MODES:
 *   - default (fake stream): npx tsx scratch/transcript-poc.tsx
 *     Uses the fake-token generator from step 1 — works without Ollama.
 *   - real Ollama:           npx tsx scratch/transcript-poc.tsx --real
 *     Connects to localhost:11434, model qwen3:8b (or OLLAMA_MODEL env var),
 *     and runs a real chatStream through the bridge. Validates that the
 *     SDK's actual event shapes (thinking / token / done / usage) drive the
 *     transcript correctly.
 *
 * Quit with: q (or Ctrl+C)
 */
import React, { useReducer, useEffect, useMemo, useRef } from 'react';
import { Box, Text, render, useInput, useWindowSize, useApp } from '@nemesis-oss/termina-core';
import { ScrollBox, Spinner, ThemeProvider, defaultTheme } from '@nemesis-oss/termina-ui';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import {
  createTranscriptCallbacks,
  initialTranscriptState,
  makeUserEvent,
  runOllamaChat,
  transcriptReducer,
} from '../src/transcript/index.js';
import type { TranscriptCallbacks, TranscriptState } from '../src/transcript/index.js';

/* ------------------------------------------------------------------ *
 * Fake token generator — same as step 1, now driven via the real
 * TranscriptCallbacks contract so engine code paths are exercised.
 * ------------------------------------------------------------------ */
const THINKING_TOKENS =
  'The token expiresAt comparison is off by one — the test uses < but the source uses <=. I should check the auth test file first, then patch the source, then re-run the test to confirm the fix is real.'.split(
    ' ',
  );
const ANSWER_TOKENS =
  'Looking at `auth.test.ts` line 47, the assertion is `expect(token.expiredAt < Date.now())` but the implementation in `auth.ts` line 23 uses `<=`, which means a token that expires exactly at `Date.now()` is treated as still valid in the source but invalid in the test. The fix is to align both sides on the same operator — I recommend `<=` in both because it is the safer choice for security-sensitive code. After patching, re-run `npm test auth` to verify.'.split(
    ' ',
  );

function useFakeStream(cb: TranscriptCallbacks, enabled: boolean) {
  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;

    cb.add(makeUserEvent(cb.nextId(), 'Fix the auth test — it is failing intermittently.'));
    const thinkId = cb.nextId();
    const ansId = cb.nextId();
    // Mimic what `runOllamaChat` does — mint thinking + assistant events
    // via the factories, then drive append/finish through the callbacks.
    cb.add({ kind: 'thinking', id: thinkId, text: '', streaming: true, timestamp: Date.now() });
    cb.add({ kind: 'assistant', id: ansId, text: '', streaming: true, timestamp: Date.now() });

    const startedAt = Date.now();
    let i = 0;
    const timer = setInterval(() => {
      if (i < THINKING_TOKENS.length) {
        cb.append(thinkId, THINKING_TOKENS[i] + ' ');
      } else if (i < THINKING_TOKENS.length + ANSWER_TOKENS.length) {
        if (i === THINKING_TOKENS.length) {
          cb.finish(thinkId, Date.now() - startedAt);
        }
        const idx = i - THINKING_TOKENS.length;
        cb.append(ansId, ANSWER_TOKENS[idx] + ' ');
      } else {
        clearInterval(timer);
        cb.finish(ansId, Date.now() - startedAt);
        const elapsedMs = Date.now() - startedAt;
        // eslint-disable-next-line no-console
        console.error(`[transcript-poc] fake stream finished in ${elapsedMs}ms over ${i} patches`);
        return;
      }
      i++;
    }, 20); // ~50 patches/sec
  }, [cb, enabled]);
}

/* ------------------------------------------------------------------ *
 * Real Ollama stream — uses the bridge from step 3.
 * ------------------------------------------------------------------ */
function useRealOllamaStream(cb: TranscriptCallbacks, enabled: boolean) {
  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;

    const model = process.env.OLLAMA_MODEL || 'qwen3:8b';
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const userText = 'Fix the auth test — it is failing intermittently.';
    const client = new OllamaClient({ baseUrl });
    const controller = new AbortController();

    cb.add(makeUserEvent(cb.nextId(), userText));
    runOllamaChat(client, cb, {
      model,
      messages: [{ role: 'user', content: userText }],
      think: true,
      signal: controller.signal,
      contextWindow: 32768,
    })
      .then((r) => {
        // eslint-disable-next-line no-console
        console.error(
          `[transcript-poc] real ollama stream finished in ${r.durationMs}ms; usage:`,
          r.finalResult.usage,
        );
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[transcript-poc] real ollama stream failed:', err);
      });

    return () => controller.abort();
  }, [cb, enabled]);
}

/* ------------------------------------------------------------------ *
 * Renderer — handles every event kind the model can produce.
 * In step 4/5 this becomes a real `TranscriptView` in the app, but the
 * throwaway renderer here proves the contract end-to-end.
 * ------------------------------------------------------------------ */
function EventRow({ ev }: { ev: TranscriptState['events'][number] }) {
  switch (ev.kind) {
    case 'user':
      return (
        <Box flexDirection="row">
          <Text color="cyan" bold>
            ❯{' '}
          </Text>
          <Text>{ev.text}</Text>
        </Box>
      );
    case 'thinking':
      return ev.streaming ? (
        <Box flexDirection="row">
          <Spinner label="Thinking…" type="dots" />
          <Text dimColor> {ev.text}</Text>
        </Box>
      ) : (
        <Text dimColor italic>
          ⏵ Thought for {((ev.durationMs ?? 0) / 1000).toFixed(1)}s
        </Text>
      );
    case 'assistant':
      return (
        <Text wrap="wrap">
          {ev.text}
          {ev.streaming ? ' ▌' : ''}
        </Text>
      );
    case 'tool':
      return (
        <Box flexDirection="row">
          <Text color="magenta" bold>
            ⏺{' '}
          </Text>
          <Text bold>{ev.name}</Text>
          <Text dimColor> ({JSON.stringify(ev.arguments)})</Text>
          {ev.status === 'running' ? <Spinner type="dots" /> : null}
        </Box>
      );
    case 'usage':
      return (
        <Text dimColor>
          ↳ usage {ev.scope}: {ev.tokens} tokens (ctx {ev.contextWindow})
        </Text>
      );
    case 'error':
      return (
        <Text color="red" bold>
          ✗ {ev.category}: {ev.message}
        </Text>
      );
    case 'plan':
    case 'file_op':
    case 'mcp':
    case 'elicitation':
      // The PoC doesn't drive these, but the renderer is exhaustive.
      return (
        <Text dimColor>
          [{ev.kind}] {JSON.stringify(ev)}
        </Text>
      );
    default: {
      const _exhaustive: never = ev;
      void _exhaustive;
      return null;
    }
  }
}

function PoC() {
  const [state, dispatch] = useReducer(transcriptReducer, initialTranscriptState);
  const cb = useMemo(() => createTranscriptCallbacks(dispatch, () => state), [dispatch, state]);
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();

  const realMode = process.argv.includes('--real');
  // Both hooks are called unconditionally (rules of hooks); the `enabled`
  // flags make exactly one of them actually run.
  useFakeStream(cb, !realMode);
  useRealOllamaStream(cb, realMode);

  // Quit handlers
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    }
  });

  const headerHeight = 3;
  const footerHeight = 2;
  const scrollHeight = Math.max(4, rows - headerHeight - footerHeight);

  return (
    <ThemeProvider theme={defaultTheme}>
      <Box flexDirection="column" width={columns}>
        {/* Header */}
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text bold color="green">
              transcript-poc
            </Text>
            <Text dimColor>
              {' '}
              — {realMode ? 'real Ollama chatStream' : 'fake stream'} · termina-ui ScrollBox
              validation
            </Text>
          </Box>
          <Box paddingX={1}>
            <Text dimColor>
              events: {state.events.length} · scrollHeight: {scrollHeight} · cols: {columns}
            </Text>
          </Box>
        </Box>

        {/* Scrollable transcript — followTail pins to bottom while content grows */}
        <Box paddingX={1}>
          <ScrollBox height={scrollHeight} followTail={true} showScrollbar={true}>
            {state.events.map((ev) => (
              <EventRow key={ev.id} ev={ev} />
            ))}
          </ScrollBox>
        </Box>

        {/* Footer */}
        <Box paddingX={1} flexDirection="column">
          <Text dimColor>─────────────────────────────────────────────</Text>
          <Text dimColor>[q] quit · [Ctrl+C] abort · [↑/↓] scroll</Text>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

render(<PoC />, { exitOnCtrlC: false });
