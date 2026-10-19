/**
 * src/components/ui/combobox/ComboBox.tsx
 *
 * A ComboBox (a.k.a. Autocomplete / Typeahead) — a text input with a
 * dropdown of filtered suggestions. Each suggestion is a clickable
 * `MenuItem` row. Typing filters the list; clicking a suggestion
 * selects it and fills the input.
 *
 * Contrast with termina-ui's `Autocomplete`:
 *   - termina-ui Autocomplete is keyboard-only (arrow keys + Tab).
 *   - ComboBox adds mouse click-to-select via `<Box onClick>` on each row.
 *
 * The component is controlled: the parent owns `value` (the input text)
 * and `activeIndex` (which suggestion is highlighted).
 *
 * Props:
 *   - value:          current input text
 *   - onChange:       called when the user types
 *   - options:        array of { label, value } (all options, not pre-filtered)
 *   - onSelect:       called when a suggestion is clicked or Enter-pressed
 *   - activeIndex:    which suggestion is highlighted (-1 = none)
 *   - onActiveChange: called when user hovers a suggestion
 *   - placeholder:    input placeholder
 *   - isDisabled:     greys out the input
 *   - maxSuggestions:  max number of suggestions to show (default 8)
 *   - color, theme:   standard styling
 *
 * Usage:
 *   const [value, setValue] = useState('');
 *   const [activeIdx, setActiveIdx] = useState(-1);
 *   <ComboBox
 *     value={value}
 *     onChange={setValue}
 *     options={models.map(m => ({ label: m, value: m }))}
 *     activeIndex={activeIdx}
 *     onSelect={(val) => { setValue(val); setSelectedModel(val); }}
 *     onActiveChange={setActiveIdx}
 *     placeholder="Search models..."
 *   />
 */
import React from 'react';
import { Box, Text } from '@nemesis-oss/termina-core';
import { TextInput } from '../text-input/index.js';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface ComboBoxOption {
  readonly label: string;
  readonly value: string;
}

export interface ComboBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly ComboBoxOption[];
  readonly onSelect?: (value: string) => void;
  readonly activeIndex?: number;
  readonly onActiveChange?: (index: number) => void;
  readonly placeholder?: string;
  readonly isDisabled?: boolean;
  readonly maxSuggestions?: number;
  readonly color?: string;
  readonly theme?: InkUITheme;
  readonly width?: number | string;
}

export const ComboBox: React.FC<ComboBoxProps> = ({
  value,
  onChange,
  options,
  onSelect,
  activeIndex = -1,
  onActiveChange,
  placeholder,
  isDisabled = false,
  maxSuggestions = 8,
  color = 'white',
  theme = darkTheme,
  width,
}) => {
  // Filter options by the input value (case-insensitive substring match).
  // Only filter when there's input; show all when empty.
  const filtered = value.trim()
    ? options.filter((opt) =>
        opt.label.toLowerCase().includes(value.toLowerCase()) ||
        opt.value.toLowerCase().includes(value.toLowerCase()))
    : [...options];
  const visible = filtered.slice(0, maxSuggestions);

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor={isDisabled ? theme.colors.muted : theme.colors.primary} paddingX={1}>
        <Text color={isDisabled ? theme.colors.muted : theme.colors.primary} bold>❯ </Text>
        <TextInput
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          theme={theme}
        />
      </Box>
      {visible.length > 0 && !isDisabled ? (
        <Box flexDirection="column" marginTop={0}>
          {visible.map((opt, i) => {
            const isActive = i === activeIndex;
            const labelColor = isActive ? theme.colors.textInverse : color;
            const bgColor = isActive ? theme.colors.focus : undefined;
            return (
              <Box
                key={`${opt.value}-${i}`}
                onClick={() => {
                  onActiveChange?.(i);
                  onSelect?.(opt.value);
                }}
                backgroundColor={bgColor}
                paddingX={1}
                flexDirection="row"
                alignItems="center"
              >
                <Text color={labelColor} bold={isActive}>
                  {opt.label}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
};
