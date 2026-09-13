import React, { useState } from 'react';
import { Box, Text, useInput, useApp, useStdin } from 'ink';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface TextInputProps {
  /** Controlled value */
  value: string;
  /** Called on every keystroke with the new value */
  onChange: (value: string) => void;
  /** Called when Enter is pressed */
  onSubmit?: (value: string) => void;
  /** Called when Up Arrow is pressed */
  onUpArrow?: () => void;
  /** Called when Down Arrow is pressed */
  onDownArrow?: () => void;
  /** History entries for Up/Down prompt navigation */
  history?: string[];
  /** Shown when value is empty */
  placeholder?: string;
  /** Mask input characters as * */
  password?: boolean;
  /** Whether this input captures keyboard input */
  focus?: boolean;
  /** Optional label rendered to the left */
  label?: string;
  /** Theme override — defaults to darkTheme */
  theme?: InkUITheme;
}

// ─── shared display ──────────────────────────────────────────────────────────

interface DisplayProps {
  value: string;
  placeholder: string;
  password: boolean;
  isFocused: boolean;
  cursor: number;
  theme: InkUITheme;
}

const CursorChar: React.FC<{ char: string; color: string }> = ({ char, color }) => (
  <Text color={color} inverse>{char}</Text>
);

const InputDisplay: React.FC<DisplayProps> = ({
  value, placeholder, password, isFocused, cursor, theme,
}) => {
  const display = password ? '*'.repeat(value.length) : value;
  if (!isFocused) {
    return <Text color={value.length === 0 ? theme.colors.muted : undefined}>{value.length === 0 ? placeholder : display}</Text>;
  }
  if (value.length === 0) {
    return (
      <Box>
        <CursorChar char={placeholder[0] ?? ' '} color={theme.colors.focus} />
        {placeholder.length > 1 && <Text color={theme.colors.muted}>{placeholder.slice(1)}</Text>}
      </Box>
    );
  }
  return (
    <Box>
      {cursor > 0 && <Text>{display.slice(0, cursor)}</Text>}
      <CursorChar char={display[cursor] ?? ' '} color={theme.colors.focus} />
      {cursor < display.length - 1 && <Text>{display.slice(cursor + 1)}</Text>}
    </Box>
  );
};

// ─── history navigation hook ─────────────────────────────────────────────────

function useHistoryNav(
  history: string[] | undefined,
  value: string,
  onChange: (val: string) => void,
  setCursor: (pos: number) => void,
) {
  const [index, setIndex] = useState(-1);
  const draftRef = React.useRef('');

  const navigate = (direction: -1 | 1): boolean => {
    if (!history || history.length === 0) return false;
    if (direction === -1) {
      const target = index === -1 ? history.length - 1 : index - 1;
      if (target < 0) return true;
      if (index === -1) draftRef.current = value;
      setIndex(target);
      const val = history[target]!;
      onChange(val);
      setCursor(val.length);
      return true;
    }
    if (index === -1) return false;
    if (index < history.length - 1) {
      const target = index + 1;
      setIndex(target);
      const val = history[target]!;
      onChange(val);
      setCursor(val.length);
      return true;
    }
    setIndex(-1);
    const draft = draftRef.current;
    onChange(draft);
    setCursor(draft.length);
    return true;
  };

  const reset = () => { setIndex(-1); draftRef.current = ''; };
  return { navigate, reset };
}

// ─── focused inner ───────────────────────────────────────────────────────────

interface FocusedInputProps extends TextInputProps {
  theme: InkUITheme;
}

const FocusedInput: React.FC<FocusedInputProps> = ({
  value, onChange, onSubmit, onUpArrow, onDownArrow, history, placeholder = '', password = false, theme,
}) => {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(value.length);
  const { navigate, reset } = useHistoryNav(history, value, onChange, setCursor);

  React.useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value.length]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (key.upArrow)   { onUpArrow?.();   navigate(-1); return; }
    if (key.downArrow) { onDownArrow?.(); navigate(1);  return; }
    if (key.leftArrow)  { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.rightArrow) { setCursor((c) => Math.min(value.length, c + 1)); return; }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      onChange(value.slice(0, cursor - 1) + value.slice(cursor));
      setCursor((c) => c - 1);
      return;
    }
    if (key.return) { reset(); onSubmit?.(value); return; }
    if (key.tab || key.ctrl || key.meta || key.escape) return;
    if (/^\[?<\d+;\d+;\d+[Mm]/.test(input) || /^\[?M.../.test(input)) return;

    onChange(value.slice(0, cursor) + input + value.slice(cursor));
    setCursor((c) => c + input.length);
  });

  return (
    <InputDisplay
      value={value} placeholder={placeholder} password={password} isFocused cursor={cursor} theme={theme}
    />
  );
};

// ─── public component ─────────────────────────────────────────────────────────

export const TextInput: React.FC<TextInputProps> = ({
  value, onChange, onSubmit, onUpArrow, onDownArrow, history, placeholder = '', password = false, focus = true, label, theme = darkTheme,
}) => {
  const { isRawModeSupported } = useStdin();
  const canFocus = focus && isRawModeSupported;

  return (
    <Box>
      {label ? <Text color={theme.colors.muted}>{label} </Text> : null}
      <Text color={theme.colors.border}>{'❯ '}</Text>
      {canFocus ? (
        <FocusedInput
          value={value} onChange={onChange} onSubmit={onSubmit} onUpArrow={onUpArrow} onDownArrow={onDownArrow}
          history={history} placeholder={placeholder} password={password} focus={focus} theme={theme}
        />
      ) : (
        <InputDisplay
          value={value} placeholder={placeholder} password={password} isFocused={false} cursor={value.length} theme={theme}
        />
      )}
    </Box>
  );
};
