/**
 * src/components/ui/menu-item/MenuItem.tsx
 *
 * A clickable menu row — icon + label + optional shortcut hint, with
 * hover/active state styling. Designed for dropdown menus, context menus,
 * autocomplete suggestion lists, and the `/help` command palette.
 *
 * Built from `<Box onClick>` + `<Text>` — the "clickable" is real mouse
 * hit-testing via termina-core's `MouseEvent` dispatch (not just keyboard
 * focus). The `isActive` prop controls the visual highlight (inverted
 * background by default) so the same component works for both:
 *   - Mouse-driven menus (hover = active, click = select)
 *   - Keyboard-driven menus (arrow keys move `isActive`, Enter triggers
 *     `onSelect`)
 *
 * Props:
 *   - label:       the menu item text
 *   - icon:        optional icon/emoji before the label (e.g. '⚙', '📁', '✓')
 *   - shortcut:    optional keyboard shortcut hint shown at the right
 *                  (e.g. 'Ctrl+O', 'Enter', 'Tab')
 *   - isActive:    whether this item is currently highlighted/active
 *   - onClick:     mouse click handler
 *   - onSelect:    keyboard-select handler (for Enter on active item)
 *   - isDisabled:  greys out the item and disables click/select
 *   - color, theme: standard styling
 *
 * Usage:
 *   <MenuItem
 *     icon="📁"
 *     label="Open file"
 *     shortcut="Ctrl+O"
 *     isActive={hoveredIndex === i}
 *     onClick={() => openFile()}
 *     onSelect={() => openFile()}
 *   />
 */
import React from 'react';
import { Box, Text, type MouseEvent } from '@nemesis-oss/termina-core';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface MenuItemProps {
  /** The menu item text. */
  readonly label: string;
  /** Optional icon/emoji rendered before the label (e.g. '⚙', '📁', '✓'). */
  readonly icon?: string;
  /** Optional keyboard shortcut hint shown at the right (e.g. 'Ctrl+O', 'Enter'). */
  readonly shortcut?: string;
  /** Whether this item is currently highlighted/active (hover or keyboard focus). @default false */
  readonly isActive?: boolean;
  /** Mouse click handler. Not called when isDisabled. */
  readonly onClick?: (event: MouseEvent) => void;
  /** Keyboard-select handler (for Enter on active item). Not called when isDisabled. */
  readonly onSelect?: () => void;
  /** Greys out the item and disables click/select. @default false */
  readonly isDisabled?: boolean;
  /** Text color when not active. @default 'white' */
  readonly color?: string;
  /** Theme override — defaults to darkTheme. */
  readonly theme?: InkUITheme;
  /** Width constraint. */
  readonly width?: number | string;
}

export const MenuItem: React.FC<MenuItemProps> = ({
  label,
  icon,
  shortcut,
  isActive = false,
  onClick,
  onSelect,
  isDisabled = false,
  color = 'white',
  theme = darkTheme,
  width,
}) => {
  // Active items get an inverted background (highlight bar). Disabled items
  // are dimmed. Active + disabled = dimmed (disabled wins).
  const labelColor = isDisabled
    ? theme.colors.muted
    : isActive
      ? theme.colors.textInverse
      : color;
  const bgColor = isActive && !isDisabled ? theme.colors.focus : undefined;
  const iconColor = isDisabled
    ? theme.colors.muted
    : isActive
      ? theme.colors.textInverse
      : theme.colors.info;

  const handleClick = (event: MouseEvent) => {
    if (isDisabled) return;
    onClick?.(event);
    // Also fire onSelect so mouse + keyboard share the same handler
    // without the parent having to wire both.
    onSelect?.();
  };

  return (
    <Box
      width={width}
      onClick={handleClick}
      backgroundColor={bgColor}
      paddingX={1}
      flexDirection="row"
      alignItems="center"
      gap={1}
    >
      {icon ? (
        <Text color={iconColor} bold={!isDisabled}>
          {icon}
        </Text>
      ) : null}
      <Text color={labelColor} bold={isActive && !isDisabled}>
        {label}
      </Text>
      {shortcut ? (
        <Box flexGrow={1} alignItems="flex-end">
          <Text color={isDisabled ? theme.colors.muted : theme.colors.muted} dimColor>
            {shortcut}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};
