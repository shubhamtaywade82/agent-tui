import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface ScrollAreaProps {
  /** Visible height in rows */
  height: number;
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
  /** Color theme */
  theme?: InkUITheme;
  children: React.ReactNode;
}

export const ScrollArea: React.FC<ScrollAreaProps> = ({
  height,
  scrollbar = true,
  scrollbarChar = '█',
  trackChar = '░',
  onScroll,
  focus = true,
  autoScroll = false,
  theme = darkTheme,
  children,
}) => {
  const items = React.Children.toArray(children);
  const totalItems = items.length;
  const maxOffset = Math.max(0, totalItems - height);
  const [scrollOffset, setScrollOffset] = useState(autoScroll ? maxOffset : 0);
  const prevTotalRef = useRef(totalItems);

  useEffect(() => {
    if (autoScroll && totalItems > prevTotalRef.current) {
      setScrollOffset(maxOffset);
    }
    prevTotalRef.current = totalItems;
  }, [autoScroll, totalItems, maxOffset]);

  const scroll = useCallback(
    (delta: number) => {
      setScrollOffset((prev) => {
        const next = Math.max(0, Math.min(maxOffset, prev + delta));
        onScroll?.(next, totalItems);
        return next;
      });
    },
    [maxOffset, totalItems, onScroll]
  );

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') scroll(-1);
      else if (key.downArrow || input === 'j') scroll(1);
      else if (key.pageUp || input === 'u') scroll(-Math.floor(height / 2));
      else if (key.pageDown || input === 'd') scroll(Math.floor(height / 2));
      else if (input === 'g') scroll(-totalItems);
      else if (input === 'G') scroll(totalItems);
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
    <Box flexDirection="row">
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
