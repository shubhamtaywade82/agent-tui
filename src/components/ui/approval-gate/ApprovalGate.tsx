import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalScope = 'once' | 'session' | 'always';
export type ApprovalState = 'pending' | 'approved' | 'denied';

export interface ApprovalGateProps {
  actionTitle: string;
  commandOrDiff: string;
  riskLevel?: ApprovalRiskLevel;
  description?: string;
  onApprove?: (scope: ApprovalScope) => void;
  onDeny?: (reason?: string) => void;
  interactive?: boolean;
  theme?: InkUITheme;
}

function getRiskColor(level: ApprovalRiskLevel, theme: InkUITheme): string {
  switch (level) {
    case 'low':      return theme.colors.info;
    case 'medium':   return theme.colors.warning;
    case 'high':
    case 'critical': return theme.colors.error;
  }
}

function RiskBadge({ level, theme }: { level: ApprovalRiskLevel; theme: InkUITheme }) {
  const color = getRiskColor(level, theme);
  const label = level === 'critical' ? '⚠ CRITICAL' : `${level.toUpperCase()} RISK`;
  return <Text color={color} bold>[{label}]</Text>;
}

function ActionFooter({ state, selectedScope, theme }: { state: ApprovalState; selectedScope?: ApprovalScope; theme: InkUITheme }) {
  if (state === 'approved') {
    return <Text color={theme.colors.success} bold>✔ Approved ({selectedScope ?? 'once'})</Text>;
  }
  if (state === 'denied') {
    return <Text color={theme.colors.error} bold>✖ Denied by user</Text>;
  }
  return (
    <Box gap={2}>
      <Text color={theme.colors.success} bold>[y] Approve once</Text>
      <Text color={theme.colors.info} bold>[a] Always allow</Text>
      <Text color={theme.colors.error} bold>[n] Deny</Text>
    </Box>
  );
}

export function ApprovalGate({
  actionTitle,
  commandOrDiff,
  riskLevel = 'medium',
  description,
  onApprove,
  onDeny,
  interactive = true,
  theme = darkTheme,
}: ApprovalGateProps) {
  const [state, setState] = useState<ApprovalState>('pending');
  const [scope, setScope] = useState<ApprovalScope | undefined>(undefined);

  useInput((input, key) => {
    if (!interactive || state !== 'pending') return;
    const char = input.toLowerCase();
    if (char === 'y' || key.return) {
      setState('approved'); setScope('once'); onApprove?.('once');
    } else if (char === 'a') {
      setState('approved'); setScope('always'); onApprove?.('always');
    } else if (char === 'n' || key.escape) {
      setState('denied'); onDeny?.('User rejected execution');
    }
  });

  return (
    <Box flexDirection="column" gap={0}>
      <Box flexDirection="row" gap={1}>
        <RiskBadge level={riskLevel} theme={theme} />
        <Text bold color={theme.colors.text}>{actionTitle}</Text>
      </Box>
      {description ? (
        <Box paddingLeft={1}><Text color={theme.colors.muted}>{description}</Text></Box>
      ) : null}
      <Box borderStyle="round" borderColor={getRiskColor(riskLevel, theme)} paddingX={1}>
        <Text color={theme.colors.text}>{commandOrDiff}</Text>
      </Box>
      <ActionFooter state={state} selectedScope={scope} theme={theme} />
    </Box>
  );
}
