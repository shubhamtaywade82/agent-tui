/**
 * src/components/ui/gauge/Gauge.tsx — Termina migration adapter.
 *
 * Was: a full local copy with `value`/`min`/`max`/`label`/`unit`/`variant`
 * ('arc'/'bar'/'ring')/`colorStops`/`width`/`showValue`/`theme`.
 * Now: a thin adapter around `@nemesis-oss/termina-ui`'s Gauge.
 *
 * API deltas:
 *   - Local:  `value` is a raw number in [min, max]; percent is computed.
 *   - NPM:    `value` is already a percent in [0, 100].
 *   - Local:  `variant` switches between 'bar' / 'arc' / 'ring' rendering.
 *   - NPM:    only the 'bar' variant exists.
 *   - Local:  `colorStops` switches color by threshold (green/yellow/red).
 *   - NPM:    color comes from `useComponentTheme('Gauge').config({value})`.
 *   - Local:  `unit` suffixes the displayed value (e.g. '50%').
 *   - NPM:    always shows 'N%' (no unit override).
 *
 * Adapter behavior:
 *   - Fast path: when `variant === 'bar'` (default) AND no `colorStops` AND
 *     `unit === '%'` (default), delegate to the npm Gauge (computing percent
 *     from value/min/max).
 *   - Styled path: for 'arc'/'ring' variants or custom colorStops/unit,
 *     re-implement locally (same code as before migration). This path is
 *     kept until consumers drop the rich props.
 *
 * See scratch/MIGRATION.md for the full migration playbook.
 */
import React from 'react';
import { Box, Text } from '@nemesis-oss/termina-core';
import { Gauge as TerminaGauge } from '@nemesis-oss/termina-ui';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface GaugeProps {
  value: number;
  min?: number;
  max?: number;
  label?: string;
  unit?: string;
  variant?: 'arc' | 'bar' | 'ring';
  colorStops?: [number, string][];
  width?: number;
  showValue?: boolean;
  theme?: InkUITheme;
}

export const Gauge: React.FC<GaugeProps> = ({
  value,
  min = 0,
  max = 100,
  label,
  unit = '%',
  variant = 'bar',
  colorStops,
  width = 20,
  showValue = true,
  theme = darkTheme,
}) => {
  // Fast path: delegate to the npm Gauge for the simple bar case.
  if (variant === 'bar' && !colorStops && unit === '%') {
    const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
    return <TerminaGauge value={pct} label={label} width={width} showValue={showValue} />;
  }

  // Styled path: re-implement locally for arc/ring variants and custom
  // colorStops. This is the same code that existed pre-migration; it
  // remains here as a compatibility shim until consumers drop the rich
  // props (or until the npm package gains equivalent features).
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  const defaultStops: [number, string][] = [
    [0, theme.colors.success],
    [60, theme.colors.warning],
    [80, theme.colors.error],
  ];
  const stops = colorStops ?? defaultStops;
  let color = stops[0][1];
  for (const [threshold, c] of stops) {
    if (pct >= threshold) color = c;
  }

  const displayValue = `${Math.round(value)}${unit}`;

  if (variant === 'ring') {
    const ringWidth = Math.floor(width / 2);
    const topFilled = Math.round((pct / 100) * ringWidth);
    const topBar = '█'.repeat(topFilled) + '░'.repeat(ringWidth - topFilled);
    const botBar = '█'.repeat(topFilled) + '░'.repeat(ringWidth - topFilled);

    return (
      <Box flexDirection="column" alignItems="center">
        <Text color={color}>{'◜'}{topBar}{'◝'}</Text>
        <Text color={theme.colors.muted}>{'█'}{' '.repeat(ringWidth)}{' █'}</Text>
        <Text color={theme.colors.muted}>{'█'} <Text color={color}>{displayValue.padStart(ringWidth - 1)}</Text>{' █'}</Text>
        <Text color={theme.colors.muted}>{'█'}{' '.repeat(ringWidth)}{' █'}</Text>
        <Text color={color}>{'◟'}{botBar}{'◞'}</Text>
        {label && <Text color={theme.colors.muted} dimColor>{label}</Text>}
      </Box>
    );
  }

  // arc variant
  const arcWidth = Math.max(10, width);
  const filled = Math.round((pct / 100) * arcWidth);
  const arcBar = '█'.repeat(filled) + '░'.repeat(arcWidth - filled);

  return (
    <Box flexDirection="column" alignItems="center">
      <Text color={theme.colors.border}>{'  ╭' + '─'.repeat(arcWidth) + '╮'}</Text>
      <Text color={theme.colors.border}>{' ╱'}{' '.repeat(arcWidth + 2)}{'╲'}</Text>
      <Text color={theme.colors.border}>{'╱  '}<Text color={color}>{arcBar}</Text>{'  ╲'}</Text>
      <Text color={theme.colors.border}>{'│'}{' '.repeat(Math.floor(arcWidth / 2))}<Text color={color}>{displayValue}</Text>{' '.repeat(Math.ceil(arcWidth / 2))}{'│'}</Text>
      <Text color={theme.colors.border}>{'╲'}{' '.repeat(arcWidth + 2)}{'╱'}</Text>
      <Text color={theme.colors.border}>{'  ╰' + '─'.repeat(arcWidth) + '╯'}</Text>
      {label && <Text color={theme.colors.muted} dimColor>{'   '}{label}</Text>}
    </Box>
  );
};
