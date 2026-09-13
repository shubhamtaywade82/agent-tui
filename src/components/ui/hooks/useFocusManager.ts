import { useState, useCallback } from 'react';
import { useInput } from 'ink';

export interface FocusManagerOptions {
  count: number;
  initialIndex?: number;
  cycle?: boolean;
  nextKey?: string;
  prevKey?: string;
}

export interface FocusManagerResult {
  focusedIndex: number;
  setFocus: (index: number) => void;
  isFocused: (index: number) => boolean;
  focusNext: () => void;
  focusPrev: () => void;
}

export function useFocusManager({
  count,
  initialIndex = 0,
  cycle = true,
  nextKey = 'tab',
  prevKey = 'shift+tab',
}: FocusManagerOptions): FocusManagerResult {
  const [focusedIndex, setFocusedIndex] = useState(initialIndex);

  const focusNext = useCallback(() => {
    setFocusedIndex((prev) => (prev >= count - 1 ? (cycle ? 0 : prev) : prev + 1));
  }, [count, cycle]);

  const focusPrev = useCallback(() => {
    setFocusedIndex((prev) => (prev <= 0 ? (cycle ? count - 1 : prev) : prev - 1));
  }, [count, cycle]);

  const setFocus = useCallback((index: number) => {
    setFocusedIndex(Math.max(0, Math.min(count - 1, index)));
  }, [count]);

  const isFocused = useCallback((index: number) => index === focusedIndex, [focusedIndex]);

  useInput((input, key) => {
    const hasNext = Boolean(nextKey) && nextKey !== 'none';
    const hasPrev = Boolean(prevKey) && prevKey !== 'none';
    if (!hasNext && !hasPrev) return;

    if (hasNext && ((nextKey === 'tab' && key.tab && !key.shift) || (nextKey !== 'tab' && input === nextKey))) {
      focusNext();
    } else if (hasPrev && ((prevKey === 'shift+tab' && key.tab && key.shift) || (prevKey !== 'shift+tab' && input === prevKey))) {
      focusPrev();
    }
  });

  return { focusedIndex, setFocus, isFocused, focusNext, focusPrev };
}
