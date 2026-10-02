/**
 * Enhanced Agent — the core reasoning loop that ties together the multi-provider
 * LLM abstraction, the full tool registry (local + MCP), context budgeting,
 * and session persistence. Works for headless, CLI, and server modes.
 *
 * Replaces the minimal `runner` (calculator-only) with a full-featured agent
 * that can reason, call tools, observe results, and iterate — across Ollama,
 * OpenAI, Anthropic, and Z.ai providers.
 */
import { getProviderAsync, parseTextToolCalls, type LLMProvider, type ChatMessage, type ToolCall, type StreamCallbacks } from './providers.js';
import { getToolRegistry, closeToolRegistry } from './toolbox/index.js';
import { budgetMessages, truncateToolOutput } from './utils/context.js';
import { loadConfig, type AgentConfig } from './config.js';
import { log, RunMetrics } from './logger.js';
import { saveSession, appendToConversationLog } from './session.js';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface AgentRunOptions {
  /** Override the configured provider. */
  provider?: string;
  /** Override the model. */
  model?: string;
  /** Max reasoning iterations. */
  maxIterations?: number;
  /** Disable tool calling (text-only response). */
  noTools?: boolean;
  /** Disable streaming (wait for full response). */
  noStream?: boolean;
  /** Disable thinking/reasoning traces. */
  noThinking?: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming callbacks. */
  onThinking?: (delta: string) => void;
  onToken?: (delta: string) => void;
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, output: string, success: boolean) => void;
  onPhase?: (phase: 'thinking' | 'responding' | 'executing-tools' | 'done') => void;
  /** Session id to continue, or undefined for no persistence. */
  sessionId?: string;
}

export interface AgentRunResult {
  content: string;
  thinking?: string;
  toolCalls: ToolCall[];
  iterations: number;
  messages: ChatMessage[];
  metrics: Record<string, number>;
  sessionId?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are a highly capable AI assistant operating in a terminal environment. Your workspace is the current working directory.

TOOL SET — you have access to filesystem operations, web search, code execution, embeddings/RAG, image generation, vision analysis, TTS/ASR, and MCP servers (memory, git, time, fetch, sequential-thinking, Binance market data).

SKILLS — you have engineering skills packs available via the list_skills and read_skill tools. Three packs are supported: ruby-agent-skills (Ruby, Rails, OOP, Clean Code), react-agent-skills (React, TypeScript, components, hooks, state, testing), and node-agent-skills (Node.js, agents, change-safety, verification, preflight). SKILL LOADING (bounded): call list_skills AT MOST ONCE per task with one broad query. If a result clearly matches, call read_skill for it ONCE. If nothing matches, or a read_skill lookup fails, proceed immediately with the task — do not retry list_skills or read_skill with different wording. Skills are a quality bonus, never a blocker.

WORKFLOW — When a task requires multiple steps: (1) if it's a coding/engineering task, load relevant skills first; (2) use filesystem/git tools to inspect the current state; (3) reason step-by-step and call tools as needed; (4) verify your work with run_code or run_shell before reporting done. Keep responses focused and actionable.`;

function loadSystemPrompt(): string {
  const file = resolve(process.cwd(), 'AGENTS.md');
  if (existsSync(file)) {
    try { return readFileSync(file, 'utf8'); } catch {}
  }
  return DEFAULT_SYSTEM_PROMPT;
}

/** Execute a batch of tool calls via the registry. */
async function executeToolCalls(
  toolCalls: ToolCall[],
  registry: any,
  metrics: RunMetrics,
  opts: AgentRunOptions,
): Promise<ChatMessage[]> {
  const results: ChatMessage[] = [];
  for (const tc of toolCalls) {
    const name = tc.function.name;
    const args = typeof tc.function.arguments === 'string' ? safeParse(tc.function.arguments) : tc.function.arguments;
    opts.onToolCall?.(name, args);
    metrics.incToolCall();
    try {
      const execResults = await registry.executeToolCalls([{
        id: tc.id ?? name,
        function: { name, arguments: args },
      }]);
      const res = execResults[0];
      const output = res?.outputString ?? (res?.success ? 'Success' : 'Execution error');
      const success = res?.success ?? false;
      opts.onToolResult?.(name, truncateToolOutput(output, 3000), success);
      results.push({
        role: 'tool',
        content: truncateToolOutput(output, 3500),
        tool_call_id: tc.id,
      });
      log.info('Tool executed', { name, success, outputLen: output.length });
    } catch (e: any) {
      const msg = `Tool ${name} error: ${e.message}`;
      opts.onToolResult?.(name, msg, false);
      results.push({ role: 'tool', content: msg, tool_call_id: tc.id });
      log.warn('Tool failed', { name, error: e.message });
    }
  }
  return results;
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Run the full agent loop: think → call tools → observe → respond.
 * Iterates up to maxIterations, then synthesizes a final response.
 */
export async function runAgent(
  userPrompt: string,
  history: ChatMessage[] = [],
  opts: AgentRunOptions = {},
): Promise<AgentRunResult> {
  const cfg = loadConfig();
  const provider = await getProviderAsync(cfg);
  const model = opts.model ?? cfg.provider[cfg.provider.active].defaultModel;
  const maxIter = opts.maxIterations ?? cfg.maxIterations;
  const metrics = new RunMetrics();

  log.info('Agent run starting', { provider: provider.name, model, prompt: userPrompt.slice(0, 80), history: history.length });

  const hasSystem = history.some((m) => m.role === 'system');
  const messages: ChatMessage[] = hasSystem ? [...history] : [
    { role: 'system', content: loadSystemPrompt() },
    ...history,
    { role: 'user', content: userPrompt },
  ];
  if (!messages.some((m) => m.role === 'user' && m.content === userPrompt)) {
    messages.push({ role: 'user', content: userPrompt });
  }
  appendToConversationLog('user', userPrompt);

  let registry: any = null;
  if (!opts.noTools) {
    try { registry = await getToolRegistry(cfg); } catch (e: any) { log.warn('Tool registry unavailable', { error: e.message }); }
  }

  const toolDefs = registry ? registry.definitions() : undefined;
  let allToolCalls: ToolCall[] = [];
  let finalContent = '';
  let finalThinking: string | undefined;

  try {
    for (let iter = 0; iter < maxIter; iter++) {
      metrics.incIteration();
      const budgeted = budgetMessages(messages, cfg.contextBudget);
      opts.onPhase?.('thinking');

      const result = opts.noStream
        ? await provider.chat({ model, messages: budgeted, tools: toolDefs, think: !opts.noThinking, temperature: cfg.temperature, signal: opts.signal })
        : await provider.chatStream(
            { model, messages: budgeted, tools: toolDefs, think: !opts.noThinking, temperature: cfg.temperature, numCtx: 16384, signal: opts.signal, timeoutMs: cfg.wallTimeMs },
            { onThinking: (d) => { opts.onThinking?.(d); }, onToken: (d) => { opts.onPhase?.('responding'); opts.onToken?.(d); } },
          );

      finalThinking = result.thinking ?? finalThinking;
      let toolCalls = result.tool_calls ?? [];
      let content = result.content ?? '';

      // Fallback: parse text-embedded tool calls for models that don't emit native tool_calls
      if ((!toolCalls.length) && content) {
        const parsed = parseTextToolCalls(content);
        if (parsed.length) { toolCalls = parsed; content = content.replace(/<function[\s\S]*?<\/function>|<tool_call>[\s\S]*?<\/tool_call>/g, '').trim(); }
      }

      allToolCalls.push(...toolCalls);

      if (toolCalls.length && registry) {
        opts.onPhase?.('executing-tools');
        const asstMsg: ChatMessage = { role: 'assistant', content, thinking: result.thinking, tool_calls: toolCalls };
        messages.push(asstMsg);
        const toolResults = await executeToolCalls(toolCalls, registry, metrics, opts);
        messages.push(...toolResults);
        log.info('Iteration complete', { iter, toolCalls: toolCalls.length });
        continue;
      }

      // No tool calls → final response
      finalContent = content;
      messages.push({ role: 'assistant', content, thinking: result.thinking });
      break;
    }

    // If we exhausted iterations without a clean finish, synthesize
    if (!finalContent && messages.length > 2) {
      opts.onPhase?.('thinking');
      log.info('Synthesizing final response after max iterations', { iterations: maxIter });
      const synth = opts.noStream
        ? await provider.chat({ model, messages: budgetMessages([...messages, { role: 'user', content: 'Provide a final comprehensive response.' }], cfg.contextBudget), think: false, signal: opts.signal })
        : await provider.chatStream(
            { model, messages: budgetMessages([...messages, { role: 'user', content: 'Provide a final comprehensive response.' }], cfg.contextBudget), think: false, signal: opts.signal },
            { onToken: (d) => { opts.onPhase?.('responding'); opts.onToken?.(d); } },
          );
      finalContent = synth.content;
      messages.push({ role: 'assistant', content: synth.content });
    }

    appendToConversationLog('assistant', finalContent);
    opts.onPhase?.('done');

    let sessionId = opts.sessionId;
    if (sessionId !== undefined || process.env.AUTOSAVE_SESSION === '1') {
      const s = saveSession(messages, { id: sessionId, provider: provider.name, model });
      sessionId = s.id;
    }

    const result: AgentRunResult = {
      content: finalContent,
      thinking: finalThinking,
      toolCalls: allToolCalls,
      iterations: metrics.summary().iterations,
      messages,
      metrics: metrics.summary(),
      sessionId,
    };
    log.info('Agent run complete', { ...metrics.summary(), toolCalls: allToolCalls.length, contentLen: finalContent.length });
    return result;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    log.error('Agent run failed', { error: msg, iterations: metrics.summary().iterations });
    if (/context|too long|exceed/i.test(msg) && messages.length > 4) {
      log.warn('Context overflow — compacting and retrying once');
      const compacted = budgetMessages(messages.slice(-4), cfg.contextBudget);
      return runAgent(userPrompt, compacted, { ...opts, maxIterations: Math.min(opts.maxIterations ?? maxIter, 3) });
    }
    throw err;
  }
}

/** One-shot convenience: run a prompt and return just the text. */
export async function ask(prompt: string, opts?: AgentRunOptions): Promise<string> {
  const r = await runAgent(prompt, [], opts);
  return r.content;
}

/** Graceful shutdown — closes MCP servers. */
export async function shutdownAgent(): Promise<void> {
  await closeToolRegistry();
}
