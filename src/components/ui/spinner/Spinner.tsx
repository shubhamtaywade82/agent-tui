/**
 * src/components/ui/spinner/Spinner.tsx — Termina migration adapter.
 *
 * This file was previously a full local copy of the ink-ui Spinner.
 * It is now a thin adapter that wraps `@nemesis-oss/termina-ui`'s
 * Spinner and accepts the local prop shape so existing consumers
 * (ChatAccordion, AgentPanel, Chat, scratch/transcript-poc) don't
 * need to change.
 *
 * The local API takes:
 *   - `label?: string`
 *   - `type?: 'dots' | 'line' | 'arc' | 'bounce'`
 *   - `interval?: number`     ← ignored (npm version uses cli-spinners default)
 *   - `theme?: InkUITheme`   ← ignored (npm version uses ThemeProvider)
 *
 * The npm API takes:
 *   - `label?: string`
 *   - `type?: SpinnerName` (any cli-spinners name, e.g. 'dots', 'line', 'arc')
 *
 * Migration note: the local `SpinnerType` ('dots' | 'line' | 'arc' | 'bounce')
 * is a subset of cli-spinners' `SpinnerName`, so the adapter just forwards
 * the value as-is. If you previously passed `interval`, the new spinner
 * uses cli-spinners' default interval (usually 80ms for 'dots').
 *
 * See scratch/MIGRATION.md for the full migration playbook.
 */
import React from 'react';
import { Spinner as TerminaSpinner } from '@nemesis-oss/termina-ui';
import type { SpinnerName } from 'cli-spinners';
import type { InkUITheme } from '../_core.js';

// Re-export the local type name so existing imports keep working.
export type SpinnerType = 'dots' | 'line' | 'arc' | 'bounce';

export interface SpinnerProps {
  /** Text shown after the spinner frame */
  label?: string;
  /** Animation style — dots | line | arc | bounce (mapped to cli-spinners name) */
  type?: SpinnerType;
  /** Frame interval in milliseconds — IGNORED in the adapter (cli-spinners default applies) */
  interval?: number;
  /** Theme override — IGNORED in the adapter (use <ThemeProvider theme={...}> instead) */
  theme?: InkUITheme;
}

const TYPE_MAP: Record<SpinnerType, SpinnerName> = {
  dots: 'dots',
  line: 'line',
  arc: 'arc',
  bounce: 'bounce',
};

export const Spinner: React.FC<SpinnerProps> = ({ label, type = 'dots', interval: _ignored, theme: _ignored2 }) => {
  void _ignored;
  void _ignored2;
  return <TerminaSpinner label={label} type={TYPE_MAP[type]} />;
};
