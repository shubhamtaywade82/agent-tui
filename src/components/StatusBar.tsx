import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Badge } from '../components/ui/badge';
import { ProgressBar } from '../components/ui/progress-bar';
import { StatusIndicator } from '../components/ui/status-indicator';
import { Gauge } from '../components/ui/gauge';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

interface StatusBarProps {
  client: OllamaClient | null;
  tokenCount: number;
  theme?: any;
}

const StatusBar: React.FC<StatusBarProps> = ({ client, tokenCount, theme }) => {
  const [memoryUsage, setMemoryUsage] = useState(0);
  const [quotaUsed, setQuotaUsed] = useState(0);

  useEffect(() => {
    if (!client) return;

    const checkMetrics = async () => {
      try {
        const ps = await client.ps();
        const totalMemory = ps.models.reduce(
          (acc, model) => acc + (model.size_vram ?? 0),
          0,
        );
        setMemoryUsage(totalMemory / 1024 / 1024);
      } catch {
        // Suppress transient poll error when client is unready
      }
    };

    void checkMetrics();
    const interval = setInterval(checkMetrics, 5000);
    return () => clearInterval(interval);
  }, [client]);

  // Dynamically scale max VRAM label to 8GB if usage exceeds 4GB
  const maxVramGB = memoryUsage > 4096 ? 8 : 4;
  const vramPercent = Math.min(100, (memoryUsage / (maxVramGB * 1024)) * 100);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme?.colors?.border ?? 'gray'}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
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
            VRAM: <Text color="white" bold>{memoryUsage.toFixed(1)} MB</Text>
          </Text>
        </Box>
      </Box>

      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <ProgressBar
          value={vramPercent}
          label={`VRAM (${maxVramGB}GB):`}
          width={20}
          theme={theme}
        />
        <Gauge
          value={quotaUsed}
          max={100}
          label="Quota:"
          width={12}
          theme={theme}
        />
      </Box>
    </Box>
  );
};

export default StatusBar;