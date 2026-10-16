/**
 * transcript-poc.tsx — Step 1 vertical slice.
 *
 * GOAL: prove event-patch streaming renders smoothly in termina-ui's
 * `ScrollBox`. Success = 50+ patches/sec for ~5 seconds, no flicker,
 * `followTail` keeps the view pinned to the bottom, no visible lag,
 * wrapped long lines don't break layout.
 *
 * This file is THROWAWAY: it lives in `scratch/` and is not wired into
 * the real app. The only artifact that survives step 1 is the event
 * model that step 2 will extract into `src/transcript/types.ts`.
 *
 * Run with: npx tsx scratch/transcript-poc.tsx
 * Quit with: q (or Ctrl+C)
 */
import React, { useReducer, useEffect, useRef } from 'react';
import { Box, Text, render, useInput, useWindowSize, useApp } from '@nemesis-oss/termina-core';
import { ScrollBox, Spinner, ThemeProvider, defaultTheme } from '@nemesis-oss/termina-ui';

/* ------------------------------------------------------------------ *
 * Event model (mini — step 2 expands this to the full set)
 * ------------------------------------------------------------------ */
type Ev =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string; streaming: boolean }
  | { kind: 'thinking'; id: number; text: string; streaming: boolean };

type Action =
  | { type: 'add'; ev: Ev }
  | { type: 'append'; id: number; delta: string }
  | { type: 'finish'; id: number };

let seq = 0;
const nextId = () => ++seq;

function reducer(state: Ev[], action: Action): Ev[] {
  switch (action.type) {
    case 'add':
      return [...state, action.ev];
    case 'append':
      // THE hot path — runs per token. Render cost is what we're measuring.
      return state.map((ev) =>
        ev.id === action.id && 'text' in ev
          ? ({ ...ev, text: ev.text + action.delta } as Ev)
          : ev,
      );
    case 'finish':
      return state.map((ev) =>
        ev.id === action.id && 'streaming' in ev ? ({ ...ev, streaming: false } as Ev) : ev,
      );
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ *
 * Fake token generator — produces realistic streaming traffic at
 * ~50 patches/sec so we can measure render cost without depending
 * on Ollama. Step 3 swaps this for `client.chatStream()`.
 * ------------------------------------------------------------------ */
const THINKING_TOKENS =
  'The token expiresAt comparison is off by one — the test uses < but the source uses <=. I should check the auth test file first, then patch the source, then re-run the test to confirm the fix is real.'.split(
    ' ',
  );
const ANSWER_TOKENS =
  'Looking at `auth.test.ts` line 47, the assertion is `expect(token.expiredAt < Date.now())` but the implementation in `auth.ts` line 23 uses `<=`, which means a token that expires exactly at `Date.now()` is treated as still valid in the source but invalid in the test. The fix is to align both sides on the same operator — I recommend `<=` in both because it is the safer choice for security-sensitive code. After patching, re-run `npm test auth` to verify.'.split(
    ' ',
  );

function useFakeStream(dispatch: React.Dispatch<Action>) {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    dispatch({
      type: 'add',
      ev: { kind: 'user', id: nextId(), text: 'Fix the auth test — it is failing intermittently.' },
    });
    const thinkId = nextId();
    const ansId = nextId();
    dispatch({ type: 'add', ev: { kind: 'thinking', id: thinkId, text: '', streaming: true } });
    dispatch({ type: 'add', ev: { kind: 'assistant', id: ansId, text: '', streaming: true } });

    let i = 0;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const patchCount = i;
      if (patchCount < THINKING_TOKENS.length) {
        dispatch({ type: 'append', id: thinkId, delta: THINKING_TOKENS[patchCount] + ' ' });
      } else if (patchCount < THINKING_TOKENS.length + ANSWER_TOKENS.length) {
        // Transition: mark thinking as done on first answer token.
        if (patchCount === THINKING_TOKENS.length) {
          dispatch({ type: 'finish', id: thinkId });
        }
        const idx = patchCount - THINKING_TOKENS.length;
        dispatch({ type: 'append', id: ansId, delta: ANSWER_TOKENS[idx] + ' ' });
      } else {
        clearInterval(timer);
        dispatch({ type: 'finish', id: ansId });
        const elapsedMs = Date.now() - startedAt;
        // eslint-disable-next-line no-console
        console.error(`[transcript-poc] stream finished in ${elapsedMs}ms over ${i} patches`);
        return;
      }
      i++;
    }, 20); // ~50 patches/sec — realistic streaming rate
  }, [dispatch]);
}

/* ------------------------------------------------------------------ *
 * Renderers
 * ------------------------------------------------------------------ */
function EventRow({ ev }: { ev: Ev }) {
  if (ev.kind === 'user') {
    return (
      <Box flexDirection="row">
        <Text color="cyan" bold>
          ❯{' '}
        </Text>
        <Text>{ev.text}</Text>
      </Box>
    );
  }
  if (ev.kind === 'thinking') {
    return ev.streaming ? (
      <Box flexDirection="row">
        <Spinner label="Thinking…" type="dots" />
        <Text dimColor> {ev.text}</Text>
      </Box>
    ) : (
      <Text dimColor italic>
        ⏵ Thought for 2.5s
      </Text>
    );
  }
  // assistant
  return (
    <Text wrap="wrap">
      {ev.text}
      {ev.streaming ? ' ▌' : ''}
    </Text>
  );
}

function PoC() {
  const [events, dispatch] = useReducer(reducer, [] as Ev[]);
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();

  useFakeStream(dispatch);

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
            <Text dimColor> — termina-ui ScrollBox streaming validation</Text>
          </Box>
          <Box paddingX={1}>
            <Text dimColor>
              events: {events.length} · scrollHeight: {scrollHeight} · cols: {columns}
            </Text>
          </Box>
        </Box>

        {/* Scrollable transcript — followTail pins to bottom while content grows */}
        <Box paddingX={1}>
          <ScrollBox height={scrollHeight} followTail={true} showScrollbar={true}>
            {events.map((ev) => (
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
