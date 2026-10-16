# Step 5 — Port transcript into TUI

**Goal:** Replace the existing chat view (`Chat.tsx` + `ChatAccordion.tsx`,
~890 lines combined) with a transcript-driven view that consumes the
step-2 `TranscriptCallbacks` contract and the step-3 `runOllamaChat`
bridge. The gate criterion is "old chat view deleted" with full feature
parity (slash commands, autocomplete, tool execution, skill loading,
auto-mode continuation, MCP integration).

**Why this is hard:** `Chat.tsx` is tightly coupled to `runAgentLoop`
(the existing Ollama integration with tool execution, context
compaction, tool-loop guards, slash command dispatch), the existing
`ChatMessage[]` state shape, `ChatAccordion`, the focus manager, the
slash command system, auto-mode continuation, and the MCP server
lifecycle. Wholesale replacement would touch every one of these.

## Strategy: parallel path, not replacement

Step 5 ships in batches. Each batch lands a piece of the new contract
without deleting the old flow. Users can switch between `stream` /
`accordion` / `transcript` view modes with `Ctrl+A` to compare.

## Completed batches

### Batch 1 (PR #12) — TranscriptView + useTranscript hook + tests

- `src/components/TranscriptView.tsx` — pure renderer for any
  `TranscriptEvent[]` inside a `ScrollBox`. Exhaustive over the 10
  event kinds. Handles streaming `▌` cursor, `Spinner` for thinking,
  duration formatting, tool result truncation, elicitation choices.
- `src/hooks/useTranscript.ts` — wraps `useReducer(transcriptReducer,
  initialTranscriptState)` + `createTranscriptCallbacks`. Returns a
  stable `{ state, cb, clear }` triple.
- `test/TranscriptView.test.ts` — 19 unit tests for the renderer.

### Batch 2 (PR #13) — Integrate TranscriptView into Chat.tsx as third viewMode

- `viewMode` extended: `'stream' | 'accordion' | 'transcript'`.
- `Ctrl+A` cycles through all three. `/transcript` slash command sets
  the mode directly.
- New render branch: `<TranscriptView events={transcriptState.events}
  height={chatHeight} isActive={...} width={columns} />` when
  `viewMode === 'transcript'`.
- New `runTranscriptPrompt()` called when in transcript mode on
  submit: mints a user event + calls `runOllamaChat(client, cb, ...)`.
- Status line shows `[Transcript · N events · streaming]` in transcript mode.

### Batch 4 (this PR) — Multi-turn tool execution in the bridge

- `runOllamaChat()` now accepts `onToolCall?: (toolCall) =>
  Promise<{ result, error?, durationMs }>` and `maxToolIterations?`
  (default 5).
- The bridge now LOOPS: when the model emits `tool_calls` and
  `onToolCall` is provided, each call is executed, the corresponding
  `tool` event is patched with `makeToolResultPatch(...)`, the result
  is appended to the message list, and the bridge recursively calls
  itself for another model turn.
- Each iteration mints fresh `thinking` + `assistant` events so the
  transcript shows the full agent loop visually:
  ```
  user → thinking → assistant → tool → tool → thinking → assistant → usage
  ```
- The loop stops when:
  - The model's response has no tool_calls (final answer), OR
  - `maxToolIterations` is reached (default 5; uses `autoMaxChains()`
    from the existing auto-mode config in `Chat.tsx`), OR
  - `onToolCall` was not provided (tool calls are recorded as events
    but not executed — useful for dry-run / display-only modes).
- `Chat.tsx`'s `runTranscriptPrompt` now wires `onToolCall` to delegate
  to the existing `ToolRegistry.executeToolCalls(...)`. The same
  registry that `runAgentLoop` uses is reused — no tool duplication.
- New `RunOllamaChatResult` fields: `iterations: number` and
  `hitIterationLimit: boolean`. Toast shows them:
  `Done in 2.3s · 3 turns` or `Done in 12.1s · 5 turns · hit iteration limit`.
- 6 new tests in `test/ollama-bridge.test.ts`:
  - executes tool calls and loops for a second turn
  - multiple tool calls in one turn are executed sequentially
  - tool callback error is surfaced as a failed tool result + error event
  - `maxToolIterations` cuts off the agent loop and sets `hitIterationLimit`
  - omitting `onToolCall` records tool_call events but does not execute
  - final answer (no tool calls) does not loop

## What's NOT done yet (deferred batches)

### Batch 3 — port slash commands to the transcript path

Each slash command needs to dispatch a transcript action:
- `/clear` → `cb.clear()`
- `/model foo` → save config + emit a system event (new event kind? or
  reuse `usage`/`error` — needs design)
- `/skills` → load skill body into the next `runOllamaChat` messages
- `/accordion`, `/transcript` → already work (batch 2)

### Batch 5 — auto-mode continuation

When a task runtime produces a `nextReady()` task or a turn limit is
hit, `Chat.tsx`'s `resolvePendingContinuation` decides whether to
chain another turn. In transcript mode, this should:
- Dispatch a `plan` event for the task (`makePlanEvent(...)`)
- Patch the plan event to `in_progress` before continuing
- Patch to `completed` / `blocked` when the chained turn finishes

### Batch 6 — delete the old flow

Once the transcript path reaches feature parity with `stream` and
`accordion`, delete:
- `setMessages` state + `ChatMessage` interface (use `transcriptState`).
- `runAgentLoop` (replaced by `runOllamaChat` + `onToolCall`).
- `ChatAccordion.tsx` (replaced by `TranscriptView`).
- The `viewMode` state itself (only one view left).

## Current state (after batch 4)

- `TranscriptView.tsx` + `useTranscript.ts` + `runOllamaChat` (with
  tool execution) all wired into `Chat.tsx` as the third view mode.
- `Ctrl+A` cycles through 3 modes. `/transcript` slash command sets
  the mode directly.
- The transcript path runs the same tool registry as `runAgentLoop` —
  no duplicate tool implementations.
- 115/115 tests pass (109 previous + 6 new multi-turn tests).
- Typecheck clean, main app boots cleanly.
- The remaining gap to feature parity is: slash commands (batch 3),
  auto-mode continuation (batch 5), skill loading (batch 5).
