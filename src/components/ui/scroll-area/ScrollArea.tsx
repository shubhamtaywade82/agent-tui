/**
 * src/components/ui/scroll-area/ScrollArea.tsx — UX rebuild.
 *
 * Why this file stopped delegating to @nemesis-oss/termina-ui's ScrollBox
 * (reversing step 4 batch 6): the conversation view needs four behaviours the
 * npm component cannot express:
 *
 *   1. Eased scrolling — user-initiated scrolls (wheel, PgUp/PgDn, Home/End)
 *      glide to the target over ~90ms instead of jumping, which removes the
 *      harsh line-by-line feel. Tail-follow during streaming still snaps so
 *      the view never lags behind fresh tokens.
 *   2. Unclamped wheel flicks — rapid wheel ticks accumulate into one larger
 *      eased motion (the old styled path clamped accumulation to ±5 rows per
 *      20ms window and dropped the rest; the npm path moved exactly
 *      `wheelStep` rows per tick with no coalescing).
 *   3. Wheel scrolls while typing — the wheel is hit-tested on the viewport
 *      Box itself, so it works no matter which component owns keyboard focus.
 *   4. Tail-release reporting — the parent needs to know when the user has
 *      scrolled away from the bottom (to render a clickable "jump to latest"
 *      pill) and how many rows are below the viewport.
 *
 * Mechanics mirror the npm ScrollBox: children render inside a
 * `contentOffsetY`-shifted viewport with `overflow: hidden`, so scrolling
 * never re-slices or re-creates children — the renderer just shifts the clip
 * window. Content height comes from `useBoxMetrics` (real Yoga layout), which
 * also means no assumptions about per-element row heights.
 *
 * Kept from the pre-migration API: `scrollOffset` (controlled) +
 * `onScrollOffsetChange` + `onScroll(offset, total)` + `autoScroll` (follow
 * tail) + `scrollbar` + `focus` (keyboard capture) + `theme`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useBoxMetrics } from '@nemesis-oss/termina-core';
import type { DOMElement } from '@nemesis-oss/termina-core';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface ScrollAreaProps {
  /** Visible height in rows */
  height: number;
  /** Controlled scroll target. `Infinity` snaps to the bottom (legacy Chat convention). */
  scrollOffset?: number;
  /** Called when the scroll target changes (user scroll or follow-tail). */
  onScrollOffsetChange?: (offset: number) => void;
  /** Called with (target, contentHeight) whenever either changes. */
  onScroll?: (offset: number, total: number) => void;
  /** Scrollbar visibility */
  scrollbar?: boolean;
  /** Whether this component accepts keyboard input */
  focus?: boolean;
  /** Stay pinned to the bottom while content grows (until the user scrolls up). */
  autoScroll?: boolean;
  /** Rows moved per mouse wheel tick (default 3) */
  wheelStep?: number;
  /** Ease duration for user-initiated scrolls in ms (default 90; 0 = instant) */
  easeMs?: number;
  /** Color theme */
  theme?: InkUITheme;
  /** Width constraint */
  width?: number | string;
  children: React.ReactNode;
}

const ANIM_TICK_MS = 30;
const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);

export const ScrollArea: React.FC<ScrollAreaProps> = ({
  height,
  scrollOffset: scrollOffsetProp,
  onScrollOffsetChange,
  onScroll,
  scrollbar = true,
  focus = true,
  autoScroll = false,
  wheelStep = 3,
  easeMs = 90,
  theme,
  width,
  children,
}) => {
  const contentRef = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(contentRef);
  const contentHeight = metrics.height;

  const isControlled = scrollOffsetProp !== undefined;
  const [ownTarget, setOwnTarget] = useState(0);
  const [displayOffset, setDisplayOffset] = useState(0);

  const maxOffset = Math.max(0, contentHeight - height);
  // The desired scroll position. With follow-tail engaged this is overridden
  // to maxOffset so fresh content keeps the view pinned.
  const targetRef = useRef(0);
  const tailReleasedRef = useRef(!autoScroll);
  // Last value we reported to the parent; the controlled prop echoing it back
  // must not re-trigger animation.
  const echoedRef = useRef<number | null>(null);
  const animTimerRef = useRef<NodeJS.Timeout | null>(null);
  const animStartRef = useRef({ from: 0, to: 0, at: 0 });

  const pinned = autoScroll && !tailReleasedRef.current;
  const requestedTarget = pinned ? maxOffset : (isControlled ? scrollOffsetProp : ownTarget);
  // Legacy convention: Infinity (or any non-finite) means "jump to bottom".
  const target = Number.isFinite(requestedTarget as number)
    ? clamp(requestedTarget as number, 0, maxOffset)
    : maxOffset;

  const report = useCallback((next: number) => {
    if (echoedRef.current !== next) {
      echoedRef.current = next;
      onScrollOffsetChange?.(next);
    }
    onScroll?.(next, contentHeight);
  }, [onScrollOffsetChange, onScroll, contentHeight]);

  const stopAnim = useCallback(() => {
    if (animTimerRef.current) { clearInterval(animTimerRef.current); animTimerRef.current = null; }
  }, []);

  /** Snap display straight to the target (tail-follow, jumps, first layout). */
  const snapTo = useCallback((next: number) => {
    stopAnim();
    targetRef.current = next;
    setDisplayOffset(next);
    report(next);
  }, [stopAnim, report]);

  /** Ease display toward `next` over easeMs. Tail-follow and jumps bypass this. */
  const easeTo = useCallback((next: number) => {
    next = clamp(next, 0, maxOffset);
    targetRef.current = next;
    if (easeMs <= 0 || next === displayOffset) {
      if (next !== displayOffset) setDisplayOffset(next);
      report(next);
      return;
    }
    stopAnim();
    animStartRef.current = { from: displayOffset, to: next, at: Date.now() };
    animTimerRef.current = setInterval(() => {
      const { from, to, at } = animStartRef.current;
      const t = clamp((Date.now() - at) / easeMs, 0, 1);
      // Ease-out quad: fast start, gentle landing.
      const eased = from + (to - from) * (1 - (1 - t) * (1 - t));
      const snapped = t >= 1 ? to : Math.round(eased);
      setDisplayOffset(snapped);
      if (t >= 1) {
        stopAnim();
        report(to);
      }
    }, ANIM_TICK_MS);
  }, [maxOffset, displayOffset, easeMs, stopAnim, report]);

  // React to external target changes (controlled prop / follow-tail growth).
  // User-initiated scrolls go through scrollBy() which updates the parent
  // first; the echoed prop lands on an already-satisfied targetRef and is
  // ignored here, so easing never double-fires.
  useEffect(() => {
    if (pinned) {
      tailReleasedRef.current = false;
      if (targetRef.current !== maxOffset || displayOffset !== maxOffset) snapTo(maxOffset);
      return;
    }
    if (isControlled && target !== targetRef.current) {
      // Scrolling up releases the tail; landing at the bottom re-engages it.
      tailReleasedRef.current = target < maxOffset;
      easeTo(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isControlled, target, maxOffset, pinned]);

  // Report total-height changes (new streamed rows) so the parent can render
  // an accurate "N new lines" affordance without owning layout math.
  useEffect(() => {
    onScroll?.(targetRef.current, contentHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentHeight]);

  useEffect(() => stopAnim, [stopAnim]);

  /** Core user-scroll entry: moves the target and releases/re-engages the tail. */
  const scrollBy = useCallback((delta: number, opts?: { snap?: boolean }) => {
    const next = clamp(targetRef.current + delta, 0, maxOffset);
    if (next === targetRef.current) return;
    tailReleasedRef.current = next < maxOffset;
    if (opts?.snap || next === maxOffset || next === 0) snapTo(next);
    else easeTo(next);
    if (!isControlled) setOwnTarget(next);
  }, [maxOffset, isControlled, snapTo, easeTo]);

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') scrollBy(-1);
      else if (key.downArrow || input === 'j') scrollBy(1);
      else if (key.pageUp || input === 'u') scrollBy(-Math.floor(height / 2));
      else if (key.pageDown || input === 'd') scrollBy(Math.floor(height / 2));
      else if (key.home || input === 'g') scrollBy(-maxOffset);
      else if (key.end || input === 'G') scrollBy(maxOffset);
    },
    { isActive: focus },
  );

  const handleWheel = (ev: { button: string }) => {
    if (ev.button === 'wheelUp') scrollBy(-wheelStep);
    else if (ev.button === 'wheelDown') scrollBy(wheelStep);
    // wheelLeft / wheelRight: no horizontal scrolling in chat.
  };

  const thumbSize = Math.max(1, Math.round((height * height) / Math.max(contentHeight, 1)));
  const thumbPos = maxOffset > 0
    ? Math.round((displayOffset / maxOffset) * (height - thumbSize))
    : 0;
  const showTrack = scrollbar && maxOffset > 0;

  return (
    <Box flexDirection="row" height={height} width={width ?? '100%'}>
      <Box
        flexDirection="column"
        flexGrow={1}
        height={height}
        overflow="hidden"
        contentOffsetY={displayOffset}
        onWheel={handleWheel}
      >
        <Box ref={contentRef} flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
      {showTrack && (
        <Box flexDirection="column" width={1}>
          {Array.from({ length: height }, (_, i) => (
            <Text key={i} dimColor={true}>
              {i >= thumbPos && i < thumbPos + thumbSize ? '█' : '│'}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
};
