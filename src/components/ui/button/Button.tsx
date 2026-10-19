/**
 * src/components/ui/button/Button.tsx
 *
 * A bordered clickable button — the standalone version of the GenUI
 * Button. Uses <Box onClick> + <Text> with a rounded border (the
 * conventional TUI button chrome). For chromeless clickable text, use
 * `LinkButton` instead.
 *
 * Contrast:
 *   - `Button`     — bordered, prominent action (this component)
 *   - `LinkButton` — chromeless, inline clickable text
 *   - `Link`       — OSC 8 URL hyperlink (terminal handles the click)
 *
 * The click handler receives the termina-core MouseEvent so you can
 * distinguish left/right click, check modifier keys, etc.
 *
 * Requires mouse tracking: `render(<App/>, {mouse: true})`.
 *
 * Props:
 *   - label:       the button text
 *   - onClick:     click handler (receives MouseEvent)
 *   - variant:     'primary' | 'secondary' | 'danger' | 'success' (controls colors)
 *   - isDisabled:  greys out + blocks clicks
 *   - icon:        optional icon before the label
 *
 * Usage:
 *   <Button label="Run" variant="primary" onClick={() => runPrompt(text)} />
 *   <Button label="Cancel" variant="danger" icon="✖" onClick={onCancel} />
 */
import React from 'react';
import { Box, Text, type MouseEvent } from '@nemesis-oss/termina-core';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success';

export interface ButtonProps {
  readonly label: string;
  readonly onClick?: (event: MouseEvent) => void;
  readonly variant?: ButtonVariant;
  readonly isDisabled?: boolean;
  readonly icon?: string;
  readonly theme?: InkUITheme;
}

function variantColors(variant: ButtonVariant, theme: InkUITheme): { fg: string; bg?: string; border: string } {
  switch (variant) {
    case 'primary':   return { fg: theme.colors.primary,   border: theme.colors.primary };
    case 'secondary': return { fg: theme.colors.info,     border: theme.colors.info };
    case 'danger':    return { fg: theme.colors.error,    border: theme.colors.error };
    case 'success':   return { fg: theme.colors.success,  border: theme.colors.success };
    default:          return { fg: theme.colors.primary,   border: theme.colors.primary };
  }
}

export const Button: React.FC<ButtonProps> = ({
  label,
  onClick,
  variant = 'primary',
  isDisabled = false,
  icon,
  theme = darkTheme,
}) => {
  const { fg, border } = variantColors(variant, theme);
  const color = isDisabled ? theme.colors.muted : fg;
  const borderColor = isDisabled ? theme.colors.muted : border;

  const handleClick = (event: MouseEvent) => {
    if (isDisabled) return;
    onClick?.(event);
  };

  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      onClick={handleClick}
      flexDirection="row"
      gap={1}
    >
      {icon ? <Text color={color} bold={!isDisabled}>{icon}</Text> : null}
      <Text color={color} bold={!isDisabled}>
        {label}
      </Text>
    </Box>
  );
};
