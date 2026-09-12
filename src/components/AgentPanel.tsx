import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { Agent, defineTool, ToolRegistry, OllamaClient, type AgentTurn } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';
import { Badge } from '../components/ui/badge';
import { Select } from '../components/ui/select';
import { Table } from '../components/ui/table';
import { Spinner } from '../components/ui/spinner';

// Define tools for the agent
const webSearchTool = defineTool({
  name: 'web_search',
  description: 'Search the web for information',
  schema: z.object({
    query: z.string(),
    max_results: z.number().optional()
  }),
  execute: async ({ query, max_results = 5 }) => {
    // Implementation for web search
    return {
      query,
      results: [
        { title: 'Result 1', url: 'https://example.com', content: '...' },
        { title: 'Result 2', url: 'https://example.com', content: '...' }
      ]
    };
  }
});

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  schema: z.object({
    city: z.string()
  }),
  execute: async ({ city }) => {
    // Implementation for weather tool
    return {
      city,
      temperature: '22°C',
      condition: 'Sunny'
    };
  }
});

const AgentPanel: React.FC<{ client: OllamaClient | null }> = ({ client }) => {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<readonly AgentTurn[]>([]);

  // Create tool registry
  const toolRegistry = new ToolRegistry({
    tools: [webSearchTool, weatherTool],
    timeoutMs: 10000,
    maxConcurrency: 4,
    maxOutputChars: 20000
  });

  // Create agent with tools
  const agent = client
    ? new Agent(client, {
        tools: toolRegistry,
        maxIterations: 5
      })
    : null;

  const runAgent = async (prompt: string) => {
    if (!client || !agent) return;

    setIsRunning(true);
    try {
      const response = await agent.run({
        model: 'qwen3:8b',
        messages: [{ role: 'user', content: prompt }]
      });

      setResults(response.turns);
    } catch (error) {
      console.error('Agent error:', error);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold color="magenta">AI Agent Panel</Text>

      {/* Tool Selection */}
      <Box flexDirection="column" marginY={1}>
        <Text color="cyan">Select Tool:</Text>
        <Select
          items={[
            { label: 'Web Search', value: 'web_search' },
            { label: 'Weather', value: 'get_weather' }
          ]}
          onSelect={tool => console.log('Selected tool:', tool.value)}
        />
      </Box>

      {/* Results Display */}
      {isRunning ? (
        <Spinner type="dots" label="Agent is thinking..." />
      ) : (
        <Table
          data={results.map((result, index) => ({
            index,
            tool: result.toolCalls?.[0]?.function?.name || 'unknown',
            status: result.toolResults?.[0]?.success ? 'success' : 'error',
            timestamp: new Date().toLocaleTimeString()
          }))}
          columns={[
            { key: 'tool', header: 'Tool', width: 20 },
            { key: 'status', header: 'Status', width: 15 },
            { key: 'timestamp', header: 'Time', width: 15 }
          ]}
        />
      )}
    </Box>
  );
};

export default AgentPanel;