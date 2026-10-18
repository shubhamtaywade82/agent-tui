import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from '@nemesis-oss/termina-core';
import {
  createGenUIRuntime,
  GenUIRenderer,
} from '@nemesis-oss/termina-genui';
import {
  genUiRegistry,
  genUiAdapter,
  createUniversalActionDispatcher,
} from '../toolbox/genui.js';

interface GenUIPanelProps {
  width: number;
  height: number;
  theme?: any;
  isActive?: boolean;
}

const SCENARIOS = [
  {
    id: 'dashboard',
    title: 'Observatory Dashboard',
    code: [
      'root = Container("column", 1, "round", [header, status, gauge, spark, tok])',
      'header = Text("⚡ AGENT SYSTEM OBSERVATORY", "cyan", true, false)',
      'status = StatusMessage("All model routers and MCP tool workers active", "success")',
      'gauge = Gauge(82, "Context Window Utilization", 24)',
      'spark = Sparkline([14, 22, 35, 48, 62, 58, 70, 82])',
      'tok = TokenCounter(6560, 8192, "tokens")',
    ].join('\n'),
  },
  {
    id: 'form',
    title: 'Cluster Config',
    code: [
      'root = Container("column", 1, "round", [title, info, cluster, region, confirm])',
      'title = Text("Target Service Configuration", "yellow", true, false)',
      'info = Alert("Environment Setup", "Select runtime cluster and region below", "info")',
      'cluster = Select("cluster", "Target Cluster", ["production-k8s", "staging-cluster", "dev-sandbox"])',
      'region = Select("region", "Cloud Region", ["us-east-1", "eu-central-1", "ap-south-1"])',
      'confirm = Confirm("Apply Deployment", "deployApp", "cancelDeploy")',
    ].join('\n'),
  },
  {
    id: 'diff',
    title: 'Patch Review',
    code: [
      'root = Container("column", 1, "round", [header, diff, confirm])',
      'header = Text("Tool Output Patch Review", "magenta", true, false)',
      'diff = DiffView("--- a/config.json\\n+++ b/config.json\\n@@ -1,3 +1,3 @@\\n-  \\"mode\\": \\"sandbox\\"\\n+  \\"mode\\": \\"production\\"")',
      'confirm = Confirm("Approve Patch", "approvePatch", "rejectPatch")',
    ].join('\n'),
  },
];

export const GenUIPanel: React.FC<GenUIPanelProps> = ({ width, height, isActive = true }) => {
  const [activeIdx, setActiveIdx] = useState(0);
  const [showCode, setShowCode] = useState(false);
  const [actionLog, setActionLog] = useState('');

  const runtime = useMemo(() => createGenUIRuntime(), []);
  const dispatcher = useMemo(() => {
    return createUniversalActionDispatcher((act, vals) => {
      setActionLog(`${act} -> ${JSON.stringify(vals)}`);
    });
  }, []);

  const current = SCENARIOS[activeIdx] ?? SCENARIOS[0]!;
  const parsed = useMemo(() => genUiAdapter.parse(current.code), [current.code]);

  useInput((input, key) => {
    if (!isActive) return;
    if (input === '1') setActiveIdx(0);
    else if (input === '2') setActiveIdx(1);
    else if (input === '3') setActiveIdx(2);
    else if (key.rightArrow || input === 'n' || key.tab) setActiveIdx((p) => (p + 1) % SCENARIOS.length);
    else if (key.leftArrow || input === 'p') setActiveIdx((p) => (p <= 0 ? SCENARIOS.length - 1 : p - 1));
    else if (input === 'v' || input === 'c') setShowCode((p) => !p);
  });

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      {/* Top selector */}
      <Box flexDirection="row" justifyContent="space-between" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold color="cyan">🎨 Termina GenUI</Text>
          {SCENARIOS.map((s, i) => (
            <Box key={s.id} onClick={() => setActiveIdx(i)}>
              <Text bold={i === activeIdx} color={i === activeIdx ? 'green' : 'gray'}>
                [{i + 1}] {s.title}
              </Text>
            </Box>
          ))}
        </Box>
        <Box onClick={() => setShowCode((p) => !p)}>
          <Text color="gray" dimColor>[Tab/1-3 Switch • V Toggle Code]</Text>
        </Box>
      </Box>

      {/* Main content body */}
      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {showCode ? (
          <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
            <Text bold color="yellow">openui-lang Source ({current.title}):</Text>
            {current.code.split('\n').map((line, li) => (
              <Text key={li} color="white">{line}</Text>
            ))}
          </Box>
        ) : (
          <Box flexDirection="column">
            {parsed.root ? (
              <GenUIRenderer
                node={parsed.root}
                registry={genUiRegistry}
                runtime={runtime}
                actionDispatcher={dispatcher}
              />
            ) : (
              <Text color="red">Failed to render GenUI element tree</Text>
            )}
          </Box>
        )}
      </Box>

      {/* Action status notification */}
      {actionLog ? (
        <Box borderStyle="single" borderColor="green" paddingX={1} marginTop={1}>
          <Text color="green" bold>Action Event: </Text>
          <Text color="white">{actionLog}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

export default GenUIPanel;
