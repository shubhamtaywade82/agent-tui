/**
 * src/components/ui/progress-bar/ProgressBar.tsx — Termina migration adapter.
 *
 * Was: a full local copy with `value`/`label`/`showPercent`/`width`/`theme`.
 * Now: a thin adapter around `@nemesis-oss/termina-ui`'s ProgressBar.
 *
 * API deltas:
 *   - Local:  `value` is a percent in [0, 100]; supports `label`, `showPercent`,
 *     `width`, and `theme` for color.
 *   - NPM:    `value` is a percent in [0, 100]; auto-fills parent width; no
 *     label, no percent suffix, no theme color override.
 *
 * Adapter behavior:
 *   - Fast path: when no `label`, no `showPercent`, no `width`, no `theme`
 *     are specified, delegate directly to the npm ProgressBar.
 *   - Styled path: when any of those props are present, re-implement locally
 *     to preserve the rich rendering (label on the left, percent suffix on
 *     the right, fixed bar width, theme colors). This path stays until
 *     consumers drop the rich props or the npm package gains equivalent
 *     features (e.g. label/percent slots in the theme).
 *
 * See scratch/MIGRATION.md for the full migration playbook.
 */
import React from 'react';
import { Box, Text, useWindowSize } from '@nemesis-oss/termina-core';
import { ProgressBar as TerminaProgressBar } from '@nemesis-oss/termina-ui';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface ProgressBarProps {
  /** Progress value 0–100 */
  value: number;
  /** Optional label shown to the left of the bar */
  label?: string;
  /** Show percentage at the right end */
  showPercent?: boolean;
  /** Fixed bar width in columns — defaults to auto (fills terminal width) */
  width?: number;
  /** Theme override — defaults to darkTheme */
  theme?: InkUITheme;
}

const FILL = '█';
const EMPTY = '░';

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  label,
  showPercent = true,
  width,
  theme,
}) => {
  // Fast path: delegate to the npm ProgressBar for the simple case.
  if (label === undefined && showPercent === true && width === undefined && theme === undefined) {
    return <TerminaProgressBar value={value} />;
  }

  // Styled path: re-implement locally for the rich case. Same code as
  // pre-migration; remains here as a compatibility shim.
  const resolvedTheme = theme ?? darkTheme;
  const { columns: termWidth } = useWindowSize();

  // Clamp value to [0, 100]
  const pct = Math.min(100, Math.max(0, value));

  // Build the bar width:
  // total - label - space - percent suffix (e.g. " 100%") - 2 padding spaces
  const percentSuffix = showPercent ? ` ${String(Math.round(pct)).padStart(3)}%` : '';
  const labelPrefix = label ? `${label} ` : '';
  const overhead = labelPrefix.length + percentSuffix.length;
  // Account for container border/padding (4 cols) when width is not specified
  const barWidth = width ?? Math.max(8, termWidth - overhead - 4);

  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;

  const filledStr = FILL.repeat(filled);
  const emptyStr = EMPTY.repeat(empty);

  return (
    <Box>
      {label ? <Text>{label} </Text> : null}
      <Text color={resolvedTheme.colors.primary}>{filledStr}</Text>
      <Text color={resolvedTheme.colors.muted}>{emptyStr}</Text>
      {showPercent ? (
        <Text color={resolvedTheme.colors.muted}>{percentSuffix}</Text>
      ) : null}
    </Box>
  );
};
