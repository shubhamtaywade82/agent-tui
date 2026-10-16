/**
 * src/components/ui/divider/Divider.tsx — Termina migration adapter.
 *
 * Was: a full local copy with `width`/`style`/`color`/`theme` props.
 * Now: a thin adapter around `@nemesis-oss/termina-ui`'s Divider.
 *
 * API deltas:
 *   - The npm Divider only takes `title?: string` and auto-fills the
 *     parent's width. It uses a single `─` character; no `style` switch.
 *   - To preserve the local `style` prop, this adapter renders the
 *     appropriate Unicode character itself when `style !== 'single'`.
 *   - To preserve the local `width` prop, this adapter wraps the rule
 *     in a `<Box width={width}>`.
 *   - `theme` and `color` are honored by passing them to the underlying
 *     `<Text>` element (the npm Divider doesn't expose color, so this
 *     adapter re-implements the rule using termina-core primitives when
 *     any of those props is set; otherwise it delegates to the npm
 *     Divider for default rendering).
 *
 * Migration note: once all consumers drop `style`/`width`/`color`/`theme`
 * in favor of just `title`, this adapter can shrink to a one-liner:
 *   `export { Divider } from '@nemesis-oss/termina-ui';`
 *
 * See scratch/MIGRATION.md for the full migration playbook.
 */
import React from 'react';
import { Box, Text, useWindowSize } from '@nemesis-oss/termina-core';
import { Divider as TerminaDivider } from '@nemesis-oss/termina-ui';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export type DividerStyle = 'single' | 'double' | 'dashed' | 'bold';

export interface DividerProps {
  title?: string;
  style?: DividerStyle;
  /** Defaults to terminal width */
  width?: number;
  theme?: InkUITheme;
  color?: string;
}

const CHARS: Record<DividerStyle, string> = {
  single: '─',
  double: '═',
  dashed: '╌',
  bold: '━',
};

export const Divider: React.FC<DividerProps> = ({
  title,
  style = 'single',
  width,
  theme = darkTheme,
  color,
}) => {
  // Fast path: if no extra styling is requested, delegate to the npm Divider.
  // The npm version uses '─' and auto-fills the parent's width.
  if (style === 'single' && color === undefined && title === undefined) {
    return <TerminaDivider />;
  }

  // Styled path: re-implement the rule locally (this is the same code
  // that existed in the pre-migration Divider.tsx; it remains here as a
  // compatibility shim until consumers drop the extra props).
  const { columns } = useWindowSize();
  const totalWidth = width ?? columns;
  const char = CHARS[style];
  const textColor = color ?? theme.colors.border;

  let line: string;
  if (title) {
    const prefix = char + char + ' ';
    const suffix = ' ';
    const remaining = totalWidth - prefix.length - title.length - suffix.length;
    line = prefix + title + suffix + char.repeat(Math.max(0, remaining));
  } else {
    line = char.repeat(totalWidth);
  }

  return (
    <Box width={width}>
      <Text color={textColor}>{line}</Text>
    </Box>
  );
};
