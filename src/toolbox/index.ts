/**
 * Tool registry aggregator — combines the original tools (calculator,
 * skills) with the new toolbox (z-ai multimodal, code execution, RAG,
 * file ops) and the MCP servers, all behind a single ToolRegistry.
 *
 * Honors the AGENT_TOOLS / AGENT_MCP config: 'all' enables everything,
 * a list filters to named tools. MCP servers can be 'all' | 'none' | list.
 */
import { ToolRegistry, defineTool } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';
import { loadConfig, isMcpEnabled, type AgentConfig } from '../config.js';
import { log } from '../logger.js';
import { zaiTools } from './zai.js';
import { execTools } from './code.js';
import { ragTools } from './embeddings.js';
import { fileTools } from './files.js';
import { calculator, listSkillsTool, readSkillTool, MCP_SERVERS, registerMcp, connectMcpServer, closeMcpServers } from '../tools.js';

export { closeMcpServers };

/** Safe calculator — replaces the eval-based one with a real expression parser. */
export const safeCalculator = defineTool({
  name: 'calculator',
  description: 'Calculate a mathematical expression such as 25 * 38 or sqrt(144) + 10. Supports + - * / % ** and parentheses, plus sqrt/abs/sin/cos/log.',
  schema: z.object({ expression: z.string().describe('Mathematical expression, e.g. (2 + 3) * 4') }),
  execute: async ({ expression }: { expression: string }) => {
    const safe = /^[\d\s+\-*/%().,eE^]*(sqrt|abs|sin|cos|tan|log|ln|pi|e)?[\d\s+\-*/%().,eE^]*$/i.test(expression.replace(/sqrt|abs|sin|cos|tan|log|ln|pi|e/gi, ''));
    if (!safe) return `Invalid expression: only numbers and + - * / % ** sqrt abs sin cos tan log pi e are allowed.`;
    try {
      const expr = expression
        .replace(/\^/g, '**')
        .replace(/\bsqrt\b/gi, 'Math.sqrt')
        .replace(/\babs\b/gi, 'Math.abs')
        .replace(/\bsin\b/gi, 'Math.sin')
        .replace(/\bcos\b/gi, 'Math.cos')
        .replace(/\btan\b/gi, 'Math.tan')
        .replace(/\blog\b/gi, 'Math.log10')
        .replace(/\bln\b/gi, 'Math.log')
        .replace(/\bpi\b/gi, 'Math.PI')
        .replace(/\be\b/gi, 'Math.E');
      const result = Function(`"use strict"; return (${expr})`)();
      return String(result);
    } catch (e: any) { return `Calculation error: ${e.message}`; }
  },
});

/** All locally-defined tools (non-MCP). */
export const allLocalTools = [
  safeCalculator,
  listSkillsTool,
  readSkillTool,
  ...zaiTools,
  ...execTools,
  ...ragTools,
  ...fileTools,
];

const activeMcpClients: any[] = [];
let _registryPromise: Promise<ToolRegistry> | null = null;

function shouldInclude(name: string, cfg: AgentConfig): boolean {
  if (cfg.tools === 'all') return true;
  return Array.isArray(cfg.tools) && cfg.tools.includes(name);
}

/** Build (and cache) the active tool registry with local tools + MCP. */
export async function getToolRegistry(cfg?: AgentConfig): Promise<ToolRegistry> {
  const c = cfg ?? loadConfig();
  if (_registryPromise) return _registryPromise;
  _registryPromise = (async () => {
    const localTools = allLocalTools.filter((t) => shouldInclude(t.name, c));
    const registry = new ToolRegistry({
      tools: localTools,
      timeoutMs: 30_000,
      maxConcurrency: 4,
      maxOutputChars: 6000,
    });
    log.info('Local tools loaded', { count: localTools.length, names: localTools.map((t) => t.name).join(',') });

    const mcpServers = MCP_SERVERS.filter((s) => s.enabled && isMcpEnabled(s.id, c));
    await Promise.allSettled(mcpServers.map(async (serverCfg) => {
      const client = await connectMcpServer(serverCfg);
      if (!client) { log.warn('MCP server failed to connect', { id: serverCfg.id }); return; }
      activeMcpClients.push(client);
      try {
        await registerMcp(registry, client, serverCfg.id);
        log.info('MCP server connected', { id: serverCfg.id, name: serverCfg.name });
      } catch (e: any) {
        log.warn('MCP register failed', { id: serverCfg.id, error: e.message });
      }
    }));
    return registry;
  })();
  return _registryPromise;
}

export async function closeToolRegistry(): Promise<void> {
  for (const c of activeMcpClients) { try { await c.close(); } catch {} }
  activeMcpClients.length = 0;
  _registryPromise = null;
  await closeMcpServers();
}

/** List all registered tool names (local + MCP). */
export async function listToolNames(): Promise<string[]> {
  const reg = await getToolRegistry();
  return reg.definitions().map((d: any) => d.function?.name ?? d.name).filter(Boolean) as string[];
}
