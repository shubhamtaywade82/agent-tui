/**
 * src/components/ui/hooks/useListNavigation.ts
 *
 * A React hook that adds keyboard navigation to list-based components
 * (ClickableSelect, ClickableMultiSelect, ComboBox, or any list of
 * clickable rows). Handles:
 *   - ↑/↓         move highlight up/down by 1
 *   - PgUp/PgDn   move by half the visible viewport
 *   - Home/End    jump to first/last
 *   - Enter       select the highlighted item
 *   - Escape      cancel (calls onEscape, e.g. to close a dropdown)
 *
 * The hook returns `{ activeIndex, setActiveIndex }` so the parent can
 * pass `activeIndex` to the controlled component + also call
 * `setActiveIndex` directly (e.g. when the user hovers a row with the
 * mouse, the parent calls `setActiveIndex(i)` to sync keyboard focus).
 *
 * Mouse + keyboard work together: mouse hover updates activeIndex (so
 * keyboard nav continues from where the mouse is), and keyboard nav
 * updates activeIndex (so the highlight bar follows the keyboard).
 *
 * Props:
 *   - length:         number of items in the list
 *   - onSelect:       called with the index when Enter is pressed (default 0 if empty)
 *   - onEscape:       called when Escape is pressed (optional)
 *   - isActive:       whether keyboard input is captured (default true — set false
 *                      when the component is blurred or hidden)
 *   - initialIndex:   starting index (default 0)
 *   - viewportSize:   rows visible at once — PgUp/PgDn moves by half this (default 10)
 *
 * Usage:
 *   const [activeIdx, setActiveIdx] = useState(0);
 *   const nav = useListNavigation({
 *     length: options.length,
 *     onSelect: (i) => setSelectedValue(options[i].value),
 *     activeIndex: activeIdx,
 *     setActiveIndex: setActiveIdx,
 *   });
 *   <ClickableSelect
 *     options={options}
 *     activeIndex={nav.activeIndex}
 *     onActiveChange={nav.setActiveIndex}
 *     onSelect={(value, i) => setSelectedValue(value)}
 *   />
 *
 *   // The hook calls useInput internally, so no extra wiring needed.
 */

import { useState, useCallback, useRef } from 'react';
import { useInput } from '@nemesis-oss/termina-core';

export interface UseListNavigationOptions {
  /** Number of items in the list. */
  readonly length: number;
  /** Called with the index when Enter is pressed. */
  readonly onSelect?: (index: number) => void;
  /** Called when Escape is pressed. */
  readonly onEscape?: () => void;
  /** Whether keyboard input is captured. @default true */
  readonly isActive?: boolean;
  /** Starting index. @default 0 */
  readonly initialIndex?: number;
  /** Rows visible at once — PgUp/PgDn moves by half this. @default 10 */
  readonly viewportSize?: number;
}

export interface UseListNavigationResult {
  /** Current highlighted index (-1 if none). */
  readonly activeIndex: number;
  /** Update the active index (clamped to [0, length-1]). */
  readonly setActiveIndex: (index: number) => void;
  /** Move up by 1. */
  readonly moveUp: () => void;
  /** Move down by 1. */
  readonly moveDown: () => void;
  /** Move by a delta (clamped). */
  readonly moveBy: (delta: number) => void;
  /** Jump to first. */
  readonly moveToFirst: () => void;
  /** Jump to last. */
  readonly moveToLast: () => void;
}

export function useListNavigation(opts: UseListNavigationOptions): UseListNavigationResult {
  const {
    length,
    onSelect,
    onEscape,
    isActive = true,
    initialIndex = 0,
    viewportSize = 10,
  } = opts;

  const [activeIndex, setActiveIndexState] = useState(() => {
    if (length === 0) return -1;
    return Math.max(0, Math.min(initialIndex, length - 1));
  });

  // Ref so the keyboard handler always sees the latest index without
  // re-registering the useInput callback on every render.
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  const clamp = useCallback(
    (index: number) => {
      if (length === 0) return -1;
      return Math.max(0, Math.min(index, length - 1));
    },
    [length],
  );

  const setActiveIndex = useCallback(
    (index: number) => {
      const clamped = clamp(index);
      if (clamped !== activeIndexRef.current) {
        activeIndexRef.current = clamped;
        setActiveIndexState(clamped);
      }
    },
    [clamp],
  );

  const moveBy = useCallback(
    (delta: number) => {
      setActiveIndex(activeIndexRef.current + delta);
    },
    [setActiveIndex],
  );

  const moveUp = useCallback(() => moveBy(-1), [moveBy]);
  const moveDown = useCallback(() => moveBy(1), [moveBy]);
  const moveToFirst = useCallback(() => setActiveIndex(0), [setActiveIndex]);
  const moveToLast = useCallback(() => setActiveIndex(length - 1), [setActiveIndex, length]);

  useInput(
    (input, key) => {
      // Discard raw mouse sequences (some terminals report them via stdin)
      if (/^\[?<\d+;\d+;\d+[Mm]/.test(input)) return;

      if (key.upArrow) {
        moveUp();
      } else if (key.downArrow) {
        moveDown();
      } else if (key.pageUp) {
        moveBy(-Math.max(1, Math.floor(viewportSize / 2)));
      } else if (key.pageDown) {
        moveBy(Math.max(1, Math.floor(viewportSize / 2)));
      } else if (key.home) {
        moveToFirst();
      } else if (key.end) {
        moveToLast();
      } else if (key.return) {
        const idx = activeIndexRef.current;
        if (idx >= 0 && idx < length) {
          onSelect?.(idx);
        }
      } else if (key.escape) {
        onEscape?.();
      }
    },
    { isActive },
  );

  return {
    activeIndex,
    setActiveIndex,
    moveUp,
    moveDown,
    moveBy,
    moveToFirst,
    moveToLast,
  };
}
