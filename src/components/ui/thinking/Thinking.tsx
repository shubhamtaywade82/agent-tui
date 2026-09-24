import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface ThinkingProps {
  /** Thought chain text content */
  children: string;
  /** Whether the model is actively thinking/streaming */
  isStreaming?: boolean;
  /** Duration in seconds. If omitted while streaming, counts elapsed time. */
  durationSeconds?: number;
  /** Estimated token count of the reasoning trace */
  tokenCount?: number;
  /** Whether the thought text is initially visible */
  defaultExpanded?: boolean;
  /** Whether keyboard toggling is active */
  focus?: boolean;
  theme?: InkUITheme;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function formatTokens(count?: number): string {
  if (count === undefined) return '';
  return count >= 1000 ? `(${(count / 1000).toFixed(1)}k tokens)` : `(${count} tokens)`;
}

function useElapsedTime(isStreaming: boolean, overrideSec?: number): number {
  const [elapsed, setElapsed] = useState(overrideSec ?? 0);
  useEffect(() => {
    if (!isStreaming || overrideSec !== undefined) return;
    const start = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - start) / 100) / 10);
    }, 100);
    return () => clearInterval(timer);
  }, [isStreaming, overrideSec]);
  return overrideSec ?? elapsed;
}

function useSpinnerFrame(isStreaming: boolean): string {
  const [frameIdx, setFrameIdx] = useState(0);
  useEffect(() => {
    if (!isStreaming) return;
    const timer = setInterval(() => {
      setFrameIdx((i) => (i + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [isStreaming]);
  return FRAMES[frameIdx] ?? '⠋';
}

export const Thinking: React.FC<ThinkingProps> = ({
  children,
  isStreaming = false,
  durationSeconds,
  tokenCount,
  defaultExpanded = false,
  focus = true,
  theme = darkTheme,
}) => {
  const { isRawModeSupported } = useStdin();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const elapsed = useElapsedTime(isStreaming, durationSeconds);
  const spinner = useSpinnerFrame(isStreaming);

  useInput((input, key) => {
    if (!focus || !isRawModeSupported) return;
    if (key.return || input === ' ') setIsExpanded((prev) => !prev);
  });

  const icon = isStreaming ? spinner : '✔';
  const iconColor = isStreaming ? theme.colors.primary : theme.colors.success;
  const actionHint = isExpanded ? 'collapse' : 'expand';

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={iconColor}>{icon}</Text>
        <Text color={theme.colors.primary} bold>
          {isStreaming ? 'Thinking' : 'Thought'}
        </Text>
        <Text color={theme.colors.muted}>{`for ${elapsed.toFixed(1)}s ${formatTokens(tokenCount)}`}</Text>
        <Text color={theme.colors.muted} dimColor>{`· [Enter to ${actionHint}]`}</Text>
      </Box>
      {isExpanded ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.colors.border}
          paddingX={1}
        >
          <Text color={theme.colors.muted}>{children}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
