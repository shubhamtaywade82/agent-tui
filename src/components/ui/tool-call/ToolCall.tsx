import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error';

export interface ToolCallProps {
  name: string;
  args?: Record<string, unknown> | string;
  output?: string | Record<string, unknown>;
  error?: string;
  status?: ToolCallStatus;
  durationMs?: number;
  defaultExpanded?: boolean;
  interactive?: boolean;
  compact?: boolean;
  theme?: InkUITheme;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function formatDuration(ms?: number): string {
  if (ms === undefined || ms < 0) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatData(val: unknown): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

function formatArgsPreview(args: unknown): string {
  if (!args) return '';
  if (typeof args === 'string') {
    return args.length > 36 ? `${args.slice(0, 36)}...` : args;
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return '';
  const preview = entries
    .slice(0, 2)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  return preview.length > 40 ? `${preview.slice(0, 40)}...` : preview;
}

function useSpinnerFrame(status: ToolCallStatus) {
  const [frameIdx, setFrameIdx] = useState(0);
  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => {
      setFrameIdx((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [status]);
  return SPINNER_FRAMES[frameIdx] ?? '⠋';
}

function StatusIcon({ status, frame, theme }: { status: ToolCallStatus; frame: string; theme: InkUITheme }) {
  if (status === 'running') return <Text color={theme.colors.primary}>{frame} </Text>;
  if (status === 'success') return <Text color={theme.colors.success}>✔ </Text>;
  if (status === 'error')   return <Text color={theme.colors.error}>✖ </Text>;
  return <Text color={theme.colors.muted}>○ </Text>;
}

function DetailSection({ title, content, color }: { title: string; content: string; color?: string }) {
  return (
    <Box flexDirection="column">
      <Text bold color={color}>{title}:</Text>
      <Box paddingLeft={1}><Text color={color}>{content}</Text></Box>
    </Box>
  );
}

export function ToolCall({
  name,
  args,
  output,
  error,
  status = 'pending',
  durationMs,
  defaultExpanded = false,
  interactive = true,
  compact = false,
  theme = darkTheme,
}: ToolCallProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const frame = useSpinnerFrame(status);

  useInput((input, key) => {
    if (!interactive) return;
    if (key.return || input === ' ') setExpanded((e) => !e);
  });

  const durationText = formatDuration(durationMs);
  const preview = formatArgsPreview(args);
  const argsStr = formatData(args);
  const outputStr = formatData(output);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <StatusIcon status={status} frame={frame} theme={theme} />
        <Text bold color={theme.colors.text}>{name}</Text>
        {preview && !expanded ? <Text color={theme.colors.muted}>({preview})</Text> : null}
        {durationText ? <Text color={theme.colors.muted}>{durationText}</Text> : null}
        {interactive && !compact ? (
          <Text color={theme.colors.muted}>[{expanded ? 'collapse' : 'inspect'}]</Text>
        ) : null}
      </Box>
      {expanded && !compact ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.border} paddingX={1}>
          {argsStr ? <DetailSection title="Input" content={argsStr} color={theme.colors.muted} /> : null}
          {outputStr ? <DetailSection title="Output" content={outputStr} /> : null}
          {error ? <DetailSection title="Error" content={error} color={theme.colors.error} /> : null}
        </Box>
      ) : null}
    </Box>
  );
}
