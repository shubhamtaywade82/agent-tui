/**
 * src/components/ui/badge/Badge.tsx — Termina migration adapter.
 *
 * Was: a full local copy with `variant` + `theme` props.
 * Now: a thin adapter around `@nemesis-oss/termina-ui`'s Badge.
 *
 * API deltas:
 *   - Local:  `<Badge variant="success">Active</Badge>`  (variant maps to theme color)
 *   - NPM:    `<Badge color="green">Active</Badge>`      (color is a termina-core TextProps['color'])
 *
 * This adapter accepts the local `variant` prop and maps it to the
 * equivalent color name. The `theme` prop is honored only for custom
 * colors that fall outside the standard variant set; if `theme` is
 * omitted, the standard mapping applies.
 *
 * Migration note: once all consumers switch to the npm `color` prop
 * directly, this adapter can shrink to a one-liner:
 *   `export { Badge } from '@nemesis-oss/termina-ui';`
 *
 * See scratch/MIGRATION.md for the full migration playbook.
 */
import React from 'react';
import { Badge as TerminaBadge } from '@nemesis-oss/termina-ui';
import type { TextProps } from '@nemesis-oss/termina-core';
import type { InkUITheme } from '../_core.js';

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';

export interface BadgeProps {
  /** Badge label text */
  children: string;
  /** Visual style — maps to color names */
  variant?: BadgeVariant;
  /** Theme override — used to look up custom colors for the variant. If omitted, standard mapping applies. */
  theme?: InkUITheme;
}

/** Map a local variant to a termina-core TextProps['color']. */
function variantColor(variant: BadgeVariant, theme?: InkUITheme): TextProps['color'] {
  if (theme) {
    switch (variant) {
      case 'success': return theme.colors.success as TextProps['color'];
      case 'warning': return theme.colors.warning as TextProps['color'];
      case 'error':   return theme.colors.error as TextProps['color'];
      case 'info':    return theme.colors.info as TextProps['color'];
      default:        return theme.colors.muted as TextProps['color'];
    }
  }
  // Standard mapping — these are built-in termina-core color names.
  switch (variant) {
    case 'success': return 'green';
    case 'warning': return 'yellow';
    case 'error':   return 'red';
    case 'info':    return 'blue';
    default:        return 'gray';
  }
}

export const Badge: React.FC<BadgeProps> = ({ children, variant = 'default', theme }) => {
  return <TerminaBadge color={variantColor(variant, theme)}>{children}</TerminaBadge>;
};
