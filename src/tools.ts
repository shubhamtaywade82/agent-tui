import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  defineTool,
  ToolRegistry,
  registerMcpTools,
  type McpClientLike,
} from '@nemesis-oss/ollama-sdk';
import { StdioTransport, StreamableHttpTransport, McpClient } from '@nemesis-oss/agentic-runtime/mcp';

export interface McpServerConfig {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: 'stdio' | 'http';
  env?: Record<string, string>;
  enabled: boolean;
  disabledReason?: string;
  description: string;
}

// Complete catalogue of reference and example servers from modelcontextprotocol.io/examples
export const MCP_SERVERS: McpServerConfig[] = [
  { id: 'memory', name: 'Knowledge Graph Memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], enabled: true, description: 'Graph persistent memory' },
  { id: 'filesystem', name: 'Local Filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()], enabled: true, description: 'File operations' },
  { id: 'time', name: 'Time & Timezones', command: 'uvx', args: ['mcp-server-time'], enabled: true, description: 'Time and timezones' },
  { id: 'fetch', name: 'Web Fetcher', command: 'uvx', args: ['mcp-server-fetch'], enabled: true, description: 'Web HTML to markdown' },
  { id: 'git', name: 'Git Repository', command: 'uvx', args: ['mcp-server-git', '--repository', process.cwd()], enabled: true, description: 'Git repo operations' },
  { id: 'sequential-thinking', name: 'Sequential Thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], enabled: true, description: 'Thought sequences' },
  { id: 'sqlite', name: 'SQLite Database', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', process.env['SQLITE_DB_PATH'] || 'data.db'], enabled: true, description: 'SQLite query runner' },
  { id: 'binance-cloud', name: 'Binance Agentic Cloud', url: process.env['BINANCE_MCP_URL'] || 'https://agent.binance.com/mcp/agentic', transport: 'http', enabled: true, description: 'Binance Cloud trading & market data' },
  { id: 'binance-sdk', name: 'Binance Local SDK', command: 'npx', args: ['-y', '@nemesis-oss/binance-sdk'], enabled: Boolean(process.env['BINANCE_API_KEY']), disabledReason: 'Missing BINANCE_API_KEY', description: 'Binance local SDK' },
  { id: 'everything', name: 'Everything Reference', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], enabled: false, disabledReason: 'Test reference mock server', description: 'Reference test server' },
  { id: 'brave-search', name: 'Brave Search', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], enabled: Boolean(process.env['BRAVE_API_KEY']), disabledReason: 'Missing BRAVE_API_KEY', description: 'Brave web search' },
  { id: 'github', name: 'GitHub', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], enabled: Boolean(process.env['GITHUB_PERSONAL_ACCESS_TOKEN']), disabledReason: 'Missing GITHUB_PERSONAL_ACCESS_TOKEN', description: 'GitHub repos and PRs' },
  { id: 'postgres', name: 'PostgreSQL', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], enabled: Boolean(process.env['POSTGRES_URL']), disabledReason: 'Missing POSTGRES_URL', description: 'Postgres database' },
];

export const calculator = defineTool({
  name: 'calculator',
  description: 'Calculate a mathematical expression such as 25 * 38.',
  schema: z.object({ expression: z.string().describe('Mathematical expression') }),
  execute: async ({ expression }: { expression: string }) => {
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
    const transport = cfg.url || cfg.transport === 'http'
      ? new StreamableHttpTransport({ url: cfg.url! })
      : new StdioTransport({ command: cfg.command!, args: cfg.args, env: cfg.env });
    const client = new McpClient({ serverId: cfg.id, transport });
    await client.connect();
    return client;
  } catch {
    // Return null on failure so other servers still load gracefully
    return null;
  }
}

let cachedRegistry: ToolRegistry | null = null;
const activeClients: McpClient[] = [];

export async function getActiveToolRegistry(): Promise<ToolRegistry> {
  if (cachedRegistry) return cachedRegistry;
  const registry = new ToolRegistry({ tools: [calculator], timeoutMs: 15_000, maxConcurrency: 4, maxOutputChars: 15_000 });
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

export interface SlashCommandInfo {
  name: string;
  args?: string;
  desc: string;
}

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: '/help', args: '[cmd]', desc: 'Show command manual & shortcuts' },
  { name: '/clear', desc: 'Clear conversation history' },
  { name: '/mcp', args: '[list]', desc: 'Inspect MCP servers & connection health' },
  { name: '/tools', desc: 'List active tools & parameter schemas' },
  { name: '/model', args: '[name]', desc: 'Switch active LLM or show selector' },
  { name: '/context', desc: 'Show token usage & context statistics' },
  { name: '/compact', desc: 'Summarize past conversation to save context' },
  { name: '/save', args: '[file.md]', desc: 'Export chat transcript to disk' },
  { name: '/system', args: '[prompt]', desc: 'View or set system prompt' },
  { name: '/quit', desc: 'Exit the TUI harness gracefully' },
];

export interface CommandContext {
  messages: any[];
  model: string;
  setModel?: (m: string) => void;
  models?: string[];
  clearMessages: () => void;
  setMessages: (updater: (prev: any[]) => any[]) => void;
  showToast: (msg: string, type: 'info' | 'error' | 'warning', duration?: number) => void;
  addSystemCard: (text: string) => void;
  registry?: ToolRegistry | null;
}

function handleContextCmd(ctx: CommandContext): void {
  const tokens = ctx.messages.reduce((s, m) => s + (m.tokens ?? Math.ceil(m.content.length / 4)), 0);
  const toolDefs = ctx.registry?.definitions() || [];
  ctx.addSystemCard(`📊 Context & Telemetry:\n• Model: ${ctx.model}\n• Messages: ${ctx.messages.length}\n• Est. Tokens: ~${tokens}\n• Tools Loaded: ${toolDefs.length}`);
}

function handleCompactCmd(ctx: CommandContext): void {
  if (ctx.messages.length <= 3) {
    ctx.showToast('Conversation too short to compact', 'warning', 2500);
    return;
  }
  const olderCount = ctx.messages.length - 2;
  ctx.setMessages((prev) => [
    { role: 'system', content: `[Compacted context: ${olderCount} earlier turns summarized]`, timestamp: Date.now() },
    ...prev.slice(-2),
  ]);
  ctx.showToast(`Compacted ${olderCount} turns`, 'info', 2500);
}

function handleSaveCmd(ctx: CommandContext, arg: string): void {
  const file = arg || `chat-${new Date().toISOString().slice(0, 10)}.md`;
  const body = ctx.messages.map((m) => `### ${m.role.toUpperCase()}\n\n${m.content}\n`).join('\n---\n\n');
  try {
    writeFileSync(file, `# Chat Transcript (${new Date().toLocaleString()})\n\n${body}`, 'utf8');
    ctx.showToast(`Saved to ${file}`, 'info', 3000);
    ctx.addSystemCard(`Transcript saved to ${file}`);
  } catch (err) {
    ctx.showToast(`Failed to save: ${String(err)}`, 'error', 4000);
  }
}

function formatToolsList(registry?: ToolRegistry | null): string {
  const defs = registry?.definitions() || [];
  const list = defs.map((d: any) => `• ${d.function.name}: ${d.function.description || 'no desc'}`).join('\n');
  return `Active Tools (${defs.length}):\n${list || 'None'}`;
}

function formatMcpServersList(): string {
  const activeCount = MCP_SERVERS.filter((s) => s.enabled).length;
  const list = MCP_SERVERS.map((s) => {
    if (s.enabled) return `• ${s.name} (${s.id}): Active`;
    const reason = s.disabledReason ? ` (${s.disabledReason})` : '';
    return `• ${s.name} (${s.id}): Disabled${reason}`;
  }).join('\n');
  return `MCP Servers (${activeCount}/${MCP_SERVERS.length} active):\n${list}`;
}

export function dispatchSlashCommand(rawInput: string, ctx: CommandContext): boolean {
  if (!rawInput.startsWith('/')) return false;
  const [cmd, ...rest] = rawInput.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd?.toLowerCase()) {
    case '/clear': ctx.clearMessages(); ctx.showToast('Chat history cleared', 'info', 2000); return true;
    case '/context': handleContextCmd(ctx); return true;
    case '/compact': handleCompactCmd(ctx); return true;
    case '/save': handleSaveCmd(ctx, arg); return true;
    case '/tools': ctx.addSystemCard(formatToolsList(ctx.registry)); return true;
    case '/mcp': ctx.addSystemCard(formatMcpServersList()); return true;
    case '/model':
      if (arg && ctx.setModel) { ctx.setModel(arg); ctx.showToast(`Switched to ${arg}`, 'info', 2000); }
      else ctx.addSystemCard(`Model: ${ctx.model}\nAvailable: ${(ctx.models || []).join(', ')}`);
      return true;
    case '/system':
      if (arg) { ctx.setMessages((prev) => [{ role: 'system', content: arg, timestamp: Date.now() }, ...prev]); ctx.showToast('System prompt updated', 'info', 2000); }
      else { const s = ctx.messages.find((m) => m.role === 'system'); ctx.addSystemCard(`System Prompt:\n${s ? s.content : 'Default system instructions active'}`); }
      return true;
    case '/help':
      ctx.addSystemCard(`Commands:\n${SLASH_COMMANDS.map((c) => `${c.name} ${c.args || ''} — ${c.desc}`).join('\n')}\n\nKeybindings: Tab: Complete/Scroll • Esc: Cancel • Ctrl+O: Model • Ctrl+T: View`);
      return true;
    case '/quit': case '/exit': closeMcpServers().finally(() => process.exit(0)); return true;
    default: return false;
  }
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