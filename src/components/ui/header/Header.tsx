import React from 'react';
import { Text, Box, useStdout } from 'ink';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export type HeaderStyle = 'box' | 'line' | 'filled';

export interface HeaderProps {
  title: string;
  version?: string;
  subtitle?: string;
  style?: HeaderStyle;
  align?: 'left' | 'center';
  theme?: InkUITheme;
  width?: number;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  version,
  subtitle,
  style = 'box',
  align = 'left',
  theme = darkTheme,
  width,
}) => {
  const { stdout } = useStdout();
  const w = width ?? stdout?.columns ?? 80;
  const fullTitle = version ? `${title} v${version}` : title;

  if (style === 'box') {
    // ┌─── MyApp v1.0 ──────────────────┐
    const inner = Math.max(10, w - 2); // exclude ┌ and ┐
    const maxTitle = Math.max(0, inner - 6);
    const displayTitle = fullTitle.length > maxTitle ? fullTitle.slice(0, Math.max(0, maxTitle - 3)) + '...' : fullTitle;
    const label = ` ${displayTitle} `;
    const left  = 3; // ─── before label
    const right = Math.max(0, inner - left - label.length);
    const top = '┌' + '─'.repeat(left) + label + '─'.repeat(right) + '┐';
    const bot = '└' + '─'.repeat(inner) + '┘';
    const sub = subtitle ? (subtitle.length > inner - 2 ? subtitle.slice(0, Math.max(0, inner - 5)) + '...' : subtitle).padEnd(inner - 2) : '';

    return (
      <Box flexDirection="column" width={w}>
        <Text color={theme.colors.primary}>{top}</Text>
        {subtitle && (
          <Text color={theme.colors.primary}>
            {'│'} <Text color={theme.colors.muted}>{sub}</Text> {'│'}
          </Text>
        )}
        <Text color={theme.colors.primary}>{bot}</Text>
      </Box>
    );
  }

  if (style === 'line') {
    // ══ MyApp v1.0 ════════════════════
    const label = ` ${fullTitle} `;
    const pre = '══';
    const remaining = Math.max(0, w - pre.length - label.length);
    const line = pre + label + '═'.repeat(remaining);

    return (
      <Box flexDirection="column" width={w}>
        <Text color={theme.colors.primary}>{line}</Text>
        {subtitle && <Text color={theme.colors.muted}>   {subtitle}</Text>}
      </Box>
    );
  }

  // filled: ███ MyApp v1.0 ████████████
  const label = ` ${fullTitle} `;
  const pre = '██ ';
  const remaining = Math.max(0, w - pre.length - label.length);
  const line = pre + label + '█'.repeat(remaining);

  return (
    <Box flexDirection="column" width={w}>
      <Text color={theme.colors.primary}>{line}</Text>
      {subtitle && <Text color={theme.colors.muted}>    {subtitle}</Text>}
    </Box>
  );
};
