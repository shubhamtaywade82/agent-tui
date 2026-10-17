/**
 * src/components/ui/scroll-area/ScrollArea.tsx — Termina migration adapter.
 *
 * Was: a full local copy that sliced children itself (`items.slice(...)`)
 * with rich scrollbar customization (`scrollbarChar`, `trackChar`),
 * mouse scroll throttling, and an `onScroll(offset, total)` callback.
 * Now: a thin adapter around `@nemesis-oss/termina-ui`'s `ScrollBox`.
 *
 * API deltas:
 *   - Local:  `scrollOffset` (controlled) + `onScrollOffsetChange`.
 *   - NPM:    `offset` (controlled) + `onScroll` (called with just offset).
 *   - Local:  `autoScroll` (stays pinned to bottom).
 *   - NPM:    `followTail` (semantically identical).
 *   - Local:  `focus` (whether keyboard input is captured).
 *   - NPM:    `isActive` (same).
 *   - Local:  `scrollbar` (show/hide).
 *   - NPM:    `showScrollbar`.
 *   - Local:  `scrollbarChar`/`trackChar` (custom scrollbar glyphs).
 *   - NPM:    uses fixed `█` thumb + `│` track via dimColor.
 *   - Local:  `mouseScroll`/`mouseScrollDelta`/`smoothIntervalMs` (throttle).
 *   - NPM:    `wheelStep` (rows per wheel tick) + built-in throttling.
 *   - Local:  `onScroll(offset, total)` (richer callback).
 *   - NPM:    `onScroll(offset)` only.
 *   - Local:  `width?: number | string` (parent constraint).
 *   - NPM:    no width prop — fills parent's column.
 *
 * Adapter behavior:
 *   - Fast path: when no `scrollbarChar` AND no `trackChar` AND no
 *     `mouseScroll` override AND no `mouseScrollDelta` override AND no
 *     `smoothIntervalMs` override AND the `onScroll` prop is the
 *     `(offset, total)` variant (callers using `onScrollOffsetChange`
 *     instead work fine), delegate to `ScrollBox` with mapped props.
 *   - Styled path: when any of those custom props are set, re-implement
 *     locally to preserve the rich behavior.
 *
 * The `width` prop is honored by wrapping the npm `ScrollBox` in a
 * `<Box width={width}>` when set, so consumers passing `width="100%"`
 * (the common case in this codebase) keep working.
 *
 * See scratch/MIGRATION.md for the full migration playbook.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from '@nemesis-oss/termina-core';
import { ScrollBox as TerminaScrollBox } from '@nemesis-oss/termina-ui';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';
import { useMouseScroll } from '../hooks/useMouse.js';

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
  /** Called when scroll position changes — receives (offset, total). The npm ScrollBox only supports (offset). */
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
  scrollbarChar,
  trackChar,
  onScroll,
  focus = true,
  autoScroll = false,
  mouseScroll,
  mouseScrollDelta,
  smoothIntervalMs,
  theme,
  children,
}) => {
  // Fast path: delegate to the npm ScrollBox for the common case.
  // The custom scrollbar chars, mouse scroll tuning, and the (offset, total)
  // onScroll variant require the styled path.
  const canDelegate =
    scrollbarChar === undefined &&
    trackChar === undefined &&
    mouseScroll === undefined &&
    mouseScrollDelta === undefined &&
    smoothIntervalMs === undefined;

  if (canDelegate) {
    // Bridge the (offset, total) onScroll callback to the (offset) only
    // callback that ScrollBox supports — pass through `total` as 0 since
    // ScrollBox doesn't expose content height in its onScroll.
    const handleScroll = onScrollOffsetChange ?? (onScroll ? (offset: number) => onScroll(offset, 0) : undefined);
    const handleOuterWheel = (event: any) => {
      if (focus) return;
      const step = 3;
      if (event?.button === 'wheelUp') {
        handleScroll?.(Math.max(0, (scrollOffsetProp ?? 0) - step));
      } else if (event?.button === 'wheelDown') {
        handleScroll?.((scrollOffsetProp ?? 0) + step);
      }
    };
    const inner = (
      <TerminaScrollBox
        height={height}
        offset={scrollOffsetProp}
        onScroll={handleScroll}
        isActive={focus}
        followTail={autoScroll}
        showScrollbar={scrollbar}
      >
        {children}
      </TerminaScrollBox>
    );
    return (
      <Box width={width ?? '100%'} height={height} onWheel={handleOuterWheel}>
        {inner}
      </Box>
    );
  }

  // Styled path: re-implement locally for the rich case. Same code as
  // pre-migration; remains here as a compatibility shim.
  const resolvedTheme = theme ?? darkTheme;
  const items = Array.isArray(children) ? children : React.Children.toArray(children);
  const totalItems = items.length;
  const maxOffset = Math.max(0, totalItems - height);
  const [internalOffset, setInternalOffset] = useState(autoScroll ? maxOffset : 0);
  const scrollOffset = scrollOffsetProp !== undefined ? Math.max(0, Math.min(maxOffset, scrollOffsetProp)) : internalOffset;
  const prevTotalRef = useRef(totalItems);
  const pendingDeltaRef = useRef(0);
  const throttleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const resolvedSmoothMs = smoothIntervalMs ?? 20;
  const resolvedMouseDelta = mouseScrollDelta ?? 1;
  const resolvedMouseScroll = mouseScroll ?? true;
  const resolvedScrollbarChar = scrollbarChar ?? '█';
  const resolvedTrackChar = trackChar ?? '░';

  useEffect(() => {
    if (autoScroll && totalItems > prevTotalRef.current) {
      const prevMax = Math.max(0, prevTotalRef.current - height);
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

  const queueScroll = useCallback(
    (delta: number) => {
      pendingDeltaRef.current += delta;
      if (throttleTimerRef.current) return;

      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null;
        const accumulated = pendingDeltaRef.current;
        pendingDeltaRef.current = 0;
        if (accumulated !== 0) {
          const clamped = Math.max(-5, Math.min(5, accumulated));
          scroll(clamped);
        }
      }, resolvedSmoothMs);
    },
    [scroll, resolvedSmoothMs]
  );

  useEffect(() => {
    return () => {
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
    };
  }, []);

  useMouseScroll((delta) => queueScroll(delta * resolvedMouseDelta), resolvedMouseScroll);

  useInput(
    (input, key) => {
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

  const thumbSize = Math.max(1, Math.round((height / Math.max(totalItems, 1)) * height));
  const thumbPos =
    maxOffset > 0
      ? Math.round((scrollOffset / maxOffset) * (height - thumbSize))
      : 0;

  return (
    <Box
      flexDirection="row"
      height={height}
      width={width ?? '100%'}
      onWheel={(e: any) => {
        if (e?.button === 'wheelUp') scroll(-resolvedMouseDelta * 3);
        else if (e?.button === 'wheelDown') scroll(resolvedMouseDelta * 3);
      }}
    >
      <Box flexDirection="column" flexGrow={1}>
        {visibleItems}
      </Box>
      {scrollbar && totalItems > height && (
        <Box flexDirection="column" width={1}>
          {Array.from({ length: height }, (_, i) => {
            const isThumb = i >= thumbPos && i < thumbPos + thumbSize;
            return (
              <Text key={i} color={isThumb ? resolvedTheme.colors.primary : resolvedTheme.colors.muted}>
                {isThumb ? resolvedScrollbarChar : resolvedTrackChar}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
};
