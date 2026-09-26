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
  /** Called when Up Arrow is pressed. Return true to prevent default history navigation */
  onUpArrow?: () => boolean | void;
  /** Called when Down Arrow is pressed. Return true to prevent default history navigation */
  onDownArrow?: () => boolean | void;
  /** Called when Page Up is pressed. Return true to prevent default */
  onPageUp?: () => boolean | void;
  /** Called when Page Down is pressed. Return true to prevent default */
  onPageDown?: () => boolean | void;
  /** Called when Tab is pressed. Return true to prevent default autocomplete */
  onTab?: () => boolean | void;
  /** Called when Escape is pressed while active */
  onEscape?: () => boolean | void;
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
  /** Autocomplete suggestions (e.g. slash commands) */
  suggestions?: string[];
  /** Disabled while agent is thinking/streaming */
  disabled?: boolean;
  /** Show live character and estimated token counter */
  showCounter?: boolean;
  /** Called when Escape is pressed while disabled */
  onCancel?: () => void;
  /** Maximum length limit */
  maxLength?: number;
}

// ─── shared display ──────────────────────────────────────────────────────────

interface DisplayProps {
  value: string;
  placeholder: string;
  password: boolean;
  isFocused: boolean;
  cursor: number;
  theme: InkUITheme;
  suggestionSuffix?: string;
}

const CursorChar: React.FC<{ char: string; color: string }> = ({ char, color }) => (
  <Text color={color} inverse>{char}</Text>
);

function deleteWordBackward(text: string, cursor: number): { text: string; cursor: number } {
  if (cursor === 0) return { text, cursor: 0 };
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  const trimmed = before.trimEnd();
  const lastSpace = trimmed.lastIndexOf(' ');
  const newBefore = lastSpace === -1 ? '' : before.slice(0, lastSpace + 1);
  return { text: newBefore + after, cursor: newBefore.length };
}

const InputDisplay: React.FC<DisplayProps> = ({
  value, placeholder, password, isFocused, cursor, theme, suggestionSuffix,
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
  const atEnd = cursor === display.length;
  const cursorChar = atEnd && suggestionSuffix ? suggestionSuffix[0] : (display[cursor] ?? ' ');
  const remainder = atEnd && suggestionSuffix ? suggestionSuffix.slice(1) : suggestionSuffix;
  return (
    <Box>
      {cursor > 0 && <Text>{display.slice(0, cursor)}</Text>}
      <CursorChar char={cursorChar} color={theme.colors.focus} />
      {cursor < display.length - 1 && <Text>{display.slice(cursor + 1)}</Text>}
      {remainder && (
        <Text color={theme.colors.muted} dimColor>
          {remainder} <Text color="gray" dimColor>[Tab]</Text>
        </Text>
      )}
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
    if (!history?.length) return false;
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
    const target = index + 1;
    const isDraft = target >= history.length;
    setIndex(isDraft ? -1 : target);
    const val = isDraft ? draftRef.current : history[target]!;
    onChange(val);
    setCursor(val.length);
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
  value, onChange, onSubmit, onUpArrow, onDownArrow, onPageUp, onPageDown, onTab, onEscape, history, placeholder = '', password = false, theme,
  suggestions, maxLength,
}) => {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(value.length);
  const { navigate, reset } = useHistoryNav(history, value, onChange, setCursor);

  React.useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value.length]);

  const activeSuggestion = React.useMemo(() => {
    if (!suggestions || !value || password) return undefined;
    const match = suggestions.find((s) => s.toLowerCase().startsWith(value.toLowerCase()) && s.length > value.length);
    return match ? match.slice(value.length) : undefined;
  }, [suggestions, value, password]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (key.ctrl && input === 'a') { setCursor(0); return; }
    if (key.ctrl && input === 'e') { setCursor(value.length); return; }
    if (key.ctrl && (input === 'u' || input === 'k')) { onChange(''); setCursor(0); return; }
    if (key.ctrl && input === 'w') {
      const res = deleteWordBackward(value, cursor);
      onChange(res.text);
      setCursor(res.cursor);
      return;
    }
    if (key.escape && onEscape && onEscape()) return;
    if (key.tab && onTab && onTab()) return;
    if ((key.tab || (key.rightArrow && cursor === value.length)) && activeSuggestion) {
      const full = value + activeSuggestion;
      onChange(full);
      setCursor(full.length);
      return;
    }
    if (key.pageUp && onPageUp && onPageUp()) return;
    if (key.pageDown && onPageDown && onPageDown()) return;
    if (key.upArrow) {
      if (onUpArrow && onUpArrow()) return;
      navigate(-1);
      return;
    }
    if (key.downArrow) {
      if (onDownArrow && onDownArrow()) return;
      navigate(1);
      return;
    }
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

    if (maxLength && value.length + input.length > maxLength) return;
    onChange(value.slice(0, cursor) + input + value.slice(cursor));
    setCursor((c) => c + input.length);
  });

  return (
    <InputDisplay
      value={value} placeholder={placeholder} password={password} isFocused cursor={cursor} theme={theme}
      suggestionSuffix={cursor === value.length ? activeSuggestion : undefined}
    />
  );
};

// ─── public component ─────────────────────────────────────────────────────────

export const TextInput: React.FC<TextInputProps> = ({
  value, onChange, onSubmit, onUpArrow, onDownArrow, onPageUp, onPageDown, onTab, onEscape, history, placeholder = '', password = false, focus = true, label,
  theme = darkTheme, suggestions, disabled = false, showCounter = false, onCancel, maxLength,
}) => {
  const { isRawModeSupported } = useStdin();
  const canFocus = focus && isRawModeSupported && !disabled;

  useInput((_input, key) => {
    if (disabled && key.escape) onCancel?.();
  }, { isActive: disabled });

  return (
    <Box flexDirection="row" justifyContent="space-between" width="100%">
      <Box flexDirection="row" flexGrow={1}>
        {label ? <Text color={theme.colors.muted}>{label} </Text> : null}
        <Text color={disabled ? theme.colors.muted : theme.colors.border}>{'❯ '}</Text>
        {disabled ? (
          <Text color={theme.colors.muted} dimColor>
            {placeholder || 'Thinking... [Esc to cancel]'}
          </Text>
        ) : canFocus ? (
          <FocusedInput
            value={value} onChange={onChange} onSubmit={onSubmit} onUpArrow={onUpArrow} onDownArrow={onDownArrow}
            onPageUp={onPageUp} onPageDown={onPageDown}
            onTab={onTab} onEscape={onEscape} history={history} placeholder={placeholder} password={password} focus={focus} theme={theme}
            suggestions={suggestions} maxLength={maxLength}
          />
        ) : (
          <InputDisplay
            value={value} placeholder={placeholder} password={password} isFocused={false} cursor={value.length} theme={theme}
          />
        )}
      </Box>

      {showCounter && !disabled && (
        <Box marginLeft={2}>
          <Text color={theme.colors.muted} dimColor>
            {`${value.length}c · ~${Math.ceil(value.length / 4)}t`}
          </Text>
        </Box>
      )}
    </Box>
  );
};
