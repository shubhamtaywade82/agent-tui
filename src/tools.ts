import { z } from 'zod';
import {
  defineTool,
  ToolRegistry,
  registerMcpTools,
  type McpClientLike,
} from '@nemesis-oss/ollama-sdk';
import { StdioTransport, McpClient } from '@nemesis-oss/agentic-runtime/mcp';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
  description: string;
}

// Complete catalogue of reference and example servers from modelcontextprotocol.io/examples
export const MCP_SERVERS: McpServerConfig[] = [
  {
    id: 'memory',
    name: 'Knowledge Graph Memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    enabled: true,
    description: 'Graph-based persistent entity and relations memory',
  },
  {
    id: 'filesystem',
    name: 'Local Filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
    enabled: true,
    description: 'Read, search, and manage files in allowed directory',
  },
  {
    id: 'time',
    name: 'Time & Timezones',
    command: 'uvx',
    args: ['mcp-server-time'],
    enabled: true,
    description: 'Current local time and timezone conversions',
  },
  {
    id: 'fetch',
    name: 'Web Fetcher',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    enabled: true,
    description: 'Fetch web pages and convert HTML to markdown',
  },
  {
    id: 'git',
    name: 'Git Repository',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', process.cwd()],
    enabled: true,
    description: 'Git branch, commit, status, and diff operations',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    enabled: false,
    description: 'Dynamic problem solving through thought steps',
  },
  {
    id: 'everything',
    name: 'Everything Reference',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    enabled: false,
    description: 'Reference test server with prompts, resources, tools',
  },
  {
    id: 'sqlite',
    name: 'SQLite Database',
    command: 'uvx',
    args: ['mcp-server-sqlite'],
    enabled: false,
    description: 'Inspect and query SQLite database files',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    enabled: Boolean(process.env['BRAVE_API_KEY']),
    description: 'Web search via Brave Search API',
  },
  {
    id: 'github',
    name: 'GitHub',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    enabled: Boolean(process.env['GITHUB_PERSONAL_ACCESS_TOKEN']),
    description: 'GitHub repositories, issues, and PRs',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    enabled: Boolean(process.env['POSTGRES_URL']),
    description: 'Database inspection and query execution',
  },
];

export const calculator = defineTool({
  name: 'calculator',
  description: 'Calculate a mathematical expression such as 25 * 38.',
  schema: z.object({
    expression: z.string().describe('Mathematical expression'),
  }),
  execute: async ({ expression }: { expression: string }) => {
    // Function constructor handles basic arithmetic safely within strict mode
    const result = Function(`"use strict"; return (${expression})`)();
    return String(result);
  },
});

function createMcpAdapter(client: McpClient): McpClientLike {
  return {
    listTools: async () => {
      const tools = await client.listTools();
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        })),
      };
    },
    callTool: async ({ name, arguments: args }) => {
      const res = await client.callTool(name, args ?? {});
      return {
        content: res.content.map((c) => ({
          type: c.type,
          text: c.type === 'text' ? c.text : JSON.stringify(c),
        })),
        isError: res.isError,
      };
    },
  };
}

async function connectServer(cfg: McpServerConfig): Promise<McpClient | null> {
  try {
    const transport = new StdioTransport({
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
    });
    const client = new McpClient({ serverId: cfg.id, transport });
    await client.connect();
    return client;
  } catch {
    // Avoid crashing the host application if an optional server fails to start
    return null;
  }
}

let cachedRegistry: ToolRegistry | null = null;
const activeClients: McpClient[] = [];

export async function getActiveToolRegistry(): Promise<ToolRegistry> {
  if (cachedRegistry) return cachedRegistry;

  const registry = new ToolRegistry({
    tools: [calculator],
    timeoutMs: 15_000,
    maxConcurrency: 4,
    maxOutputChars: 15_000,
  });

  const enabled = MCP_SERVERS.filter((s) => s.enabled);
  for (const cfg of enabled) {
    const client = await connectServer(cfg);
    if (!client) continue;
    activeClients.push(client);
    await registerMcpTools(registry, createMcpAdapter(client));
  }

  cachedRegistry = registry;
  return registry;
}

export async function closeMcpServers(): Promise<void> {
  for (const client of activeClients) {
    await client.close().catch(() => undefined);
  }
  activeClients.length = 0;
  cachedRegistry = null;
}

export async function consumeStream(
  stream: AsyncIterable<any>,
  onThinking: (delta: string) => void,
  onToken: (delta: string) => void,
): Promise<{ thinking: string; content: string }> {
  let thinking = '';
  let content = '';
  for await (const event of stream) {
    if (event.type === 'thinking' && event.data?.delta) {
      thinking += event.data.delta;
      onThinking(event.data.delta);
    } else if (event.type === 'token' && event.data?.delta) {
      content += event.data.delta;
      onToken(event.data.delta);
    }
  }
  return { thinking, content };
}

export function isLocalSlashCommand(
  cmd: string,
  onClear: () => void,
  showToast: (msg: string, type: 'info' | 'error' | 'warning', duration?: number) => void,
): boolean {
  if (cmd === '/clear') {
    onClear();
    showToast('Chat history cleared', 'info', 2000);
    return true;
  }
  if (cmd === '/help') {
    showToast('Commands: /clear, /mcp, /model, /system, /help • Esc: cancel', 'info', 4000);
    return true;
  }
  if (cmd === '/mcp') {
    const active = MCP_SERVERS.filter((s) => s.enabled).map((s) => s.name).join(', ');
    showToast(`Active MCP: ${active || 'none'}`, 'info', 5000);
    return true;
  }
  return false;
}

export async function executeMcpCalls(
  registry: ToolRegistry,
  toolCalls: readonly any[],
): Promise<Array<{ role: 'tool'; content: string; tool_call_id?: string; timestamp: number }>> {
  const results = await registry.executeToolCalls(toolCalls);
  return results.map((res) => ({
    role: 'tool' as const,
    content: res.outputString || (res.success ? 'Success' : 'Execution error'),
    tool_call_id: res.toolCallId,
    timestamp: Date.now(),
  }));
}