# UX Overhaul: smooth scrolling, mouse interactions, clickable elicitation

This pass fixes the three biggest UX complaints about the TUI:

1. **"Line by line scrolling — not smooth, not professional"**
2. **"The conversation layout doesn't allow clicking components"**
3. **"Elicitation is key-press only, no mouse click support"**

All existing keyboard shortcuts keep working; the mouse is additive.

---

## Root causes found

### 1. Mouse was dead on arrival (upstream bug)
`@nemesis-oss/termina-core@0.1.0` ships a corrupted constant:

```js
// node_modules/@nemesis-oss/termina-core/build/mouse.js
export const mouseTrackingEnable = '\u{1B}\u{1B}\u{1B}';              // ← corrupted
export const mouseTrackingDisable = '\u{1B}[?1006l\u{1B}[?1002l\u{1B}[?1000l]'; // correct
```

The enable sequence should be `\x1b[?1000h\x1b[?1002h\x1b[?1006h` (click /
drag / SGR-coordinate reporting). Three bare ESC bytes enable nothing, so the
framework's `MouseRouter` (already mounted via `render(..., {mouse: true})`)
never received a single report — and no component used `Box onClick / onWheel`
anyway. **Fix:** `src/components/ui/mouse/mouseTrackingShim.tsx` writes the
correct sequence at app mount. Once tracking works, the framework's
hit-tested mouse dispatch (real Yoga layout hit testing, including clipped
scroll containers) lights up for free.

### 2. Per-token full re-render (streaming jank)
`Chat.tsx` rebuilt the *entire* `messageRows` array (every row of every turn)
on **every streamed token** (`useMemo` depended on `streamedThinking` /
`streamedContent`), then re-sliced it inside ScrollArea. Long conversations
repainted dozens of times per second.

**Fixes:**
- **Token batching** — stream deltas buffer in a ref and flush to React state
  on a ~40ms cadence (≈25fps ceiling, exactly how a professional chat client
  behaves). Buffers flush immediately at turn end / cancel / reset.
- **Per-turn element cache** — completed turns keep their message-object
  identity, so their rendered rows are reused across flushes; only the active
  streaming turn rebuilds. Cache key covers layout width + per-turn view flags.

### 3. Frame overflow (the actual "line-by-line" crawl)
The app runs fullscreen in the alternate screen (already configured in
`index.tsx`). When the plan-continuation panel appeared (+5–6 rows), the total
frame exceeded the viewport and the terminal scrolled inside the alternate
screen — the whole UI visibly crawled down line by line. `chatHeight` accounted
for toasts and the suggestion menu but **not** the continuation panel.

**Fix:** `contOverhead` is now subtracted from the chat viewport, keeping the
frame exactly `rows` tall in every state combination.

### 4. Wheel scroll dropped flicks
The old styled scroll path clamped wheel accumulation to ±5 rows per 20ms
window (fast flicks were discarded) and moved 1 row per tick by default.

---

## What changed, file by file

| File | Change |
|---|---|
| `src/components/ui/mouse/mouseTrackingShim.tsx` | **New.** Writes the correct mouse-enable escape sequence; compensates the upstream bug. Delete when termina-core fixes the constant. |
| `src/components/ui/hooks/useMouse.ts` | Rewritten as a thin wrapper over the framework's `useMouse` (parsed events, no raw `stdin.on('data')` listener — the push/pull mix with the framework's `stdin.read()` loop was fragile). Legacy API (`useMouseScroll`, `isPointInside`, types) preserved. |
| `src/components/ui/scroll-area/ScrollArea.tsx` | **Full rebuild.** Renders children inside a `contentOffsetY`-shifted viewport (`overflow: hidden`) — scrolling no longer re-slices or re-creates children. Wheel = 3 rows/tick (configurable `wheelStep`), flicks accumulate unclamped, user scrolls **ease** over ~90ms (ease-out quad), tail-follow **snaps** so streaming never lags. Tail release/re-engage tracking + `onScroll(offset, total)` telemetry. Wheel works regardless of keyboard focus (hit-tested on the viewport). `Infinity` offset = jump to bottom (legacy Chat convention). |
| `src/components/Chat.tsx` | Token batching; per-turn row cache; clickable everything (below); `contOverhead` height fix; scroll telemetry state powering the footer pills; click-to-focus on chat + input areas. |
| `src/components/ChatAccordion.tsx` | `renderSingleTurn` supports collapsed turns + per-turn click handlers (fold, thinking toggle, tool-call inspect). Accordion headers are clickable (select + fold). |
| `src/components/ui/thinking/Thinking.tsx` | Controlled `expanded` / `onToggle` props; header row is click-activated. |
| `src/components/ui/tool-call/ToolCall.tsx` | Controlled `expanded` prop + `onClick` on the header row. |
| `src/components/ui/tabs/Tabs.tsx` | All variants activate on click. |
| `src/components/ui/select/Select.tsx` | Item rows activate on click (disabled items guarded). |
| `src/components/ui/dialog/Dialog.tsx` | Action buttons activate on click. |
| `src/components/ui/confirm/Confirm.tsx` | Clickable `[ Yes ]` / `[ No ]`. |
| `src/components/ui/approval-gate/ApprovalGate.tsx` | Clickable Approve once / Always allow / Deny. |
| `src/App.tsx` | Mounts the mouse shim; clickable model chip in the header; `loadAvailableSkills()` memoized (was a sync FS scan **per render frame**). |
| `src/index.tsx` | `--inline` flag / `AGENT_TUI_INLINE=1` opts out of fullscreen. Fullscreen (alternate screen) remains the default. |
| `scripts/boot-smoke.sh` | **New.** PTY-based smoke test: boots the app, asserts alt-screen + mouse sequences, injects a real SGR click on the System tab and asserts the view switches, exits via Ctrl+C. |

## Mouse map (what you can click now)

- **Conversation (stream view)** — turn header: collapse/expand the turn;
  Thought line: expand/collapse the thinking trace; tool-call row: inspect
  args; click anywhere in the conversation to focus scroll mode.
- **Header** — Chat/System tab pills; `Model: …` chip opens the model modal.
- **Elicitation** — plan-continuation `▶ Continue` / `⏸ Pause` buttons;
  modal `Select` items; `Dialog` actions; `Confirm` Yes/No;
  `ApprovalGate` y/a/n options.
- **Footer** — `▲ Top`, `▼ N below — Jump to latest`, `▼ Bottom` pills.
- **Suggestions menu** — rows run the command (or fill the input when args
  are needed).
- **Wheel** — 3 rows/tick anywhere over the conversation, even while typing;
  flicks accumulate; eased glide.

## Validation

- `npm run typecheck` — clean.
- `npm test` — 120/120 pass.
- `bash scripts/boot-smoke.sh` — 9/9 (alt screen, mouse enable/disable,
  frame paint, real click dispatch, clean Ctrl+C exit).
