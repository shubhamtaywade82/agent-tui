import React from 'react';
import { Box, Text } from 'ink';
import { Badge } from '../ui/badge';
import { ProgressBar } from '../ui/progress-bar';
import { StatusIndicator } from '../ui/status-indicator';
import { Gauge } from '../ui/gauge';
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
    if (client) {
      // Monitor memory usage
      const interval = setInterval(async () => {
        const ps = await client.ps();
        const totalMemory = ps.models.reduce((acc, model) => acc + model.size_vram, 0);
        setMemoryUsage(totalMemory / 1024 / 1024); // Convert to MB
      }, 5000);

      return () => clearInterval(interval);
    }
  }, [client]);

  return (
    <Box borderStyle="round" padding={1} marginY={1} theme={theme}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box>
          <Text bold color="cyan">
            Status:
          </Text>
          <StatusIndicator
            status={client ? 'connected' : 'disconnected'}
            label={client ? 'Connected' : 'Disconnected'}
            theme={theme}
          />
        </Box>

        <Box>
          <Text color="gray">
            Tokens: <Text color="white">{tokenCount}</Text>
          </Text>
        </Box>

        <Box>
          <Text color="gray">
            Memory: <Text color="white">{memoryUsage.toFixed(2)}MB</Text>
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <ProgressBar
          value={memoryUsage}
          max={4096} // 4GB max memory
          label="Memory Usage"
          color="blue"
          theme={theme}
        />
      </Box>

      <Box marginTop={1}>
        <Gauge
          value={quotaUsed}
          max={100}
          label="Quota Used"
          color="yellow"
          theme={theme}
        />
      </Box>
    </Box>
  );
};

export default StatusBar;