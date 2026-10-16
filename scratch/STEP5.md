# Step 5 — Port transcript into TUI

**Goal:** Replace the existing chat view (`Chat.tsx` + `ChatAccordion.tsx`,
~890 lines combined) with a transcript-driven view that consumes the
step-2 `TranscriptCallbacks` contract and the step-3 `runOllamaChat`
bridge. The gate criterion is "old chat view deleted" with full feature
parity (slash commands, autocomplete, tool execution, skill loading,
auto-mode continuation, MCP integration).

**Why this is hard:** `Chat.tsx` is tightly coupled to:
- `runAgentLoop` (the existing Ollama integration with tool execution,
  context compaction, tool-loop guards, slash command dispatch)
- The existing `ChatMessage[]` state shape (with `timestamp`, `thinking`,
  `tool_calls`, `tool_call_id` fields)
- `ChatAccordion` (an alternate "turn card" view)
- The `useFocusManager` keyboard focus system
- The slash command system (`/model`, `/skills`, `/accordion`, `/style`, ...)
- Auto-mode continuation (multi-step plan chains without Y/N prompts)
- MCP server lifecycle and tool registration

Wholesale replacement would touch every one of these subsystems.

## Strategy: parallel path, not replacement

This PR (step 5 batch 1) ships the **new artifacts** that the future
replacement needs, without touching the existing flow:

1. **`src/components/TranscriptView.tsx`** — pure renderer for any
   `TranscriptEvent[]` inside a `ScrollBox`. Exhaustive over the 10
   event kinds. Handles streaming `▌` cursor, `Spinner` for thinking,
   duration formatting, tool result truncation, elicitation choices.
2. **`src/hooks/useTranscript.ts`** — wraps `useReducer(transcriptReducer,
   initialTranscriptState)` + `createTranscriptCallbacks`. Returns a
   stable `{ state, cb, clear }` triple.
3. **`test/TranscriptView.test.ts`** — 19 unit tests for the renderer,
   no rendering required. Walks the React element tree directly to
   assert text content, cursor presence, Spinner presence, exhaustiveness.

The artifacts are wired so that the next batch can land the integration
without rewriting them:

```tsx
// Future Chat.tsx (step 5 batch 2):
const { state, cb, clear } = useTranscript();
// On user submit:
cb.add(makeUserEvent(cb.nextId(), text));
await runOllamaChat(client, cb, { model, messages: [...], think: true });
// Render:
return <TranscriptView events={state.events} height={chatHeight} />;
```

## What's NOT done in this batch

- `Chat.tsx` still uses `setMessages(prev => [...prev, ...])` and `runAgentLoop`.
- The existing `'stream'` and `'accordion'` view modes are unchanged.
- `Ctrl+A` still toggles between `'stream'` and `'accordion'` — no
  `'transcript'` view mode yet.
- The transcript path doesn't yet handle: slash commands, autocomplete,
  skill loading, auto-mode continuation, MCP, tool execution (the bridge
  dispatches tool_call events but doesn't execute the underlying tools).

## Path to completion (future batches)

### Step 5 batch 2 — add the transcript view mode alongside the existing ones

- Extend `viewMode` type to `'stream' | 'accordion' | 'transcript'`.
- Change `Ctrl+A` to cycle through all three.
- Render `<TranscriptView events={transcriptState.events} height={chatHeight} />`
  when `viewMode === 'transcript'`.
- When the user submits a message in `'transcript'` mode, dispatch to
  the transcript callbacks (`cb.add(makeUserEvent(...))` +
  `runOllamaChat(client, cb, ...)`). The existing `'stream'` and
  `'accordion'` modes keep using `setMessages` + `runAgentLoop`.
- This lets users A/B compare the two paths live.

### Step 5 batch 3 — port slash commands to the transcript path

- Each slash command (e.g. `/model`, `/skills`, `/clear`) becomes either:
  - A transcript action (e.g. `/clear` → `cb.clear()`).
  - A side-effect that updates config + emits an event (e.g. `/model foo`
    → save config + `cb.add(makeSystemEvent(...))` — needs a new event
    kind, or reuse `usage`/`error`).
  - A no-op in transcript mode (e.g. `/accordion` is irrelevant).

### Step 5 batch 4 — port tool execution to the bridge

- Currently `runOllamaChat` dispatches `tool_call` events but doesn't
  execute the underlying tools. `runAgentLoop` does, via
  `registry.executeToolCalls(...)`.
- The bridge needs an optional `onToolCall` callback that:
  1. Receives the `ToolCall` from the SDK.
  2. Calls the existing registry to execute it.
  3. Returns the result + duration.
  4. The bridge then dispatches a `patch` action with `makeToolResultPatch(...)`.
- This lifts tool execution out of `runAgentLoop` and into a callback
  the bridge can call.

### Step 5 batch 5 — port auto-mode continuation

- The current `PendingContinuation` + `resolvePendingContinuation` logic
  in `Chat.tsx` needs to dispatch `plan` events into the transcript when
  tasks complete or turn limits are hit.

### Step 5 batch 6 — delete the old flow

- Once the transcript path reaches feature parity with `'stream'` and
  `'accordion'`, delete:
  - `setMessages` state + `ChatMessage` interface (use `transcriptState`
    instead).
  - `runAgentLoop` (replaced by `runOllamaChat` + `onToolCall`).
  - `ChatAccordion.tsx` (replaced by `TranscriptView`).
  - The `viewMode` state itself (only one view left).

## Current state (after this PR)

- `TranscriptView.tsx` + `useTranscript.ts` + tests are landed and exercised.
- The contract is proven end-to-end in the live app — boot-test the
  PoC with `npx tsx scratch/transcript-poc.tsx --real` to see real
  Ollama streaming flow through `runOllamaChat` → `TranscriptCallbacks`
  → `transcriptReducer` → (in the PoC, not yet in Chat.tsx) → `ScrollBox`.
- The integration into `Chat.tsx` is the next batch.
