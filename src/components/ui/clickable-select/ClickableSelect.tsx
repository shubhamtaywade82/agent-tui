/**
 * src/components/ui/clickable-select/ClickableSelect.tsx
 *
 * A mouse + keyboard driven single-selection dropdown. Each option is
 * a clickable `MenuItem` row — mouse click selects directly, keyboard
 * arrow keys move the highlight, Enter selects.
 *
 * Contrast with termina-ui's `Select`:
 *   - termina-ui Select is keyboard-only (no `onClick` on option rows).
 *   - ClickableSelect adds mouse support via `<Box onClick>` on each row.
 *
 * The component is controlled: the parent owns `activeIndex` (the
 * highlighted row) and `value` (the selected value). This makes it
 * composable with keyboard shortcuts — the parent's `useInput` handler
 * can change `activeIndex` on arrow keys, and the ClickableSelect just
 * renders the current state.
 *
 * Props:
 *   - options:       array of { label, value }
 *   - activeIndex:   which row is highlighted (keyboard focus)
 *   - onSelect:      called when a row is clicked OR Enter is pressed
 *   - onActiveChange: called when the user hovers a row with the mouse
 *   - isDisabled:    greys out all rows
 *   - visibleOptionCount: max rows to show at once. The list scrolls a
 *                    sliding window so the active (highlighted) row is
 *                    always visible — navigation past the bottom is no
 *                    longer truncated.
 *   - color, theme:  standard styling
 *
 * Usage:
 *   const [activeIdx, setActiveIdx] = useState(0);
 *   const [value, setValue] = useState('');
 *   <ClickableSelect
 *     options={[{label: 'Red', value: 'red'}, {label: 'Blue', value: 'blue'}]}
 *     activeIndex={activeIdx}
 *     onSelect={(val) => setValue(val)}
 *     onActiveChange={(idx) => setActiveIdx(idx)}
 *   />
 *
 * For keyboard navigation, wire `useInput` in the parent:
 *   useInput((input, key) => {
 *     if (key.upArrow) setActiveIdx(i => Math.max(0, i - 1));
 *     if (key.downArrow) setActiveIdx(i => Math.min(options.length-1, i + 1));
 *     if (key.return) onSelect(options[activeIdx].value);
 *   });
 */
import React from 'react';
import { Box, Text, type MouseEvent } from '@nemesis-oss/termina-core';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface ClickableSelectOption {
  readonly label: string;
  readonly value: string;
  readonly icon?: string;
  readonly shortcut?: string;
  readonly isDisabled?: boolean;
}

export interface ClickableSelectProps {
  readonly options: readonly ClickableSelectOption[];
  /** Index of the highlighted (keyboard-focused) row. -1 = none. */
  readonly activeIndex?: number;
  /** Called when a row is clicked or Enter is pressed on a row. */
  readonly onSelect?: (value: string, index: number) => void;
  /** Called when the user moves the mouse over a row (updates activeIndex). */
  readonly onActiveChange?: (index: number) => void;
  readonly isDisabled?: boolean;
  readonly visibleOptionCount?: number;
  readonly color?: string;
  readonly theme?: InkUITheme;
  readonly width?: number | string;
}

export const ClickableSelect: React.FC<ClickableSelectProps> = ({
  options,
  activeIndex = -1,
  onSelect,
  onActiveChange,
  isDisabled = false,
  visibleOptionCount,
  color = 'white',
  theme = darkTheme,
  width,
}) => {
  // Sliding window: when there are more options than `visibleOptionCount`,
  // scroll the window so the active row stays visible. The window clamps to
  // [0, options.length - visibleCount] and centres the active row when
  // possible, so navigation past the bottom is no longer truncated.
  const total = options.length;
  const maxVisible = visibleOptionCount ? Math.min(visibleOptionCount, total) : total;
  const clampedActive = activeIndex < 0 ? 0 : Math.min(activeIndex, total - 1);
  let start = 0;
  if (visibleOptionCount && total > maxVisible) {
    // Centre the active row, then clamp into the valid range.
    start = clampedActive - Math.floor(maxVisible / 2);
    if (start < 0) start = 0;
    const maxStart = total - maxVisible;
    if (start > maxStart) start = maxStart;
  }
  const visible = options.slice(start, start + maxVisible);
  const hiddenAbove = start > 0 ? start : 0;
  const hiddenBelow = total - (start + maxVisible);

  return (
    <Box flexDirection="column" width={width}>
      {hiddenAbove > 0 && (
        <Text color={theme.colors.muted} dimColor>
          ▲ {hiddenAbove} more above
        </Text>
      )}
      {visible.map((opt, i) => {
        const realIndex = start + i;
        const isActive = realIndex === activeIndex && !isDisabled;
        const rowDisabled = isDisabled || opt.isDisabled;
        const labelColor = rowDisabled
          ? theme.colors.muted
          : isActive
            ? theme.colors.textInverse
            : color;
        const bgColor = isActive && !rowDisabled ? theme.colors.focus : undefined;
        const iconColor = rowDisabled
          ? theme.colors.muted
          : isActive
            ? theme.colors.textInverse
            : theme.colors.info;

        const handleClick = (_event: MouseEvent) => {
          if (rowDisabled) return;
          onActiveChange?.(realIndex);
          onSelect?.(opt.value, realIndex);
        };

        return (
          <Box
            key={`${opt.value}-${realIndex}`}
            width={width}
            onClick={handleClick}
            backgroundColor={bgColor}
            paddingX={1}
            flexDirection="row"
            alignItems="center"
            gap={1}
          >
            {opt.icon ? (
              <Text color={iconColor} bold={!rowDisabled}>
                {opt.icon}
              </Text>
            ) : null}
            <Text color={labelColor} bold={isActive && !rowDisabled}>
              {opt.label}
            </Text>
            {opt.shortcut ? (
              <Box flexGrow={1} alignItems="flex-end">
                <Text color={theme.colors.muted} dimColor>
                  {opt.shortcut}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      {hiddenBelow > 0 && (
        <Text color={theme.colors.muted} dimColor>
          ▼ {hiddenBelow} more below
        </Text>
      )}
    </Box>
  );
};
