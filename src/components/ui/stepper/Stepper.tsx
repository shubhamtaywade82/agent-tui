/**
 * src/components/ui/stepper/Stepper.tsx — Termina migration adapter.
 *
 * Was: a full local copy with rich Step shape (key/title/description/optional),
 * `currentStep: string`, `orientation`, `showNumbers`, `completedSteps`,
 * `errorSteps`, `theme`.
 * Now: a thin adapter around `@nemesis-oss/termina-ui`'s Stepper.
 *
 * API deltas:
 *   - Local:  `steps: Step[]` (object with key/title/description/optional),
 *             `currentStep: string` (matched by key).
 *   - NPM:    `steps: string[]` (just labels), `current?: number` (index).
 *   - Local:  `orientation` ('horizontal' | 'vertical'), `showNumbers`,
 *             `completedSteps`/`errorSteps` (color-coded), `theme`.
 *   - NPM:    renders each step on its own row (always "vertical"),
 *             steps before `current` are "done", after are "pending".
 *
 * Adapter behavior:
 *   - Fast path: when `orientation='vertical'` AND no `description` on any
 *     step AND no `optional` AND no `completedSteps` AND no `errorSteps` AND
 *     no `showNumbers`, delegate to the npm Stepper (extracting labels and
 *     computing the `current` index from `currentStep`).
 *   - Styled path: otherwise re-implement locally with the rich features.
 *
 * See scratch/MIGRATION.md for the full migration playbook.
 */
import React from 'react';
import { Box, Text } from '@nemesis-oss/termina-core';
import { Stepper as TerminaStepper } from '@nemesis-oss/termina-ui';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export interface Step {
  key: string;
  title: string;
  description?: string;
  optional?: boolean;
}

export interface StepperProps {
  steps: Step[];
  currentStep: string;
  orientation?: 'horizontal' | 'vertical';
  showNumbers?: boolean;
  completedSteps?: string[];
  errorSteps?: string[];
  theme?: InkUITheme;
}

export const Stepper: React.FC<StepperProps> = ({
  steps,
  currentStep,
  orientation = 'horizontal',
  showNumbers = false,
  completedSteps = [],
  errorSteps = [],
  theme = darkTheme,
}) => {
  // Fast path: simple vertical stepper with no rich features.
  const canDelegate =
    orientation === 'vertical' &&
    !showNumbers &&
    completedSteps.length === 0 &&
    errorSteps.length === 0 &&
    steps.every((s) => !s.description && !s.optional);

  if (canDelegate) {
    const labels = steps.map((s) => s.title);
    const currentIndex = Math.max(
      0,
      steps.findIndex((s) => s.key === currentStep),
    );
    return <TerminaStepper steps={labels} current={currentIndex} />;
  }

  // Styled path: re-implement locally for the rich case. Same code as
  // pre-migration; remains here as a compatibility shim.
  const getIndicator = (step: Step, _index: number) => {
    if (errorSteps.includes(step.key)) return { char: '✕', color: theme.colors.error };
    if (completedSteps.includes(step.key)) return { char: '✓', color: theme.colors.success };
    if (step.key === currentStep) return { char: '●', color: theme.colors.primary };
    return { char: '○', color: theme.colors.muted };
  };

  if (orientation === 'vertical') {
    return (
      <Box flexDirection="column">
        {steps.map((step, i) => {
          const { char, color } = getIndicator(step, i);
          const isCurrent = step.key === currentStep;
          const connector = completedSteps.includes(step.key) ? theme.colors.success : theme.colors.border;

          return (
            <Box key={step.key} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                {showNumbers && <Text color={theme.colors.muted}>{i + 1}.</Text>}
                <Text color={color}>{char}</Text>
                <Text bold={isCurrent} color={isCurrent ? theme.colors.text : theme.colors.muted}>
                  {step.title}
                  {step.optional && <Text color={theme.colors.muted}> (optional)</Text>}
                </Text>
              </Box>
              {step.description && (
                <Box marginLeft={2}>
                  <Text color={theme.colors.muted}>│ {step.description}</Text>
                </Box>
              )}
              {i < steps.length - 1 && (
                <Box marginLeft={2}>
                  <Text color={connector}>│</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    );
  }

  // Horizontal
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" alignItems="center">
        {steps.map((step, i) => {
          const { char, color } = getIndicator(step, i);
          const isCurrent = step.key === currentStep;
          const connectorColor = completedSteps.includes(step.key) ? theme.colors.success : theme.colors.border;

          return (
            <React.Fragment key={step.key}>
              {showNumbers && <Text color={theme.colors.muted}>{i + 1}.</Text>}
              <Text color={color}>{char}</Text>
              <Text color={isCurrent ? theme.colors.text : theme.colors.muted} bold={isCurrent}>
                {' '}{step.title}{step.optional ? ' (opt)' : ''}
              </Text>
              {i < steps.length - 1 && (
                <Text color={connectorColor}>{'  ──  '}</Text>
              )}
            </React.Fragment>
          );
        })}
      </Box>
      <Box flexDirection="row">
        {steps.map((step, i) => (
          <React.Fragment key={step.key}>
            {step.description && (
              <Text color={theme.colors.muted}>
                {'  '}{step.description}
                {i < steps.length - 1 ? '  ' : ''}
              </Text>
            )}
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
};
