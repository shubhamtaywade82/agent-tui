/**
 * src/components/ui/clickable-multi-select/ClickableMultiSelect.tsx
 *
 * A mouse + keyboard driven multi-selection dropdown. Each option has
 * a checkbox (✓/☐) prefix — click toggles selection. Uses `<Box onClick>`
 * on each row for mouse support.
 *
 * Contrast with termina-ui's `MultiSelect`:
 *   - termina-ui MultiSelect is keyboard-only (Space to toggle, no mouse).
 *   - ClickableMultiSelect adds mouse click-to-toggle via `<Box onClick>`.
 *
 * The component is controlled: the parent owns `selectedValues` (a Set
 * of selected value strings) and `activeIndex` (keyboard focus).
 *
 * Props:
 *   - options:         array of { label, value }
 *   - selectedValues: Set of selected value strings
 *   - activeIndex:     which row is highlighted (keyboard focus)
 *   - onToggle:       called when a row is clicked (value, isSelected)
 *   - onActiveChange:  called when the user hovers a row
 *   - isDisabled:     greys out all rows
 *
 * Usage:
 *   const [selected, setSelected] = useState<Set<string>>(new Set());
 *   const [activeIdx, setActiveIdx] = useState(0);
 *   <ClickableMultiSelect
 *     options={[{label: 'Red', value: 'red'}, {label: 'Blue', value: 'blue'}]}
 *     selectedValues={selected}
 *     activeIndex={activeIdx}
 *     onToggle={(val, isSel) => {
 *       const next = new Set(selected);
 *       if (isSel) next.delete(val); else next.add(val);
 *       setSelected(next);
 *     }}
 *     onActiveChange={setActiveIdx}
 *   />
 */
import React from 'react';
import { Box, Text, type MouseEvent } from '@nemesis-oss/termina-core';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface ClickableMultiSelectOption {
  readonly label: string;
  readonly value: string;
  readonly isDisabled?: boolean;
}

export interface ClickableMultiSelectProps {
  readonly options: readonly ClickableMultiSelectOption[];
  readonly selectedValues: ReadonlySet<string>;
  readonly activeIndex?: number;
  readonly onToggle?: (value: string, isSelected: boolean) => void;
  readonly onActiveChange?: (index: number) => void;
  readonly isDisabled?: boolean;
  readonly color?: string;
  readonly theme?: InkUITheme;
  readonly width?: number | string;
}

export const ClickableMultiSelect: React.FC<ClickableMultiSelectProps> = ({
  options,
  selectedValues,
  activeIndex = -1,
  onToggle,
  onActiveChange,
  isDisabled = false,
  color = 'white',
  theme = darkTheme,
  width,
}) => {
  return (
    <Box flexDirection="column" width={width}>
      {options.map((opt, i) => {
        const isSelected = selectedValues.has(opt.value);
        const isActive = i === activeIndex && !isDisabled;
        const rowDisabled = isDisabled || opt.isDisabled;

        const checkbox = isSelected ? '✓' : '☐';
        const checkboxColor = rowDisabled
          ? theme.colors.muted
          : isSelected
            ? theme.colors.success
            : theme.colors.muted;
        const labelColor = rowDisabled
          ? theme.colors.muted
          : isActive
            ? theme.colors.textInverse
            : color;
        const bgColor = isActive && !rowDisabled ? theme.colors.focus : undefined;

        const handleClick = (_event: MouseEvent) => {
          if (rowDisabled) return;
          onActiveChange?.(i);
          onToggle?.(opt.value, isSelected);
        };

        return (
          <Box
            key={`${opt.value}-${i}`}
            onClick={handleClick}
            backgroundColor={bgColor}
            paddingX={1}
            flexDirection="row"
            gap={1}
            alignItems="center"
          >
            <Text color={checkboxColor} bold={!rowDisabled}>
              {checkbox}
            </Text>
            <Text color={labelColor} bold={isActive && !rowDisabled}>
              {opt.label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};
