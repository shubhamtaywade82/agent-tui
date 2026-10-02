import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { z } from 'zod';
import { defineTool, ToolRegistry, registerMcpTools, type McpClientLike } from '@nemesis-oss/ollama-sdk';
import { truncateToolOutput } from './utils/context.js';
import { StdioTransport, StreamableHttpTransport, McpClient } from '@nemesis-oss/agentic-runtime/mcp';
import { TASK_SLASH_COMMANDS, handleTasksCommand } from './tasks.js';
import { envList } from './config.js';

export interface McpServerConfig {
  id: string; name: string; command?: string; args?: string[]; url?: string;
  transport?: 'stdio' | 'http'; env?: Record<string, string>; enabled: boolean;
  disabledReason?: string; description: string;
}

export const MCP_SERVERS: McpServerConfig[] = [
  { id: 'memory', name: 'Knowledge Graph Memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], enabled: true, description: 'Graph persistent memory' },
  { id: 'filesystem', name: 'Local Filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd(), ...envList('AGENT_FS_EXTRA_DIRS', [])], enabled: true, description: 'File operations' },
  { id: 'time', name: 'Time & Timezones', command: 'uvx', args: ['mcp-server-time'], enabled: true, description: 'Time and timezones' },
  { id: 'fetch', name: 'Web Fetcher', command: 'uvx', args: ['mcp-server-fetch'], enabled: true, description: 'Web HTML to markdown' },
  { id: 'git', name: 'Git Repository', command: 'uvx', args: ['mcp-server-git', '--repository', process.cwd()], enabled: true, description: 'Git repo operations' },
  { id: 'sequential-thinking', name: 'Sequential Thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], enabled: true, description: 'Thought sequences' },
  { id: 'binance-sdk', name: 'Binance Local SDK', command: 'node', args: ['./node_modules/@nemesis-oss/binance-sdk/dist/mcp/index.js'], enabled: true, description: 'Binance Spot, Futures, Margin SDK' },
  { id: 'binance-cloud', name: 'Binance Agentic Cloud', url: process.env['BINANCE_MCP_URL'] || 'https://agent.binance.com/mcp/agentic', transport: 'http', enabled: Boolean(process.env['BINANCE_OAUTH_TOKEN']), disabledReason: 'Requires OAuth token in BINANCE_OAUTH_TOKEN', description: 'Binance Cloud trading & market data' },
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

/** Resolve the list of skill-pack directories.
 *  Priority: SKILLS_PATH env (colon-separated) → all packs under .agent/skills/ → legacy fallback.
 */
function resolveSkillsDirs(): string[] {
  const dirs: string[] = [];
  const env = process.env['SKILLS_PATH'];
  if (env) {
    for (const p of env.split(':').map((s) => s.trim()).filter(Boolean)) {
      if (existsSync(p)) dirs.push(p);
    }
  }
  // Auto-discover all packs under .agent/skills/
  const bundledRoot = resolve(process.cwd(), '.agent/skills');
  if (existsSync(bundledRoot)) {
    try {
      for (const entry of readdirSync(bundledRoot)) {
        const p = resolve(bundledRoot, entry);
        if (existsSync(resolve(p, 'skill-manifest.yml'))) dirs.push(p);
      }
    } catch {}
  }
  // Legacy fallback path
  if (!dirs.length) {
    const legacy = `${process.env['HOME']}/projects/agent-skills/ruby-agent-skills`;
    dirs.push(env || legacy);
  }
  return dirs;
}

export const SKILLS_DIRS = resolveSkillsDirs();
/** Back-compat: first pack (or legacy path) — used by older callers. */
export const SKILLS_DIR = SKILLS_DIRS[0] ?? '';

export function loadAvailableSkills(): Array<{ name: string; family: string; path: string; triggers: string; pack: string }> {
  const skills: Array<{ name: string; family: string; path: string; triggers: string; pack: string }> = [];
  for (const dir of SKILLS_DIRS) {
    const manifest = resolve(dir, 'skill-manifest.yml');
    if (!existsSync(manifest)) continue;
    try {
      const raw = readFileSync(manifest, 'utf8');
      const pack = basename(dir);
      // Format 1 (ruby): "  skill-name:\n    family: X\n    path: Y\n    triggers: [Z]"
      const re1 = /^\s{2}([a-z0-9\-]+):\s*\n\s+family:\s*([^\n]+)\n\s+path:\s*([^\n]+)\n(?:\s+triggers:\s*\[([^\]]*)\])?/gm;
      let m: RegExpExecArray | null;
      while ((m = re1.exec(raw)) !== null) {
        skills.push({ name: m[1]!, family: m[2]!.trim(), path: m[3]!.trim(), triggers: m[4]?.trim() || '', pack });
      }
      if (skills.some((s) => s.pack === pack)) continue; // format 1 matched, skip other formats
      // Format 2 (react/node): "  - name: X\n    path: Y\n    triggers: [Z]" or "    category: C"
      const re2 = /^\s*-\s+name:\s*([a-z0-9\-]+)\s*\n(?:\s+(?:path|category|family):\s*([^\n]+)\s*\n)?(?:\s+(?:path|triggers):\s*([^\n]+)\s*\n)?(?:\s+triggers:\s*\[([^\]]*)\])?/gm;
      while ((m = re2.exec(raw)) !== null) {
        const name = m[1]!;
        const fam = (m[2] || m[3] || '').trim();
        const triggers = m[4]?.trim() || '';
        if (!skills.some((s) => s.pack === pack && s.name === name)) {
          skills.push({ name, family: fam || 'general', path: `skills/${name}/SKILL.md`, triggers, pack });
        }
      }
    } catch {}
  }
  return skills;
}

/** Locate a skill's SKILL.md file across all packs. Returns the path or empty string. */
export function findSkillFile(name: string): string {
  for (const dir of SKILLS_DIRS) {
    const file = resolve(dir, 'skills', name, 'SKILL.md');
    if (existsSync(file)) return file;
  }
  return '';
}

export interface UserConfig { model?: string; systemPrompt?: string; inputStyle?: 'box' | 'line'; }
const CONFIG_FILE = '.config.json';
export const loadUserConfig = (): UserConfig => {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
};
export const saveUserConfig = (patch: Partial<UserConfig>): void => {
  try { writeFileSync(CONFIG_FILE, JSON.stringify({ ...loadUserConfig(), ...patch }, null, 2), 'utf8'); } catch {}
};

// ponytail: weak models re-query list_skills/read_skill endlessly instead of proceeding;
// hard-cap the lookup budget per process rather than relying on prompt wording.
const SKILL_LOOKUP_BUDGET = 2;
let skillLookupCalls = 0;
export function resetSkillLookupBudget(): void { skillLookupCalls = 0; }
const SKILL_BUDGET_EXHAUSTED = 'Skill lookup budget exhausted. Stop calling list_skills/read_skill — proceed with the task now using your own knowledge.';

export const listSkillsTool = defineTool({
  name: 'list_skills',
  description: 'List available engineering skills from ruby-agent-skills pack (Ruby, Rails, OOP, Clean Code). Call at most once per task.',
  schema: z.object({ query: z.string().optional().describe('Keyword or topic to filter skills') }),
  execute: async ({ query }: { query?: string }) => {
    if (skillLookupCalls++ >= SKILL_LOOKUP_BUDGET) return SKILL_BUDGET_EXHAUSTED;
    const skills = loadAvailableSkills();
    const q = query?.toLowerCase();
    const list = q ? skills.filter((s) => s.name.includes(q) || s.family.includes(q) || s.triggers.toLowerCase().includes(q)) : skills;
    if (!list.length) return `No skills matched "${query}". Available count: ${skills.length}`;
    return list.slice(0, 25).map((s) => `• ${s.name} (${s.family}): ${s.triggers || 'standard'}`).join('\n');
  },
});

export const readSkillTool = defineTool({
  name: 'read_skill',
  description: 'Read the full guidelines and rules from a specific engineering skill (e.g. "ruby-oop"). Call at most once per task.',
  schema: z.object({ name: z.string().describe('Skill name (e.g. ruby-oop, ruby-clean-code)') }),
  execute: async ({ name }: { name: string }) => {
    if (skillLookupCalls++ >= SKILL_LOOKUP_BUDGET) return SKILL_BUDGET_EXHAUSTED;
    const file = findSkillFile(name);
    if (!file) return `Skill "${name}" not found in any pack. Use list_skills to find valid names.`;
    return readFileSync(file, 'utf8');
  },
});

const CORE_BINANCE_TOOLS = new Set([
  'futures_klines', 'futures_ticker_price', 'futures_ticker_24hr', 'futures_order_book', 'spot_klines', 'spot_ticker_price',
  'spot_ticker_24hr', 'spot_order_book', 'futures_account_balance', 'spot_account_info', 'futures_funding_rate', 'futures_open_interest', 'futures_exchange_info', 'spot_exchange_info',
]);

function createMcpAdapter(client: McpClient, serverId?: string): McpClientLike {
  return {
    listTools: async () => {
      const tools = await client.listTools();
      const filtered = serverId === 'binance-sdk' ? tools.filter((t) => CORE_BINANCE_TOOLS.has(t.name)) : tools;
      return { tools: filtered.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> })) };
    },
    callTool: async ({ name, arguments: args }) => {
      const res = await client.callTool(name, args ?? {});
      return { content: res.content.map((c) => ({ type: c.type, text: c.type === 'text' ? c.text : JSON.stringify(c) })), isError: res.isError };
    },
  };
}

export async function connectMcpServer(cfg: McpServerConfig): Promise<McpClient | null> {
  try {
    const transport = cfg.url || cfg.transport === 'http' ? new StreamableHttpTransport({ url: cfg.url! }) : new StdioTransport({ command: cfg.command!, args: cfg.args, env: cfg.env });
    const client = new McpClient({ serverId: cfg.id, transport });
    await Promise.race([client.connect(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))]);
    return client;
  } catch { return null; }
}

let registryPromise: Promise<ToolRegistry> | null = null;
const activeClients: McpClient[] = [];

export async function getActiveToolRegistry(): Promise<ToolRegistry> {
  if (registryPromise) return registryPromise;
  registryPromise = (async () => {
    const registry = new ToolRegistry({ tools: [calculator, listSkillsTool, readSkillTool], timeoutMs: 15_000, maxConcurrency: 4, maxOutputChars: 4000 });
    await Promise.allSettled(MCP_SERVERS.filter((s) => s.enabled).map(async (cfg) => {
      const client = await connectMcpServer(cfg);
      if (!client) return;
      activeClients.push(client);
      await registerMcpTools(registry, createMcpAdapter(client, cfg.id));
    }));
    return registry;
  })();
  return registryPromise;
}

export async function closeMcpServers(): Promise<void> {
  for (const client of activeClients) {
    await client.close().catch(() => undefined);
  }
  activeClients.length = 0;
  registryPromise = null;
}

/** Register all tools from a connected MCP client into a tool registry. */
export async function registerMcp(registry: ToolRegistry, client: McpClient, serverId?: string): Promise<void> {
  await registerMcpTools(registry, createMcpAdapter(client, serverId));
}

export async function consumeStream(stream: AsyncIterable<any>, onThinking: (d: string) => void, onToken: (d: string) => void): Promise<{ thinking: string; content: string }> {
  let thinking = ''; let content = '';
  for await (const event of stream) {
    if (event.type === 'thinking' && event.data?.delta) { thinking += event.data.delta; onThinking(event.data.delta); }
    else if (event.type === 'token' && event.data?.delta) { content += event.data.delta; onToken(event.data.delta); }
  }
  return { thinking, content };
}

export interface SlashCommandInfo { name: string; args?: string; desc: string; }

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: '/help', args: '[cmd]', desc: 'Show command manual & shortcuts' },
  { name: '/style', args: '[box|line]', desc: 'Toggle input style (rounded box vs divider lines)' },
  { name: '/skills', args: '[name]', desc: 'Browse & load ruby-agent-skills' },
  { name: '/clear', desc: 'Clear conversation history' },
  { name: '/mcp', args: '[list]', desc: 'Inspect MCP servers & connection health' },
  { name: '/tools', desc: 'List active tools & parameter schemas' },
  { name: '/model', args: '[name]', desc: 'Switch active LLM or show selector' },
  { name: '/context', desc: 'Show token usage & context statistics' },
  { name: '/compact', desc: 'Summarize past conversation to save context' },
  { name: '/save', args: '[file.md]', desc: 'Export chat transcript to disk' },
  { name: '/system', args: '[prompt]', desc: 'View or set system prompt' },
  { name: '/quit', desc: 'Exit the TUI harness gracefully' },
  ...TASK_SLASH_COMMANDS,
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
  openModal?: (modal: 'model' | 'clear' | 'skills') => void;
  runPrompt?: (text: string) => void;
}

function handleContextCmd(ctx: CommandContext): void {
  const tokens = ctx.messages.reduce((s, m) => s + (m.tokens ?? Math.ceil(m.content.length / 4)), 0);
  ctx.addSystemCard(`📊 Context & Telemetry:\n• Model: ${ctx.model}\n• Messages: ${ctx.messages.length}\n• Est. Tokens: ~${tokens}\n• Tools Loaded: ${ctx.registry?.definitions().length || 0}`);
}

function handleCompactCmd(ctx: CommandContext): void {
  if (ctx.messages.length <= 3) { ctx.showToast('Conversation too short to compact', 'warning', 2500); return; }
  const olderCount = ctx.messages.length - 2;
  ctx.setMessages((prev) => [{ role: 'system', content: `[Compacted context: ${olderCount} earlier turns summarized]`, timestamp: Date.now() }, ...prev.slice(-2)]);
  ctx.showToast(`Compacted ${olderCount} turns`, 'info', 2500);
}

function handleSaveCmd(ctx: CommandContext, arg: string): void {
  const file = arg || `chat-${new Date().toISOString().slice(0, 10)}.md`;
  const body = ctx.messages.map((m) => `### ${m.role.toUpperCase()}\n\n${m.content}\n`).join('\n---\n\n');
  try {
    writeFileSync(file, `# Chat Transcript (${new Date().toLocaleString()})\n\n${body}`, 'utf8');
    ctx.showToast(`Saved to ${file}`, 'info', 3000); ctx.addSystemCard(`Transcript saved to ${file}`);
  } catch (err) { ctx.showToast(`Failed to save: ${String(err)}`, 'error', 4000); }
}

function formatToolsList(registry?: ToolRegistry | null): string {
  const defs = registry?.definitions() || [];
  if (!defs.length) return 'Active Tools: None loaded or MCP servers still connecting.';
  return `Active Tools (${defs.length}):\n${defs.map((d: any) => `• ${d?.function?.name || d?.name || 'tool'}: ${d?.function?.description || d?.description || 'Active'}`).join('\n')}`;
}

function formatMcpServersList(): string {
  const activeCount = MCP_SERVERS.filter((s) => s.enabled).length;
  return `MCP Servers (${activeCount}/${MCP_SERVERS.length} active):\n${MCP_SERVERS.map((s) => `• ${s.name} (${s.id}): ${s.enabled ? 'Active' : `Disabled${s.disabledReason ? ` (${s.disabledReason})` : ''}`}`).join('\n')}`;
}

export function dispatchSlashCommand(rawInput: string, ctx: CommandContext): boolean {
  if (!rawInput.startsWith('/')) return false;
  const [cmd, ...rest] = rawInput.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd?.toLowerCase()) {
    case '/clear':
      if (ctx.openModal) ctx.openModal('clear');
      else { ctx.clearMessages(); ctx.showToast('Chat history cleared', 'info', 2000); }
      return true;
    case '/context': handleContextCmd(ctx); return true;
    case '/compact': handleCompactCmd(ctx); return true;
    case '/save': handleSaveCmd(ctx, arg); return true;
    case '/tools':
      if (ctx.registry) ctx.addSystemCard(formatToolsList(ctx.registry));
      else {
        ctx.showToast('Fetching tools...', 'info', 1500);
        void getActiveToolRegistry().then((r) => ctx.addSystemCard(formatToolsList(r))).catch((e) => ctx.showToast(`Error: ${String(e)}`, 'error', 3000));
      }
      return true;
    case '/mcp': ctx.addSystemCard(formatMcpServersList()); return true;
    case '/tasks': return handleTasksCommand(arg, ctx);
    case '/skills':
      if (arg) {
        const file = findSkillFile(arg);
        if (file) {
          ctx.setMessages((prev) => [{ role: 'system', content: `[Skill loaded: ${arg}]\n\n${readFileSync(file, 'utf8')}`, timestamp: Date.now() }, ...prev]);
          ctx.showToast(`Loaded skill: ${arg}`, 'info', 2500);
        } else ctx.showToast(`Skill ${arg} not found in any pack`, 'error', 3000);
      } else if (ctx.openModal) ctx.openModal('skills');
      else ctx.addSystemCard(`Available Skills:\n${loadAvailableSkills().slice(0, 15).map((s) => `• ${s.name} [${s.pack}]`).join('\n')}`);
      return true;
    case '/model':
      if (arg && ctx.setModel) { ctx.setModel(arg); saveUserConfig({ model: arg }); ctx.showToast(`Switched to ${arg}`, 'info', 2000); }
      else if (ctx.openModal) ctx.openModal('model');
      else ctx.addSystemCard(`Model: ${ctx.model}\nAvailable: ${(ctx.models || []).join(', ')}`);
      return true;
    case '/system':
      if (arg === 'reset' || arg === 'clear') {
        ctx.setMessages((prev) => prev.filter((m) => m.role !== 'system'));
        saveUserConfig({ systemPrompt: undefined });
        ctx.showToast('System prompt reset to default', 'info', 2000);
      } else if (arg) {
        ctx.setMessages((prev) => [{ role: 'system', content: arg, timestamp: Date.now() }, ...prev]);
        saveUserConfig({ systemPrompt: arg });
        ctx.showToast('System prompt updated', 'info', 2000);
      } else {
        const s = ctx.messages.find((m) => m.role === 'system');
        ctx.addSystemCard(`System Prompt:\n${s ? s.content : 'Default system instructions active'}`);
      }
      return true;
    case '/help':
      ctx.addSystemCard(`Commands:\n${SLASH_COMMANDS.map((c) => `${c.name} ${c.args || ''} — ${c.desc}`).join('\n')}\n\nKeybindings: Tab: Complete/Scroll • Esc: Cancel • Ctrl+O: Model • Ctrl+T: View`);
      return true;
    case '/quit': case '/exit': closeMcpServers().finally(() => process.exit(0)); return true;
    default: return false;
  }
}

const parseArgs = (a: unknown): any => (typeof a === 'string' ? (() => { try { return JSON.parse(a); } catch { return {}; } })() : a ?? {});

function resolveToolName(name: string, registry: ToolRegistry): string {
  if (registry.get(name)) return name;
  const n = name.toLowerCase().replace(/^(get_market_|get_)/, '');
  const match = registry.definitions().find((d: any) => {
    const fn = d.function.name.toLowerCase();
    return fn === n || fn.endsWith(`_${n}`) || fn.includes(n);
  });
  return match ? (match as any).function.name : name;
}

export async function executeMcpCalls(
  registry: ToolRegistry,
  toolCalls: readonly any[],
): Promise<Array<{ role: 'tool'; content: string; tool_call_id?: string; timestamp: number }>> {
  const resolved = toolCalls.map((tc) => ({
    ...tc,
    function: { ...tc.function, name: resolveToolName(tc.function?.name || '', registry), arguments: parseArgs(tc.function?.arguments) },
  }));
  const results = await registry.executeToolCalls(resolved);
  return results.map((res) => ({
    role: 'tool' as const,
    content: truncateToolOutput(res.outputString || (res.success ? 'Success' : 'Execution error'), 3500),
    tool_call_id: res.toolCallId,
    timestamp: Date.now(),
  }));
}