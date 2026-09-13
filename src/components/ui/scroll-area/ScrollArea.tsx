import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface ScrollAreaProps {
  /** Visible height in rows */
  height: number;
  /** Controlled scroll offset */
  scrollOffset?: number;
  /** Called when scroll offset changes */
  onScrollOffsetChange?: (offset: number) => void;
  /** Scrollbar visibility */
  scrollbar?: boolean;
  /** Scrollbar thumb character */
  scrollbarChar?: string;
  /** Track character */
  trackChar?: string;
  /** Called when scroll position changes */
  onScroll?: (offset: number, total: number) => void;
  /** Whether this component accepts keyboard input */
  focus?: boolean;
  /** Automatically scroll to bottom when new content arrives */
  autoScroll?: boolean;
  /** Enable mouse wheel scrolling */
  mouseScroll?: boolean;
  /** Lines to scroll per mouse wheel tick (default: 1 for smooth reading) */
  mouseScrollDelta?: number;
  /** Smooth frame interval in ms for wheel event batching (default: 20ms) */
  smoothIntervalMs?: number;
  /** Color theme */
  theme?: InkUITheme;
  /** Width constraint */
  width?: number | string;
  children: React.ReactNode;
}

export const ScrollArea: React.FC<ScrollAreaProps> = ({
  height,
  width,
  scrollOffset: scrollOffsetProp,
  onScrollOffsetChange,
  scrollbar = true,
  scrollbarChar = '█',
  trackChar = '░',
  onScroll,
  focus = true,
  autoScroll = false,
  mouseScroll = true,
  mouseScrollDelta = 1,
  smoothIntervalMs = 20,
  theme = darkTheme,
  children,
}) => {
  const items = Array.isArray(children) ? children : React.Children.toArray(children);
  const totalItems = items.length;
  const maxOffset = Math.max(0, totalItems - height);
  const [internalOffset, setInternalOffset] = useState(autoScroll ? maxOffset : 0);
  const scrollOffset = scrollOffsetProp !== undefined ? Math.max(0, Math.min(maxOffset, scrollOffsetProp)) : internalOffset;
  const prevTotalRef = useRef(totalItems);
  const pendingDeltaRef = useRef(0);
  const throttleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const { stdin, isRawModeSupported } = useStdin();

  useEffect(() => {
    if (autoScroll && totalItems > prevTotalRef.current) {
      const prevMax = Math.max(0, prevTotalRef.current - height);
      // Stay pinned to bottom only if already viewing the end
      if (scrollOffset >= prevMax - 1) {
        if (scrollOffsetProp === undefined) setInternalOffset(maxOffset);
        onScrollOffsetChange?.(maxOffset);
        onScroll?.(maxOffset, totalItems);
      }
    }
    prevTotalRef.current = totalItems;
  }, [autoScroll, totalItems, maxOffset, height, scrollOffset, scrollOffsetProp, onScrollOffsetChange, onScroll]);

  const scroll = useCallback(
    (delta: number) => {
      const next = Math.max(0, Math.min(maxOffset, scrollOffset + delta));
      if (scrollOffsetProp === undefined) setInternalOffset(next);
      onScrollOffsetChange?.(next);
      onScroll?.(next, totalItems);
    },
    [maxOffset, totalItems, scrollOffset, scrollOffsetProp, onScrollOffsetChange, onScroll]
  );

  // Batches high-frequency wheel events into smooth frame ticks
  const queueScroll = useCallback(
    (delta: number) => {
      pendingDeltaRef.current += delta;
      if (throttleTimerRef.current) return;

      // Throttle at ~50fps to match terminal render capability and prevent stutter
      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null;
        const accumulated = pendingDeltaRef.current;
        pendingDeltaRef.current = 0;
        if (accumulated !== 0) {
          // Clamp per-frame jump so trackpad velocity doesn't cause teleporting
          const clamped = Math.max(-5, Math.min(5, accumulated));
          scroll(clamped);
        }
      }, smoothIntervalMs);
    },
    [scroll, smoothIntervalMs]
  );

  useEffect(() => {
    return () => {
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
    };
  }, []);

  // Enable SGR mouse tracking in terminal so mouse wheel events are emitted
  useEffect(() => {
    if (!mouseScroll || !process.stdout.isTTY) return;
    process.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');

    const disableMouse = () => {
      process.stdout.write('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
    };

    process.on('exit', disableMouse);
    return () => {
      process.off('exit', disableMouse);
      disableMouse();
    };
  }, [mouseScroll]);

  // Handle mouse wheel scrolling directly from stdin
  useEffect(() => {
    if (!mouseScroll || !isRawModeSupported || !stdin) return;

    const handleData = (chunk: Buffer | string) => {
      const str = chunk.toString();
      let delta = 0;

      const sgrRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let match: RegExpExecArray | null;
      while ((match = sgrRegex.exec(str)) !== null) {
        const code = parseInt(match[1]!, 10);
        if ((code & 64) !== 0) {
          const isUp = (code & 1) === 0;
          delta += isUp ? -mouseScrollDelta : mouseScrollDelta;
        }
      }

      const legacyRegex = /\x1b\[M([\s\S])([\s\S])([\s\S])/g;
      while ((match = legacyRegex.exec(str)) !== null) {
        const cb = match[1]!.charCodeAt(0);
        if (cb === 96) delta -= mouseScrollDelta;
        else if (cb === 97) delta += mouseScrollDelta;
      }

      if (delta !== 0) {
        queueScroll(delta);
      }
    };

    stdin.on('data', handleData);
    return () => {
      stdin.off('data', handleData);
    };
  }, [mouseScroll, isRawModeSupported, stdin, queueScroll, mouseScrollDelta]);

  useInput(
    (input, key) => {
      // Discard raw mouse sequences to prevent spurious input
      if (/^\[?<\d+;\d+;\d+[Mm]/.test(input) || /^\[?M.../.test(input)) return;

      if (key.upArrow || input === 'k') scroll(-1);
      else if (key.downArrow || input === 'j') scroll(1);
      else if (key.pageUp || input === 'u') scroll(-Math.floor(height / 2));
      else if (key.pageDown || input === 'd') scroll(Math.floor(height / 2));
      else if (key.home || input === 'g') scroll(-totalItems);
      else if (key.end || input === 'G') scroll(totalItems);
    },
    { isActive: focus }
  );

  const visibleItems = items.slice(scrollOffset, scrollOffset + height);

  // Scrollbar calculation
  const thumbSize = Math.max(1, Math.round((height / Math.max(totalItems, 1)) * height));
  const thumbPos =
    maxOffset > 0
      ? Math.round((scrollOffset / maxOffset) * (height - thumbSize))
      : 0;

  return (
    <Box flexDirection="row" height={height} width={width ?? '100%'}>
      <Box flexDirection="column" flexGrow={1}>
        {visibleItems}
      </Box>
      {scrollbar && totalItems > height && (
        <Box flexDirection="column" width={1}>
          {Array.from({ length: height }, (_, i) => {
            const isThumb = i >= thumbPos && i < thumbPos + thumbSize;
            return (
              <Text key={i} color={isThumb ? theme.colors.primary : theme.colors.muted}>
                {isThumb ? scrollbarChar : trackChar}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
};
