/**
 * src/components/ui/status-indicator/StatusIndicator.tsx — Termina migration adapter.
 *
 * Was: a full local copy with `status` (online/offline/loading/warning/error/idle),
 * `label`, `pulse`, `theme`. Renders a colored dot + label with optional
 * pulse animation.
 * Now: a thin adapter around `@nemesis-oss/termina-ui`'s `StatusMessage`.
 *
 * API deltas:
 *   - Local:  dot-based indicator (`●`/`○`/`✕`/`⚠`/`◉`) with `pulse` animation
 *             for loading. Six statuses.
 *   - NPM:    icon-based `StatusMessage` with four variants (info/success/
 *             error/warning). No animation, no dot.
 *
 * Mapping:
 *   - 'online'  → 'success' (variant)
 *   - 'warning' → 'warning'
 *   - 'error'   → 'error'
 *   - 'idle'    → 'info'
 *   - 'loading' → no mapping (local has pulse animation; keep local impl)
 *   - 'offline' → no mapping (local uses `○` for offline; npm has no equivalent)
 *
 * Adapter behavior:
 *   - Fast path: when status is online/warning/error/idle AND `pulse` is
 *     falsy AND no `theme` override → delegate to `StatusMessage`.
 *   - Styled path: when status is 'loading' or 'offline', or `pulse` is
 *     true, or `theme` is provided → re-implement locally.
 *
 * See scratch/MIGRATION.md for the full migration playbook.
 */
import React, { useState, useEffect } from 'react';
import { Text, Box } from '@nemesis-oss/termina-core';
import { StatusMessage } from '@nemesis-oss/termina-ui';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export type StatusValue = 'online' | 'offline' | 'loading' | 'warning' | 'error' | 'idle';

export interface StatusIndicatorProps {
  status: StatusValue;
  label: string;
  /** Animate the dot — auto-enabled for loading status */
  pulse?: boolean;
  theme?: InkUITheme;
}

const PULSE_FRAMES = ['●', '◉', '●', '○'];

function statusColor(status: StatusValue, theme: InkUITheme): string {
  switch (status) {
    case 'online':  return theme.colors.success;
    case 'offline': return theme.colors.error;
    case 'error':   return theme.colors.error;
    case 'warning': return theme.colors.warning;
    case 'loading': return theme.colors.warning;
    case 'idle':    return theme.colors.muted;
  }
}

function staticDot(status: StatusValue): string {
  switch (status) {
    case 'online':  return '●';
    case 'offline': return '○';
    case 'error':   return '●';
    case 'warning': return '⚠';
    case 'loading': return '◉';
    case 'idle':    return '○';
  }
}

/** Map a local StatusValue to a StatusMessage variant, when possible. */
function statusToVariant(
  status: StatusValue,
): 'info' | 'success' | 'error' | 'warning' | null {
  switch (status) {
    case 'online':  return 'success';
    case 'warning': return 'warning';
    case 'error':   return 'error';
    case 'idle':    return 'info';
    case 'loading':
    case 'offline':
      return null; // no npm equivalent — fall back to local impl
  }
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  label,
  pulse,
  theme,
}) => {
  // Fast path: delegate to StatusMessage for the simple cases.
  const variant = statusToVariant(status);
  const canDelegate = variant !== null && !pulse && theme === undefined;
  if (canDelegate) {
    return <StatusMessage variant={variant as 'info' | 'success' | 'error' | 'warning'}>{label}</StatusMessage>;
  }

  // Styled path: re-implement locally for loading/offline/pulse/theme.
  const resolvedTheme = theme ?? darkTheme;
  const shouldAnimate = pulse ?? status === 'loading';
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!shouldAnimate) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % PULSE_FRAMES.length), 400);
    return () => clearInterval(t);
  }, [shouldAnimate]);

  const dot = shouldAnimate ? PULSE_FRAMES[frame] : staticDot(status);
  const color = statusColor(status, resolvedTheme);

  return (
    <Box gap={1}>
      <Text color={color}>{dot}</Text>
      <Text>{label}</Text>
    </Box>
  );
};
