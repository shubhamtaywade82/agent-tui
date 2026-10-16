# Termina Migration Playbook (Step 4)

**Goal:** Replace local copy-paste components in `src/components/ui/*` with the
`@nemesis-oss/termina-ui` npm package exports. The gate criterion is
`npm start` parity — the app boots and works the same as before.

**Why this is not pure mechanical churn:** the local copies were authored
against a custom `InkUITheme` system (`src/components/ui/_core.ts`) where every
component takes a `theme?: InkUITheme` prop. The npm package uses a different
`ThemeProvider` context with a `Theme.components[Name]` lookup. Most local
components also have prop shapes (`variant`, `style`, `width`, `theme`) that
don't exist on the npm equivalents.

**Strategy:** adapter modules. Replace each local component file with a thin
wrapper that:

1. Accepts the local prop shape (so existing consumers don't need to change).
2. Forwards a mapped version to the npm component.
3. Drops the `theme` prop — the npm component reads the theme from
   `<ThemeProvider theme={...}>` instead.

This keeps every consumer's import path unchanged (`./ui/spinner/index.js`
still works), so the migration is genuinely mechanical from the consumer's
perspective. Once all consumers are migrated, the adapters can shrink to
one-liners (or be deleted entirely with consumer imports updated).

## Migration batches

### Batch 1 (this PR)

| Component | Local API | NPM API | Adapter notes |
|-----------|-----------|---------|---------------|
| `Spinner` | `label`, `type` ('dots'/'line'/'arc'/'bounce'), `interval`, `theme` | `label`, `type` (any `cli-spinners` name) | Drops `interval` and `theme`. Maps local `SpinnerType` → `SpinnerName` (currently a 1:1 subset). |
| `Divider` | `title`, `style`, `width`, `theme`, `color` | `title` (auto-fills parent width, single `─`) | Fast path delegates to npm `Divider` when no extra styling is requested. Styled path re-implements the rule locally until consumers drop the extra props. |
| `Badge` | `children: string`, `variant`, `theme` | `children: ReactNode`, `color` (TextProps['color']) | Maps `variant` → color name ('success'→'green', 'warning'→'yellow', 'error'→'red', 'info'→'blue', 'default'→'gray'). Honors `theme` if provided for custom colors. |

**Validation:** 90/90 tests pass, typecheck clean, PoC boot-test renders all
three components through the adapter (Spinner inside thinking row, Divider as
header/footer rule, Badge in `src/App.tsx` header).

### Future batches (suggested order, low-risk first)

| Batch | Components | Notes |
|-------|------------|-------|
| 2 | `Gauge`, `ProgressBar` | Local uses `value`/`max`/`label`/`color`/`theme`; npm uses percent `value` only. Adapter computes `percent = (value / max) * 100`. |
| 3 | `Stepper`, `StatusIndicator` | `StatusIndicator` doesn't exist in npm — use `StatusMessage` with `variant` mapping. `Stepper` API matches (`steps` + `current`/`currentStep`). |
| 4 | `Table`, `Tabs`, `Dialog` | Local `Tabs` uses `tabs`+`activeKey`+`onChange`; npm `Tabs` uses `tabs`+`defaultId` (uncontrolled). Adapter needs to manage internal state. Local `Dialog` has `isOpen`/`actions`/`onAction`; npm `Dialog` has `title`/`children`/`onClose`. Adapter needs to render buttons as children. |
| 5 | `Select`, `TextInput`, `MultiSelect`, `Autocomplete` | Local `Select` uses `items`+`onSelect`; npm uses `options`+`onChange`. Local `TextInput` has autocomplete integration that the npm version doesn't. These are the biggest API deltas. |
| 6 | `ScrollArea`, `ScrollBox` | Local `ScrollArea` has rich API (`scrollOffset`, `onScrollOffsetChange`, `mouseScroll`, `autoScroll`). NPM `ScrollBox` is simpler. Adapter needs to wrap. |
| 7 | `Accordion`, `CodeBlock`, `DataTable`, `DiffView`, `Header`, `JSONViewer`, `KeyHint`, `LoadingBar`, `Markdown`, `Sparkline`, `StreamingText`, `TokenCounter`, `TreeView`, `Typewriter`, `Toast` | Mostly API-shape deltas. One at a time. |

### Local-only components (no npm equivalent)

| Component | Disposition |
|-----------|-------------|
| `_core.ts` | KEEP. Provides `InkUITheme`, `darkTheme`, `lightTheme`, `spacing`, `borderStyles`, `spinnerFrames` for the adapter shims. Delete only after all adapters shrink to one-liners. |
| `panel` | KEEP — no npm equivalent. Possibly rebuild using termina-core `Box` + border styles. |
| `approval-gate` | KEEP — app-specific composite component. |
| `confirm` | KEEP — local `Confirm` differs from npm `ConfirmInput`. |
| `thinking` | KEEP — agent-specific component. |
| `tool-call` | KEEP — agent-specific component. |
| `status-indicator` | REPLACE with npm `status-message` in a future batch. |
| `scroll-area` | REPLACE with npm `scroll-box` in a future batch. |

## Known issues

### Duplicate key warning from `Spinner`

The npm `Spinner` renders:

```js
React.createElement(Box, ...,
  React.createElement(Text, ..., frame),
  label && React.createElement(Text, ..., label));
```

When `label` is truthy, the children list is `[Text, Text]` without explicit
keys. On re-renders, React's reconciler emits:

> Encountered two children with the same key, `1`. Keys should be unique so
> that components maintain their identity across updates.

This is upstream in `@nemesis-oss/termina-ui@0.1.0`. The warning is cosmetic
— the Spinner renders correctly. To fix, the npm Spinner should add explicit
keys to its Text children. Until then, the adapter can't paper over it.

### Theme shape mismatch

Local `InkUITheme` has a flat `colors` record. NPM `Theme` has a `components`
record with per-component styles. The adapter pattern bridges these by:

1. Local `theme` prop → adapter looks up colors from `theme.colors.*` and
   passes them as the `color` prop to the underlying Text/Badge/etc.
2. No `theme` prop → adapter uses standard color names ('green', 'yellow',
   'red', 'blue', 'gray') which are built-in termina-core colors.

When the app is wrapped in `<ThemeProvider theme={defaultTheme}>` (as the PoC
is), the npm components pick up their styling from the context automatically.
The adapter's `theme` prop is a fallback for components that need a custom
color outside the standard set.

## How to add a new adapter

1. Read the local component's API in `src/components/ui/<name>/<Name>.tsx`.
2. Read the npm component's API in
   `node_modules/@nemesis-oss/termina-ui/build/components/<name>/<name>.d.ts`.
3. Replace `src/components/ui/<name>/<Name>.tsx` with a thin adapter:
   - Import the npm component: `import { Foo as TerminaFoo } from '@nemesis-oss/termina-ui';`
   - Re-export the local types (`FooProps`, etc.) unchanged.
   - Define the adapter component that accepts `FooProps` and forwards to
     `TerminaFoo` with mapped props.
   - Drop `theme?: InkUITheme` — read colors from `theme?.colors.X` if the
     adapter needs them, otherwise use the standard mapping.
4. Run `npx tsc --noEmit` — fix any type errors.
5. Run `npm test` — all 90 tests should pass.
6. Boot-test the PoC: `npx tsx scratch/transcript-poc.tsx` — verify the
   component renders correctly inside the scrollable transcript.
7. Commit with message `step 4 (batch N): migrate <name> to termina-ui`.

## Migration completion criteria

Step 4 is complete when:

- [ ] All local components in `src/components/ui/` are either (a) adapters
      wrapping the npm version, or (b) explicitly marked KEEP in the table
      above.
- [ ] `npm run typecheck` is clean.
- [ ] `npm test` passes (90+ tests).
- [ ] `npm start` boots the app and the existing features work the same
      (chat interface, model selection, status bar, slash commands).
- [ ] The duplicate key warning is either fixed upstream or worked around
      in the Spinner adapter.

After step 4, step 5 ports the transcript event model into the real TUI and
replaces the old `ChatAccordion`-based chat view.
