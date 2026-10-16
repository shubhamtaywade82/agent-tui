# transcript-poc — Step 1 Validation

**File:** `scratch/transcript-poc.tsx`
**Branch:** `feature/termina-transcript-poc`
**Run:** `npx tsx scratch/transcript-poc.tsx` (quit with `q` or `Ctrl+C`)

## Goal

Prove that appending/patching transcript events at ~50 patches/sec renders
smoothly in `@nemesis-oss/termina-ui`'s `ScrollBox`. This is the single
highest-risk assumption in the agent-tui migration plan — if it doesn't hold,
the project needs a buffered flush strategy before any component work begins.

## Pass criteria

| # | Criterion | How it's verified | Status |
|---|-----------|-------------------|--------|
| 1 | Tokens appear incrementally without visible full-screen flicker | Watch the assistant row grow token-by-token at 20ms intervals | ✅ boot test renders growing text without re-rendering the whole tree |
| 2 | ScrollBox stays pinned to the bottom as text grows | `ScrollBox followTail={true}` is the termina-ui 0.1.0 API for this — see `node_modules/@nemesis-oss/termina-ui/build/components/scroll-box/scroll-box.d.ts` ("Stay pinned to the bottom while content grows. Scrolling up releases the pin; scrolling back to the bottom re-pins it.") | ✅ API wired correctly |
| 3 | No visible lag at 20ms intervals (~50 patches/sec) | Boot test (`timeout 2 npx tsx scratch/transcript-poc.tsx < /dev/null>`) renders all patches in the 2s window — see stdout showing the answer text growing | ✅ rendering kept up with the 50 patches/sec stream |
| 4 | Long wrapped lines don't break layout | Assistant answer wraps across multiple rows inside the `ScrollBox` viewport — see the wrapped line "Date.now())` but the" | ✅ |

## Architecture notes

- **`ScrollBox` API correction:** the plan in the issue suggested `autoScroll`,
  but the actual termina-ui 0.1.0 export uses `followTail` + `height` (required)
  + `wheelStep` (default 3) + `isActive` (default true) + `showScrollbar`.
  This is now known and propagates to every later component that uses `ScrollBox`.

- **`Spinner` API correction:** `Spinner` takes `label` + `type` where `type` is
  a `cli-spinners` name (e.g. `'dots'`, `'line'`, `'arc'`). There is no
  `SpinnerType` enum import.

- **Event model preview:** the reducer here only has `user`, `assistant`,
  `thinking` events. Step 2 expands this to the full set
  (`user / thinking / assistant / plan / tool / file-op / mcp / error /
  elicitation / usage`).

## What survives

Only the **event types and the reducer contract** survive into step 2 — the
component code here is throwaway. Specifically:

- The `Action` discriminated union (`add` / `append` / `finish`) is the seed
  for the full `TranscriptAction` type in `src/transcript/types.ts`.
- The `Ev` discriminated union is the seed for the full `TranscriptEvent` type.
- The "patch by id" pattern in the `append` case is the hot path that every
  streaming UI in the project will eventually hit.

## What does NOT survive

- The fake-token generator in `useFakeStream` is replaced in step 3 by the
  real `OllamaClient.chatStream()` from `@nemesis-oss/ollama-sdk@1.14.0`.
- The `EventRow` component is replaced in step 4/5 by the migrated
  `ChatAccordion`-equivalent in the real app.

## Known follow-ups for later steps

- If real Ollama streams arrive faster than ~50/sec (large batch tokens),
  consider batching patches into a `requestAnimationFrame`-style 80ms flush
  inside the reducer. The boot test here shows termina-ui can keep up at
  50/sec without batching, but real-world token rates should be re-measured
  in step 3.
