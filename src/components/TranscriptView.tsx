/**
 * src/components/TranscriptView.tsx
 *
 * Renders a `TranscriptEvent[]` (from the step-2 contract) inside a
 * `@nemesis-oss/termina-ui` `ScrollBox`. This is the renderer half of
 * step 5 — the UI surface that consumes the event model + reducer + the
 * Ollama bridge from steps 2 and 3.
 *
 * Design rules:
 *   - Pure component: takes `events` and `height`, returns JSX. No state
 *     of its own. The `useTranscript` hook owns the state; this just
 *     projects it.
 *   - Exhaustive over `TranscriptEvent['kind']` — adding a new event
 *     kind in `types.ts` will cause a TypeScript compile error here
 *     until the renderer handles it.
 *   - Streaming events (`thinking`, `assistant`) show a `▌` cursor and
 *     a `Spinner` (for thinking only — the answer text is self-evident).
 *   - `followTail={true}` on `ScrollBox` keeps the view pinned to the
 *     bottom while events stream in (proven in step 1's PoC).
 *
 * Why this is a separate component from `Chat.tsx`'s existing view:
 * the existing view is `ChatMessage[]`-based and tightly coupled to
 * `runAgentLoop` (with tool execution, skill loading, MCP, slash
 * commands, auto-mode continuation, etc.). Replacing it wholesale is
 * a multi-day effort. This component lets the new contract land in
 * parallel — the user can switch to `viewMode='transcript'` with
 * Ctrl+A to see the new path, and back to `'stream'`/`'accordion'`
 * for the old path. Once the transcript path reaches feature parity,
 * the old path can be deleted (see scratch/STEP5.md).
 */
import React, { useMemo, useState } from 'react';
import { Box, Text } from '@nemesis-oss/termina-core';
import { ScrollBox, Spinner, LogStream } from '@nemesis-oss/termina-ui';
import { LinkButton } from './ui/link-button/index.js';
import { Button } from './ui/button/index.js';
import type { TranscriptEvent, TranscriptState } from '../transcript/index.js';
import type { ElicitationChoice } from '../transcript/index.js';
import { canRememberForSession } from '../transcript/elicitation-policy.js';
import {
  LoopStrip,
  ContextPanel,
  Waterfall,
  Economics,
  Timeline,
  toWireLabel,
  deriveLoopPhase,
  calcEconomics,
  calcContext,
  type TurnPhase,
} from './TurnStreamPanels.js';

export interface TranscriptViewProps {
  /** Ordered events to render. */
  readonly events: readonly TranscriptEvent[];
  /** Viewport height in rows. */
  readonly height: number;
  /** Whether the ScrollBox captures keyboard input (arrows etc.). */
  readonly isActive?: boolean;
  /** Optional width constraint. */
  readonly width?: number | string;
  /** Optional turn phase */
  readonly phase?: TurnPhase;
  /**
   * Called when the user clicks a response button on an unresolved
   * elicitation event. The parent should dispatch `cb.patch(eventId,
   * makeElicitationResolutionPatch(choice))` to resolve the event.
   */
  readonly onElicitationRespond?: (eventId: number, choice: ElicitationChoice) => void;
}

/** Format a millisecond duration as 'X.Ys' or 'Xm Ys'. */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Optional context passed to renderEvent for interactive event kinds. */
export interface RenderEventContext {
  /** Called when the user clicks a response button on an elicitation event. */
  readonly onElicitationRespond?: (eventId: number, choice: ElicitationChoice) => void;
  /** Whether a tool event's details are expanded. */
  readonly isToolExpanded?: (eventId: number) => boolean;
  /** Called when the user clicks a tool's name to expand/collapse its details. */
  readonly onToggleTool?: (eventId: number) => void;
}

/**
 * Render a single event as a row in the transcript. Pure function for
 * most event kinds; tool and elicitation events return stateful
 * sub-components (ToolEventRow, ElicitationEventRow) that manage their
 * own interaction state.
 *
 * The optional `ctx` parameter carries callbacks for interactive kinds.
 * For pure (non-interactive) kinds it's ignored.
 */
export function renderEvent(ev: TranscriptEvent, ctx?: RenderEventContext): React.ReactElement {
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
          <Spinner label="Thinking" type="dots" />
          {ev.text ? <Text dimColor> {ev.text}</Text> : null}
        </Box>
      ) : (
        <Text dimColor italic>
          ⏵ Thought for {formatDuration(ev.durationMs ?? 0)}
        </Text>
      );

    case 'assistant':
      return (
        <Text wrap="wrap">
          {ev.text}
          {ev.streaming ? ' ▌' : ''}
        </Text>
      );

    case 'plan': {
      const statusColor =
        ev.status === 'completed'
          ? 'green'
          : ev.status === 'blocked'
            ? 'red'
            : ev.status === 'in_progress'
              ? 'yellow'
              : 'gray';
      return (
        <Box flexDirection="row">
          <Text color="blue" bold>
            ▶{' '}
          </Text>
          <Text bold color={statusColor}>
            [{ev.taskId}]
          </Text>
          <Text> {ev.title}</Text>
          <Text dimColor> ({ev.status}, {ev.attempts}/{ev.maxAttempts})</Text>
          {ev.failureReason ? <Text color="red"> — {ev.failureReason}</Text> : null}
          {ev.note ? <Text color="green"> — {ev.note}</Text> : null}
        </Box>
      );
    }

    case 'tool': {
      // Tool events render inline (pure function, no useState) — the
      // expand/collapse state is controlled by ctx.isToolExpanded +
      // ctx.onToggleTool, which the parent TranscriptView manages.
      const expanded = ctx?.isToolExpanded?.(ev.id) ?? false;
      const hasDetails = Boolean(ev.result || ev.error);
      const statusIcon =
        ev.status === 'success' ? '✓' : ev.status === 'error' ? '✗' : ev.status === 'blocked' ? '⊘' : '⏺';
      const statusColor =
        ev.status === 'success' ? 'green' : ev.status === 'error' ? 'red' : ev.status === 'blocked' ? 'red' : 'magenta';
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text color={statusColor} bold>
              {statusIcon}{' '}
            </Text>
            {hasDetails ? (
              <LinkButton
                label={ev.name}
                color={statusColor}
                underline={false}
                bold
                onClick={() => ctx?.onToggleTool?.(ev.id)}
              />
            ) : (
              <Text bold>{ev.name}</Text>
            )}
            <Text dimColor> ({JSON.stringify(ev.arguments)})</Text>
            {ev.status === 'running' ? <Spinner type="dots" /> : null}
            {hasDetails ? (
              <Text dimColor> {expanded ? '[-]' : '[+]'}</Text>
            ) : null}
            {!expanded && ev.result ? (
              <Text dimColor wrap="wrap">
                {' '}
                → {ev.result.length > 80 ? `${ev.result.slice(0, 77)}…` : ev.result}
              </Text>
            ) : null}
            {!expanded && ev.error ? (
              <Text color="red">
                {' '}
                — {ev.error.length > 80 ? `${ev.error.slice(0, 77)}…` : ev.error}
              </Text>
            ) : null}
          </Box>
          {expanded && hasDetails ? (
            <Box flexDirection="column" paddingLeft={2} marginTop={0}>
              {ev.result ? <Text dimColor wrap="wrap">{ev.result}</Text> : null}
              {ev.error ? <Text color="red"> — {ev.error}</Text> : null}
              {ev.durationMs ? <Text dimColor> ({ev.durationMs}ms)</Text> : null}
            </Box>
          ) : null}
        </Box>
      );
    }

    case 'file_op':
      return (
        <Box flexDirection="row">
          <Text color="yellow" bold>
            ✎{' '}
          </Text>
          <Text bold>{ev.op}</Text>
          <Text> {ev.path}</Text>
          {ev.toPath ? <Text dimColor> → {ev.toPath}</Text> : null}
          {ev.bytes ? <Text dimColor> ({ev.bytes} bytes)</Text> : null}
        </Box>
      );

    case 'mcp': {
      const statusColor =
        ev.status === 'connected' ? 'green' : ev.status === 'error' ? 'red' : 'gray';
      return (
        <Box flexDirection="row">
          <Text color="blue" bold>
            ⚡{' '}
          </Text>
          <Text bold color={statusColor}>
            {ev.server}
          </Text>
          <Text dimColor> ({ev.status})</Text>
          {ev.toolName ? <Text> · {ev.toolName}</Text> : null}
          {ev.error ? <Text color="red"> — {ev.error}</Text> : null}
        </Box>
      );
    }

    case 'error':
      return (
        <Text color="red" bold>
          ✗ {ev.category}: {ev.message}
        </Text>
      );

    case 'elicitation':
      // Elicitation events render clickable Button choices when unresolved.
      // The parent passes `onElicitationRespond` which dispatches
      // `cb.patch(eventId, makeElicitationResolutionPatch(choice))`.
      return (
        <Box flexDirection="column">
          <Text color="yellow" bold>
            ⚠ Confirm {ev.toolName}
          </Text>
          <Text dimColor> {ev.prompt}</Text>
          {ev.choice ? (
            <Text color={ev.choice === 'deny' ? 'red' : 'green'}> → {ev.choice}</Text>
          ) : ctx?.onElicitationRespond ? (
            <Box flexDirection="row" gap={1} marginTop={0}>
              <Button
                label="Allow once"
                variant="success"
                icon="✓"
                onClick={() => ctx.onElicitationRespond!(ev.id, 'allow_once')}
              />
              {canRememberForSession(ev.toolName) && (
                <Button
                  label="Allow session"
                  variant="primary"
                  icon="✓"
                  onClick={() => ctx.onElicitationRespond!(ev.id, 'allow_session')}
                />
              )}
              <Button
                label="Deny"
                variant="danger"
                icon="✖"
                onClick={() => ctx.onElicitationRespond!(ev.id, 'deny')}
              />
            </Box>
          ) : (
            <Text dimColor italic> (awaiting response…)</Text>
          )}
        </Box>
      );

    case 'usage':
      return (
        <Text dimColor>
          ↳ usage {ev.scope}: {ev.tokens} tokens (ctx {ev.contextWindow})
        </Text>
      );

    case 'system':
      return (
        <Box flexDirection="row">
          <Text color="gray" bold>
            ◈{' '}
          </Text>
          <Text dimColor italic>
            [{ev.category}] {ev.message}
          </Text>
        </Box>
      );

    default: {
      // Exhaustiveness check — if a new event kind is added to
      // `types.ts` without a case here, TypeScript flags this line.
      const _exhaustive: never = ev;
      void _exhaustive;
      return <Text dimColor>[unknown event]</Text>;
    }
  }
}

/* ------------------------------------------------------------------ *
 * The tool + elicitation cases are inlined in renderEvent above
 * (not extracted to sub-components) because the walk-based tests in
 * test/TranscriptView.test.ts call renderEvent directly and walk the
 * returned element tree — function components that use hooks (like
 * Text/Box from termina-core) can't be called outside a React render
 * context. The inline approach keeps renderEvent a pure function.
 * ------------------------------------------------------------------ */

/** The full transcript view — TurnStream observatory when width allows, otherwise single column. */
export const TranscriptView: React.FC<TranscriptViewProps> = ({ events, height, isActive = true, width, phase, onElicitationRespond }) => {
  const numCols = typeof width === 'number' ? width : 100;
  const isObservatory = numCols >= 88 && height >= 12;
  const derivedPhase = useMemo(() => deriveLoopPhase(events, phase), [events, phase]);
  const wireLines = useMemo(() => events.map(toWireLabel), [events]);
  const economics = useMemo(() => calcEconomics(events), [events]);
  const context = useMemo(() => calcContext(events), [events]);
  const waterfallItems = useMemo(() => events.filter((e) => (e.kind === 'thinking' || e.kind === 'tool' || e.kind === 'assistant') && (e as any).durationMs).map((e) => ({
    id: e.id, title: e.kind === 'tool' ? (e as any).name : e.kind, kind: (e.kind === 'thinking' ? 'thinking' : e.kind === 'tool' ? 'tool' : 'text') as 'thinking' | 'tool' | 'text', startMs: e.timestamp, endMs: e.timestamp + ((e as any).durationMs ?? 100),
  })), [events]);

  if (events.length === 0) {
    return <Box height={height} width={width} alignItems="center" justifyContent="center"><Text dimColor>Transcript is empty. Type a prompt to start streaming.</Text></Box>;
  }

  const [expandedToolIds, setExpandedToolIds] = useState<Set<number>>(new Set());
  const renderCtx: RenderEventContext = {
    isToolExpanded: (id: number) => expandedToolIds.has(id),
    onToggleTool: (id: number) => setExpandedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    }),
    ...(onElicitationRespond ? { onElicitationRespond } : {}),
  };
  const scrollContent = (
    <ScrollBox height={isObservatory ? height - 4 : height - 1} followTail={true} showScrollbar={true} isActive={isActive}>
      {events.map((ev) => (<Box key={ev.id} flexDirection="column">{renderEvent(ev, renderCtx)}</Box>))}
    </ScrollBox>
  );

  if (!isObservatory) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box flexDirection="row" justifyContent="space-between" paddingX={1}><LoopStrip phase={derivedPhase} /><Text dimColor>events: {events.length}</Text></Box>
        {scrollContent}
      </Box>
    );
  }

  const bodyHeight = Math.max(5, height - 2);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1} height={1}>
        <Box flexDirection="row" gap={1} alignItems="center"><Text bold color="cyan">◉ TURNSTREAM</Text><Text dimColor>observatory</Text><LoopStrip phase={derivedPhase} /></Box>
        <Text dimColor>wire: <Text color="white">{events.length}</Text> · out: <Text color="magenta">{economics.outputTokens}</Text> tok</Text>
      </Box>
      <Box flexDirection="row" height={bodyHeight}>
        <Box flexDirection="column" width={28} height={bodyHeight} borderStyle="single" borderColor="gray">
          <Text dimColor>● wire events</Text><LogStream lines={wireLines} height={bodyHeight - 2} maxLines={200} isActive={false} />
        </Box>
        <Box flexDirection="column" flexGrow={1} height={bodyHeight} borderStyle="single" borderColor="gray">
          <Text dimColor>streaming transcript</Text>{scrollContent}
        </Box>
        <Box flexDirection="column" width={26} height={bodyHeight} borderStyle="single" borderColor="gray">
          <ContextPanel context={context} width={22} /><Waterfall items={waterfallItems} totalMs={economics.elapsedMs} trackWidth={12} /><Economics metrics={economics} />
        </Box>
      </Box>
      <Box flexDirection="column" height={1}><Timeline segments={waterfallItems} totalMs={economics.elapsedMs} width={numCols} /></Box>
    </Box>
  );
};

/** Convenience helper for tests: type-only re-export. */
export type { TranscriptState };
