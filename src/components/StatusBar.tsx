import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ProgressBar } from './ui/progress-bar/index.js';
import { StatusIndicator } from './ui/status-indicator/index.js';
import { Gauge } from './ui/gauge/index.js';
import { Divider } from './ui/divider/index.js';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

interface LoadedModelInfo {
  name: string;
  sizeVramMB: number;
}

interface StatusBarProps {
  client: OllamaClient | null;
  tokenCount: number;
  theme?: any;
  width?: number;
}

const StatusBar: React.FC<StatusBarProps> = ({ client, tokenCount, theme, width }) => {
  const [memoryUsage, setMemoryUsage] = useState(0);
  const [quotaUsed] = useState(0);
  const [loadedModels, setLoadedModels] = useState<LoadedModelInfo[]>([]);

  useEffect(() => {
    if (!client) return;

    const checkMetrics = async () => {
      try {
        const ps = await client.ps();
        const models = (ps.models ?? []).map((m) => ({
          name: m.name ?? m.model ?? 'unknown',
          sizeVramMB: (m.size_vram ?? 0) / 1024 / 1024,
        }));
        setLoadedModels(models);
        const totalMemory = models.reduce((acc, m) => acc + m.sizeVramMB, 0);
        setMemoryUsage(totalMemory);
      } catch {
        // Suppress transient poll error when client is unready
      }
    };

    void checkMetrics();
    const interval = setInterval(checkMetrics, 5000);
    return () => clearInterval(interval);
  }, [client]);

  const maxVramGB = memoryUsage > 4096 ? 8 : 4;
  const vramPercent = Math.min(100, (memoryUsage / (maxVramGB * 1024)) * 100);

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text bold color={theme?.colors?.primary ?? 'cyan'}>
            Ollama Node:
          </Text>
          <StatusIndicator
            status={client ? 'online' : 'offline'}
            label={client ? 'Connected' : 'Disconnected'}
            theme={theme}
          />
        </Box>

        <Box>
          <Text color="gray">
            Tokens Processed: <Text color="white" bold>{tokenCount}</Text>
          </Text>
        </Box>

        <Box>
          <Text color="gray">
            Total VRAM: <Text color="white" bold>{memoryUsage.toFixed(1)} MB</Text>
          </Text>
        </Box>
      </Box>

      <Divider width={width} theme={theme} />

      <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1}>
        <ProgressBar
          value={vramPercent}
          label={`VRAM (${maxVramGB}GB):`}
          width={24}
          theme={theme}
        />
        <Gauge
          value={quotaUsed}
          max={100}
          label="Quota:"
          width={14}
          theme={theme}
        />
      </Box>

      <Divider title="Loaded Models in VRAM" width={width} theme={theme} />

      <Box flexDirection="column" paddingX={1}>
        {loadedModels.length === 0 ? (
          <Text color="gray" dimColor>  No models currently resident in VRAM.</Text>
        ) : (
          loadedModels.map((m, idx) => (
            <Box key={idx} flexDirection="row" justifyContent="space-between">
              <Text color="white">• {m.name}</Text>
              <Text color="cyan">{m.sizeVramMB.toFixed(1)} MB</Text>
            </Box>
          ))
        )}
      </Box>

      <Divider width={width} theme={theme} />

      <Box paddingX={1}>
        <Text color="gray" dimColor>
          Navigation: [Ctrl+T], [Esc], or [1] to return to Chat
        </Text>
      </Box>
    </Box>
  );
};

export default StatusBar;