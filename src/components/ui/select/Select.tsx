import React, { useState } from 'react';
import { Box, Text, useInput, useApp, useStdin } from 'ink';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface SelectItem<T = string> {
  label: string;
  value: T;
  disabled?: boolean;
}

export interface SelectProps<T = string> {
  /** List of options */
  items: SelectItem<T>[];
  /** Called when the user presses Enter on an enabled item */
  onSelect: (item: SelectItem<T>) => void;
  /** Whether this select captures keyboard input */
  focus?: boolean;
  /** Theme override — defaults to darkTheme */
  theme?: InkUITheme;
  /** Maximum visible items before scrolling */
  maxVisible?: number;
}

// ─── shared list display ─────────────────────────────────────────────────────

interface ListDisplayProps<T> {
  items: SelectItem<T>[];
  activeIndex: number;
  isFocused: boolean;
  theme: InkUITheme;
  maxVisible?: number;
}

function ListDisplay<T>({
  items,
  activeIndex,
  isFocused,
  theme,
  maxVisible = 6,
}: ListDisplayProps<T>) {
  const needsScroll = items.length > maxVisible;
  let start = 0;
  if (needsScroll) {
    const half = Math.floor(maxVisible / 2);
    start = Math.max(0, Math.min(activeIndex - half, items.length - maxVisible));
  }
  const slice = needsScroll ? items.slice(start, start + maxVisible) : items;

  return (
    <Box flexDirection="column">
      {start > 0 ? (
        <Text color={theme.colors.muted} dimColor>  ▲ {start} more above</Text>
      ) : null}
      {slice.map((item, i) => {
        const itemIndex  = start + i;
        const isActive   = itemIndex === activeIndex;
        const isDisabled = item.disabled === true;

        let labelColor: string;
        if (isDisabled) {
          labelColor = theme.colors.muted;
        } else if (isActive && isFocused) {
          labelColor = theme.colors.focus;
        } else {
          labelColor = theme.colors.text;
        }

        const indicator = isActive && isFocused ? '❯ ' : '  ';

        return (
          <Box key={String(item.value)}>
            <Text color={isActive && isFocused ? theme.colors.focus : theme.colors.muted}>
              {indicator}
            </Text>
            <Text color={labelColor} dimColor={isDisabled}>
              {item.label}
            </Text>
            {isDisabled ? (
              <Text color={theme.colors.muted}>{' (disabled)'}</Text>
            ) : null}
          </Box>
        );
      })}
      {needsScroll && start + maxVisible < items.length ? (
        <Text color={theme.colors.muted} dimColor>  ▼ {items.length - (start + maxVisible)} more below</Text>
      ) : null}
    </Box>
  );
}

// ─── focused inner (only mounts when raw mode is available) ──────────────────

interface FocusedSelectProps<T> {
  items: SelectItem<T>[];
  onSelect: (item: SelectItem<T>) => void;
  theme: InkUITheme;
  maxVisible?: number;
}

function FocusedSelect<T>({ items, onSelect, theme, maxVisible }: FocusedSelectProps<T>) {
  const { exit } = useApp();

  // Start on the first non-disabled item
  const firstEnabled = items.findIndex((it) => !it.disabled);
  const [index, setIndex] = useState(Math.max(0, firstEnabled));

  const move = (dir: 1 | -1) => {
    setIndex((prev) => {
      let next = prev + dir;
      // Wrap around, skip disabled
      for (let i = 0; i < items.length; i++) {
        const wrapped = ((next % items.length) + items.length) % items.length;
        if (!items[wrapped]!.disabled) return wrapped;
        next += dir;
      }
      return prev; // all disabled — stay put
    });
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (key.upArrow)   { move(-1); return; }
    if (key.downArrow) { move(1);  return; }
    if (key.return) {
      const item = items[index];
      if (item && !item.disabled) onSelect(item);
      return;
    }
  });

  return <ListDisplay items={items} activeIndex={index} isFocused theme={theme} maxVisible={maxVisible} />;
}

// ─── public component ─────────────────────────────────────────────────────────

export function Select<T = string>({
  items,
  onSelect,
  focus = true,
  theme = darkTheme,
  maxVisible,
}: SelectProps<T>) {
  const { isRawModeSupported } = useStdin();
  const canFocus = focus && isRawModeSupported;

  if (canFocus) {
    return <FocusedSelect items={items} onSelect={onSelect} theme={theme} maxVisible={maxVisible} />;
  }

  const firstEnabled = Math.max(0, items.findIndex((it) => !it.disabled));
  return (
    <ListDisplay
      items={items}
      activeIndex={firstEnabled}
      isFocused={false}
      theme={theme}
      maxVisible={maxVisible}
    />
  );
}
