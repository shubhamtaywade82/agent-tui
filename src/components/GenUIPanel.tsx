import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from '@nemesis-oss/termina-core';
import {
  createDefaultRegistry,
  createLanguageAdapter,
  createGenUIRuntime,
  createActionDispatcher,
  GenUIRenderer,
} from '@nemesis-oss/termina-genui';
import { z } from 'zod';

interface GenUIPanelProps {
  width: number;
  height: number;
  theme?: any;
  isActive?: boolean;
}

const SCENARIOS = [
  {
    id: 'dashboard',
    title: 'System Dashboard',
    code: [
      'root = Container("column", 1, "round", [header, status, bar, tbl])',
      'header = Text("⚡ AGENT SYSTEM MONITOR", "cyan", true, false)',
      'status = StatusMessage("All background workers and vector stores online", "success")',
      'bar = ProgressBar(88, "Cluster Memory Utilization")',
      'tbl = Table(["Component", "Status", "Latency"], [{"Component": "Ollama Local", "Status": "Ready", "Latency": "12ms"}, {"Component": "MCP Servers (8)", "Status": "Active", "Latency": "4ms"}, {"Component": "Supervisor Runtime", "Status": "Healthy", "Latency": "1ms"}])',
    ].join('\n'),
  },
  {
    id: 'form',
    title: 'Interactive Form',
    code: [
      'root = Container("column", 1, "round", [title, info, cluster, region, btn])',
      'title = Text("Target Service Configuration", "yellow", true, false)',
      'info = Alert("Environment Setup", "Select runtime cluster and region below", "info")',
      'cluster = Select("cluster", "Target Cluster", ["production-k8s", "staging-cluster", "dev-sandbox"])',
      'region = Select("region", "Cloud Region", ["us-east-1", "eu-central-1", "ap-south-1"])',
      'btn = Button("Apply Configuration", "applyConfig")',
    ].join('\n'),
  },
  {
    id: 'pipeline',
    title: 'Reasoning Pipeline',
    code: [
      'root = Container("column", 1, "round", [header, alert, load, bar])',
      'header = Text("Agent Reasoning Pipeline", "green", true, false)',
      'alert = Alert("Active Task Execution", "Step 3/5: Running code sandbox test suite", "info")',
      'load = LoadingBar("Compiling AST tree...")',
      'bar = ProgressBar(60, "Execution Progress")',
    ].join('\n'),
  },
];

export const GenUIPanel: React.FC<GenUIPanelProps> = ({ width, height, isActive = true }) => {
  const [activeIdx, setActiveIdx] = useState(0);
  const [showCode, setShowCode] = useState(false);
  const [actionLog, setActionLog] = useState('');

  const registry = useMemo(() => createDefaultRegistry(), []);
  const adapter = useMemo(() => createLanguageAdapter(registry), [registry]);
  const runtime = useMemo(() => createGenUIRuntime(), []);

  const dispatcher = useMemo(() => {
    return createActionDispatcher([
      {
        name: 'applyConfig',
        schema: z.any() as any,
        handler: () => {
          const vals = runtime.getValues();
          const target = vals['cluster'] || 'production-k8s';
          const reg = vals['region'] || 'us-east-1';
          setActionLog(`Applied configuration to ${target} (${reg})`);
        },
      },
    ]);
  }, [runtime]);

  const current = SCENARIOS[activeIdx] ?? SCENARIOS[0]!;
  const parsed = useMemo(() => adapter.parse(current.code), [adapter, current.code]);

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
            <Text key={s.id} bold={i === activeIdx} color={i === activeIdx ? 'green' : 'gray'}>
              [{i + 1}] {s.title}
            </Text>
          ))}
        </Box>
        <Text color="gray" dimColor>[Tab/1-3 Switch • V Toggle Code]</Text>
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
                registry={registry}
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
