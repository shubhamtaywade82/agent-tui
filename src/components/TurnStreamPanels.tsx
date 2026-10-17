import React from 'react';
import { Box, Text } from '@nemesis-oss/termina-core';

export type TurnPhase = 'idle' | 'reason' | 'act' | 'observe' | 'respond' | 'done';
export const PHASES: readonly TurnPhase[] = ['idle', 'reason', 'act', 'observe', 'respond', 'done'];

export const PHASE_COLORS: Record<TurnPhase, string> = {
  idle: 'gray',
  reason: 'yellow',
  act: 'blue',
  observe: 'magenta',
  respond: 'green',
  done: 'green',
};

export const KIND_COLORS = {
  thinking: 'yellow',
  tool: 'blue',
  text: 'green',
} as const;

export const LoopStrip: React.FC<{ phase: TurnPhase }> = ({ phase }) => (
  <Box>
    {PHASES.map((p, idx) => {
      const isActive = p === phase;
      return (
        <Box key={p}>
          <Text
            color={isActive ? 'black' : 'gray'}
            backgroundColor={isActive ? PHASE_COLORS[p] : undefined}
            bold={isActive}
          >
            {` ${p.toUpperCase()} `}
          </Text>
          {idx < PHASES.length - 1 ? <Text dimColor>{p === 'observe' ? '↺' : '→'}</Text> : null}
        </Box>
      );
    })}
  </Box>
);

export const DiffLine: React.FC<{ line: string }> = ({ line }) => {
  const isAdd = line.startsWith('+');
  const isDel = line.startsWith('-');
  const isHunk = line.startsWith('@@');
  const bg = isAdd ? '#003200' : isDel ? '#3c0000' : undefined;
  const color = isAdd ? 'green' : isDel ? 'red' : isHunk ? 'cyan' : 'gray';
  return (
    <Box backgroundColor={bg}>
      <Text color={color}>{line}</Text>
    </Box>
  );
};

export interface ContextBreakdown {
  system: number;
  history: number;
  thinking: number;
  tools: number;
  text: number;
}

const CONTEXT_COLORS: Record<keyof ContextBreakdown, string> = {
  system: '#5f5f87',
  history: '#5f875f',
  thinking: '#afaf00',
  tools: '#005faf',
  text: '#00af00',
};

export const ContextPanel: React.FC<{
  context: ContextBreakdown;
  windowSize?: number;
  width?: number;
}> = ({ context, windowSize = 128_000, width = 24 }) => {
  const total = Object.values(context).reduce((sum, v) => sum + v, 0);
  const segments = (Object.keys(CONTEXT_COLORS) as Array<keyof ContextBreakdown>).map((k) => {
    const cells = Math.min(width, Math.round((context[k] / windowSize) * width * 8));
    return { key: k, cells, color: CONTEXT_COLORS[k] };
  });
  const used = Math.min(width, segments.reduce((sum, s) => sum + s.cells, 0));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor wrap="truncate-end">
        context · {((total / windowSize) * 100).toFixed(1)}% · 8×
      </Text>
      <Text>
        {segments.map((s) => (
          <Text key={s.key} color={s.color}>
            {'█'.repeat(s.cells)}
          </Text>
        ))}
        <Text color="#222222">{'░'.repeat(Math.max(0, width - used))}</Text>
      </Text>
    </Box>
  );
};

export interface WaterfallItem {
  id: number;
  title: string;
  kind: 'thinking' | 'tool' | 'text';
  startMs: number;
  endMs: number;
}

export const Waterfall: React.FC<{ items: readonly WaterfallItem[]; totalMs: number; trackWidth?: number }> = ({
  items,
  totalMs,
  trackWidth = 12,
}) => {
  const total = Math.max(1, totalMs);
  const visible = items.slice(-5);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>waterfall · {totalMs < 1000 ? `${Math.round(totalMs)}ms` : `${(totalMs / 1000).toFixed(1)}s`}</Text>
      {visible.map((it) => {
        const left = Math.min(trackWidth - 1, Math.round((it.startMs / total) * trackWidth));
        const width = Math.max(1, Math.round(((it.endMs - it.startMs) / total) * trackWidth));
        const barLen = Math.min(width, trackWidth - left);
        return (
          <Text key={it.id} wrap="truncate-end">
            <Text dimColor>{it.title.slice(0, 8).padEnd(8)} </Text>
            <Text>{' '.repeat(left)}</Text>
            <Text color={KIND_COLORS[it.kind]}>{'█'.repeat(barLen)}</Text>
          </Text>
        );
      })}
    </Box>
  );
};

export interface EconomicsMetrics {
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  iterations: number;
  toolCalls: number;
  wireCount: number;
}

export const Economics: React.FC<{ metrics: EconomicsMetrics }> = ({ metrics }) => {
  const elapsed = Math.max(0.001, metrics.elapsedMs / 1000);
  const velocity = Math.round(metrics.outputTokens / elapsed);
  const cost = metrics.inputTokens * (3 / 1e6) + metrics.outputTokens * (15 / 1e6);
  const rows: Array<[string, string, string]> = [
    ['input', metrics.inputTokens.toLocaleString(), 'blue'],
    ['output', metrics.outputTokens.toLocaleString(), 'magenta'],
    ['velocity', `${velocity} tok/s`, 'cyan'],
    ['cost', `$${cost.toFixed(4)}`, 'green'],
    ['iterations', String(metrics.iterations), 'white'],
    ['tool calls', String(metrics.toolCalls), 'blue'],
    ['events', String(metrics.wireCount), 'white'],
  ];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>token economics</Text>
      {rows.map(([label, value, color]) => (
        <Text key={label}>
          <Text dimColor>{label.padEnd(10)}</Text>
          <Text color={color} bold>{value}</Text>
        </Text>
      ))}
    </Box>
  );
};

export interface TimelineSegment {
  kind: 'thinking' | 'tool' | 'text';
  startMs: number;
  endMs: number;
}

export const Timeline: React.FC<{
  segments: readonly TimelineSegment[];
  totalMs: number;
  width: number;
}> = ({ segments, totalMs, width }) => {
  const total = Math.max(1, totalMs);
  const cells = Array.from({ length: width }, () => '─');
  for (const s of segments) {
    const from = Math.floor((s.startMs / total) * width);
    const to = Math.max(from + 1, Math.ceil((s.endMs / total) * width));
    for (let i = from; i < Math.min(to, width); i++) {
      cells[i] = '█';
    }
  }
  return <Text color="gray">{cells.join('')}</Text>;
};

export function toWireLabel(ev: any): string {
  switch (ev.kind) {
    case 'user': return `[srv] user "${ev.text?.slice(0, 18)}"`;
    case 'thinking': return ev.streaming ? '[dlt] thinking...' : `[srv] thought (${((ev.durationMs ?? 0) / 1000).toFixed(1)}s)`;
    case 'assistant': return ev.streaming ? `[dlt] token "${ev.text?.slice(-16)}"` : '[srv] message_stop';
    case 'tool': return `[tool] ${ev.name} ${ev.status}`;
    case 'file_op': return `[tool] ${ev.op} ${ev.path?.slice(-16)}`;
    case 'plan': return `[sys] plan [${ev.taskId}] ${ev.status}`;
    case 'mcp': return `[sys] mcp ${ev.server} ${ev.status}`;
    case 'usage': return `[srv] usage ${ev.scope} ${ev.tokens}`;
    case 'error': return `[sys] error ${ev.category}`;
    default: return `[sys] ${ev.category || ev.kind}`;
  }
}

export function deriveLoopPhase(events: readonly any[], phase?: TurnPhase): TurnPhase {
  if (phase) return phase;
  if (events.length === 0) return 'idle';
  const last = events[events.length - 1]!;
  if (last.kind === 'thinking' && last.streaming) return 'reason';
  if (last.kind === 'tool' && last.status === 'running') return 'act';
  if (last.kind === 'tool' && (last.status === 'success' || last.status === 'error')) return 'observe';
  if (last.kind === 'assistant' && last.streaming) return 'respond';
  if (last.kind === 'usage' || (last.kind === 'assistant' && !last.streaming)) return 'done';
  return 'idle';
}

export function calcEconomics(events: readonly any[]): EconomicsMetrics {
  let outputTokens = 0; let toolCalls = 0;
  const start = events[0]?.timestamp ?? Date.now();
  const end = events[events.length - 1]?.timestamp ?? start;
  for (const e of events) {
    if (e.kind === 'thinking' || e.kind === 'assistant') outputTokens += Math.round((e.text?.length ?? 0) / 4);
    else if (e.kind === 'tool') toolCalls++;
  }
  return { inputTokens: 4800, outputTokens: Math.max(outputTokens, 1), elapsedMs: Math.max(1, end - start), iterations: Math.max(1, toolCalls > 0 ? 2 : 1), toolCalls, wireCount: events.length };
}

export function calcContext(events: readonly any[]): ContextBreakdown {
  let thinking = 0; let text = 0; let tools = 0; let history = 0;
  for (const e of events) {
    if (e.kind === 'thinking') thinking += Math.round((e.text?.length ?? 0) / 4);
    else if (e.kind === 'assistant') text += Math.round((e.text?.length ?? 0) / 4);
    else if (e.kind === 'tool') tools += Math.round(((e.result?.length ?? 50)) / 4);
    else if (e.kind === 'user') history += Math.round((e.text?.length ?? 0) / 4);
  }
  return { system: 2100, history, thinking, tools, text };
}
