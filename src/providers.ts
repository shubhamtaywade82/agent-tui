/**
 * Multi-provider LLM abstraction.
 *
 * Unifies Ollama, OpenAI-compatible, Anthropic-compatible, and Z.ai (GLM)
 * behind a single `LLMProvider` interface so the agent loop, tools, CLI, and
 * server can swap providers without touching call-sites.
 */
import { OllamaClient, HttpClient, OpenAICompatClient, AnthropicCompatClient } from '@nemesis-oss/ollama-sdk';
import ZAI from 'z-ai-web-dev-sdk';
import { loadConfig, type AgentConfig, type ProviderName } from './config.js';
import { log } from './logger.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: readonly ToolCall[];
  tool_call_id?: string;
  images?: readonly string[];
  thinking?: string;
  timestamp?: number;
}

export interface ToolCall {
  function: { name: string; arguments: any };
  id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  model?: string;
  messages: ChatMessage[];
  tools?: readonly ToolDefinition[];
  temperature?: number;
  think?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Context window size hint. */
  numCtx?: number;
}

export interface ChatResult {
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface StreamCallbacks {
  onThinking?: (delta: string) => void;
  onToken?: (delta: string) => void;
  onToolCall?: (tc: ToolCall) => void;
}

/** A unified chat-completion + streaming + embeddings interface. */
export interface LLMProvider {
  readonly name: ProviderName;
  readonly defaultModel: string;
  /** List available model identifiers. */
  listModels(signal?: AbortSignal): Promise<string[]>;
  /** One-shot chat completion. */
  chat(opts: ChatOptions): Promise<ChatResult>;
  /** Streaming chat completion; resolves once the stream is fully consumed. */
  chatStream(opts: ChatOptions, cb?: StreamCallbacks): Promise<ChatResult>;
  /** Generate text from a prompt (no message history). */
  generate(prompt: string, opts?: Partial<ChatOptions>): Promise<string>;
  /** Embed text(s) into a vector. */
  embed(model: string, input: string | readonly string[]): Promise<readonly number[][]>;
}

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

function ollamaClient(cfg: AgentConfig): OllamaClient {
  return new OllamaClient({
    endpoints: cfg.provider.ollama.endpoints,
    timeoutMs: 120_000,
    retries: 3,
    endpointHealth: { strategy: 'least-connections', maxConcurrentPerEndpoint: 4 },
  });
}

class OllamaProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  readonly defaultModel: string;
  private client: OllamaClient;
  constructor(cfg: AgentConfig) {
    this.client = ollamaClient(cfg);
    this.defaultModel = cfg.provider.ollama.defaultModel;
  }
  get raw(): OllamaClient { return this.client; }
  async listModels(_signal?: AbortSignal) {
    const models = await this.client.listModels();
    return models.map((m) => m.name);
  }
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const res = await this.client.chat({
      model: opts.model ?? this.defaultModel,
      messages: opts.messages as any,
      tools: opts.tools as any,
      stream: false,
      think: opts.think === false ? false : 'high',
      options: { temperature: opts.temperature ?? 0.7, num_ctx: opts.numCtx ?? 16384 },
      signal: opts.signal,
    });
    const msg = (res as any).message ?? (res as any);
    return {
      content: msg.content ?? '',
      thinking: msg.thinking ?? undefined,
      tool_calls: msg.tool_calls,
      usage: (res as any).eval_count ? { inputTokens: (res as any).prompt_eval_count ?? 0, outputTokens: (res as any).eval_count ?? 0 } : undefined,
      model: opts.model ?? this.defaultModel,
    };
  }
  async chatStream(opts: ChatOptions, cb?: StreamCallbacks): Promise<ChatResult> {
    const stream = await this.client.chatStream({
      model: opts.model ?? this.defaultModel,
      messages: opts.messages as any,
      think: opts.think === false ? false : 'high',
      tools: opts.tools as any,
      options: { temperature: opts.temperature ?? 0.7, num_ctx: opts.numCtx ?? 16384 },
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    let thinking = ''; let content = '';
    for await (const ev of stream) {
      if (ev.type === 'thinking' && ev.data?.delta) { thinking += ev.data.delta; cb?.onThinking?.(ev.data.delta); }
      else if (ev.type === 'token' && ev.data?.delta) { content += ev.data.delta; cb?.onToken?.(ev.data.delta); }
    }
    const final = await stream.finalResult;
    let toolCalls = final?.message?.tool_calls;
    let rawContent = final?.message?.content || content;
    if ((!toolCalls || !toolCalls.length) && rawContent) {
      const parsed = parseTextToolCalls(rawContent);
      if (parsed.length) { toolCalls = parsed; rawContent = rawContent.replace(/<function[\s\S]*?<\/function>|<tool_call>[\s\S]*?<\/tool_call>/g, '').trim(); }
    }
    return { content: rawContent ?? '', thinking: thinking || undefined, tool_calls: toolCalls as ToolCall[] | undefined, model: opts.model ?? this.defaultModel };
  }
  async generate(prompt: string, opts?: Partial<ChatOptions>): Promise<string> {
    const res = await this.client.generateText({
      model: opts?.model ?? this.defaultModel,
      prompt,
      options: { temperature: opts?.temperature ?? 0.7 },
      signal: opts?.signal,
    } as any);
    return res;
  }
  async embed(model: string, input: string | readonly string[]): Promise<readonly number[][]> {
    const res = await this.client.embedText(model, input);
    return res.map((v) => [...v]);
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

class OpenAIProvider implements LLMProvider {
  readonly name = 'openai' as const;
  readonly defaultModel: string;
  private client: OpenAICompatClient;
  private apiKey?: string;
  constructor(cfg: AgentConfig) {
    this.apiKey = cfg.provider.openai.apiKey;
    if (!this.apiKey) throw new Error('OpenAI provider requires OPENAI_API_KEY in .env');
    const http = new HttpClient({ baseUrl: cfg.provider.openai.baseUrl, apiKey: this.apiKey });
    this.client = new OpenAICompatClient(http);
    this.defaultModel = cfg.provider.openai.defaultModel;
  }
  async listModels(signal?: AbortSignal) {
    const res = await this.client.listModels(signal);
    return (res.data ?? []).map((m: any) => m.id);
  }
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const res = await this.client.chatCompletions({
      model: opts.model ?? this.defaultModel,
      messages: opts.messages as any,
      tools: opts.tools as any,
      temperature: opts.temperature ?? 0.7,
    });
    const choice = res.choices?.[0];
    return {
      content: String(choice?.message?.content ?? ''),
      tool_calls: (choice?.message?.tool_calls as ToolCall[] | undefined)?.map((t: any) => ({ id: t.id, function: { name: t.function?.name ?? '', arguments: t.function?.arguments ?? {} } })),
      usage: res.usage ? { inputTokens: res.usage.prompt_tokens ?? 0, outputTokens: res.usage.completion_tokens ?? 0 } : undefined,
      model: opts.model ?? this.defaultModel,
    };
  }
  async chatStream(opts: ChatOptions, cb?: StreamCallbacks): Promise<ChatResult> {
    const stream = await this.client.chatCompletions({
      model: opts.model ?? this.defaultModel,
      messages: opts.messages as any,
      tools: opts.tools as any,
      temperature: opts.temperature ?? 0.7,
      stream: true,
    }, opts.signal);
    let content = ''; const toolCalls: ToolCall[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) { content += delta.content; cb?.onToken?.(delta.content); }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name) {
            const full: ToolCall = { id: tc.id, function: { name: tc.function.name, arguments: tc.function.arguments ?? '' } };
            toolCalls.push(full); cb?.onToolCall?.(full);
          }
        }
      }
    }
    return { content, tool_calls: toolCalls.length ? toolCalls : undefined, model: opts.model ?? this.defaultModel };
  }
  async generate(prompt: string, opts?: Partial<ChatOptions>): Promise<string> {
    const r = await this.chat({ ...opts, messages: [{ role: 'user', content: prompt }] });
    return r.content;
  }
  async embed(model: string, input: string | readonly string[]): Promise<readonly number[][]> {
    const res = await this.client.embeddings({ model, input: Array.isArray(input) ? input : [input] });
    return (res.data ?? []).map((d: any) => d.embedding);
  }
}

// ---------------------------------------------------------------------------
// Anthropic-compatible provider
// ---------------------------------------------------------------------------

class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  readonly defaultModel: string;
  private client: AnthropicCompatClient;
  constructor(cfg: AgentConfig) {
    const apiKey = cfg.provider.anthropic.apiKey;
    if (!apiKey) throw new Error('Anthropic provider requires ANTHROPIC_API_KEY in .env');
    const http = new HttpClient({ baseUrl: cfg.provider.anthropic.baseUrl, apiKey, headers: { 'anthropic-version': '2023-06-01' } });
    this.client = new AnthropicCompatClient(http);
    this.defaultModel = cfg.provider.anthropic.defaultModel;
  }
  async listModels(): Promise<string[]> {
    // Anthropic has a fixed model list; return the common set.
    return ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'];
  }
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const { system, messages } = splitSystem(opts.messages);
    const res = await this.client.messages({
      model: opts.model ?? this.defaultModel,
      system,
      messages: messages as any,
      max_tokens: 8192,
      temperature: opts.temperature ?? 0.7,
      tools: opts.tools?.map(toAnthropicTool) as any,
    });
    let content = ''; const toolCalls: ToolCall[] = [];
    for (const block of (res.content ?? [])) {
      if (block.type === 'text') content += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, function: { name: block.name, arguments: block.input } });
    }
    return { content, tool_calls: toolCalls.length ? toolCalls : undefined, model: opts.model ?? this.defaultModel };
  }
  async chatStream(opts: ChatOptions, cb?: StreamCallbacks): Promise<ChatResult> {
    const { system, messages } = splitSystem(opts.messages);
    const stream = await this.client.messages({
      model: opts.model ?? this.defaultModel,
      system,
      messages: messages as any,
      max_tokens: 8192,
      temperature: opts.temperature ?? 0.7,
      stream: true,
      tools: opts.tools?.map(toAnthropicTool) as any,
    }, opts.signal);
    let content = ''; const toolCalls: ToolCall[] = [];
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta') {
        const d = (ev as any).delta;
        if (d?.text) { content += d.text; cb?.onToken?.(d.text); }
      } else if (ev.type === 'content_block_start') {
        const block = (ev as any).content_block;
        if (block?.type === 'tool_use') {
          const tc: ToolCall = { id: block.id, function: { name: block.name, arguments: '' } };
          toolCalls.push(tc); cb?.onToolCall?.(tc);
        }
      }
    }
    return { content, tool_calls: toolCalls.length ? toolCalls : undefined, model: opts.model ?? this.defaultModel };
  }
  async generate(prompt: string, opts?: Partial<ChatOptions>): Promise<string> {
    const r = await this.chat({ ...opts, messages: [{ role: 'user', content: prompt }] });
    return r.content;
  }
  async embed(): Promise<readonly number[][]> {
    throw new Error('Anthropic does not provide embeddings; use ollama or openai provider for embed()');
  }
}

// ---------------------------------------------------------------------------
// Z.ai (GLM) provider — wraps the z-ai-web-dev-sdk
// ---------------------------------------------------------------------------

class ZaiProvider implements LLMProvider {
  readonly name = 'zai' as const;
  readonly defaultModel: string;
  private zai: ZAI;
  private constructor(zai: ZAI, model: string) { this.zai = zai; this.defaultModel = model; }
  static async create(cfg: AgentConfig): Promise<ZaiProvider> {
    if (!cfg.provider.zai.apiKey) throw new Error('Z.ai provider requires ZAI_API_KEY in .env');
    process.env.ZAI_API_KEY = cfg.provider.zai.apiKey;
    process.env.ZAI_BASE_URL = cfg.provider.zai.baseUrl;
    const zai = await ZAI.create();
    return new ZaiProvider(zai, cfg.provider.zai.defaultModel);
  }
  get raw(): ZAI { return this.zai; }
  async listModels(): Promise<string[]> {
    return ['glm-4.6', 'glm-4.5v', 'glm-4.5-air', 'glm-4.5', 'glm-4-air', 'glm-4-flash'];
  }
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const res = await this.zai.chat.completions.create({
      model: opts.model ?? this.defaultModel,
      messages: opts.messages.filter((m) => m.role !== 'tool').map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
      thinking: { type: opts.think === false ? 'disabled' : 'enabled' },
    });
    const choice = res?.choices?.[0];
    return { content: String(choice?.message?.content ?? ''), model: opts.model ?? this.defaultModel };
  }
  async chatStream(opts: ChatOptions, cb?: StreamCallbacks): Promise<ChatResult> {
    const res = await this.zai.chat.completions.create({
      model: opts.model ?? this.defaultModel,
      messages: opts.messages.filter((m) => m.role !== 'tool').map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
      stream: true,
      thinking: { type: opts.think === false ? 'disabled' : 'enabled' },
    });
    let content = '';
    for await (const chunk of res as any) {
      const delta = chunk?.choices?.[0]?.delta;
      if (delta?.reasoning_content) cb?.onThinking?.(delta.reasoning_content);
      if (delta?.content) { content += delta.content; cb?.onToken?.(delta.content); }
    }
    return { content, model: opts.model ?? this.defaultModel };
  }
  async generate(prompt: string, opts?: Partial<ChatOptions>): Promise<string> {
    const r = await this.chat({ ...opts, messages: [{ role: 'user', content: prompt }] });
    return r.content;
  }
  async embed(): Promise<readonly number[][]> {
    throw new Error('Z.ai embeddings not supported via this provider; use ollama or openai');
  }
}

// ---------------------------------------------------------------------------
// Helpers & factory
// ---------------------------------------------------------------------------

function splitSystem(msgs: ChatMessage[]): { system: string; messages: ChatMessage[] } {
  const sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = msgs.filter((m) => m.role !== 'system');
  return { system: sys || 'You are a helpful AI assistant.', messages: rest };
}

function toAnthropicTool(t: ToolDefinition): any {
  return {
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  };
}

/** Parse LLM-emitted text tool-call tags (fallback for models that don't natively emit tool_calls). */
export function parseTextToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const fnRe = /<function\s+name="([^"]+)">([\s\S]*?)<\/function>/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    const args: Record<string, any> = {};
    const paramRe = /<param\s+name="([^"]+)">([\s\S]*?)<\/param>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(m[2]!)) !== null) args[pm[1]!] = pm[2]!.trim();
    calls.push({ function: { name: m[1]!, arguments: args } });
  }
  const tcRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  while ((m = tcRe.exec(text)) !== null) {
    try {
      const p = JSON.parse(m[1]!.trim());
      if (p.name) calls.push({ function: { name: p.name, arguments: p.arguments || {} } });
    } catch {}
  }
  return calls;
}

/** Build (and cache) the active provider. Z.ai is async so we keep a promise. */
let _provider: LLMProvider | null = null;
let _providerPromise: Promise<LLMProvider> | null = null;

export function getProvider(cfg?: AgentConfig): LLMProvider {
  const c = cfg ?? loadConfig();
  if (_provider && _provider.name === c.provider.active) return _provider;
  switch (c.provider.active) {
    case 'ollama': _provider = new OllamaProvider(c); return _provider;
    case 'openai': _provider = new OpenAIProvider(c); return _provider;
    case 'anthropic': _provider = new AnthropicProvider(c); return _provider;
    case 'zai': throw new Error('Z.ai provider is async — use getProviderAsync()');
  }
}

export async function getProviderAsync(cfg?: AgentConfig): Promise<LLMProvider> {
  const c = cfg ?? loadConfig();
  if (_providerPromise && _provider?.name === c.provider.active) return _providerPromise;
  _providerPromise = (async () => {
    switch (c.provider.active) {
      case 'ollama': return _provider = new OllamaProvider(c);
      case 'openai': return _provider = new OpenAIProvider(c);
      case 'anthropic': return _provider = new AnthropicProvider(c);
      case 'zai': return _provider = await ZaiProvider.create(c);
    }
  })();
  try {
    _provider = await _providerPromise;
    log.info('LLM provider ready', { provider: _provider.name, model: _provider.defaultModel });
    return _provider;
  } catch (e) {
    _providerPromise = null;
    throw e;
  }
}

export function resetProvider(): void { _provider = null; _providerPromise = null; }

/** Get the raw underlying client (for Ollama-specific features like webSearch/webFetch). */
export function rawOllama(): OllamaClient | null {
  return _provider instanceof OllamaProvider ? _provider.raw : null;
}
export function rawZai(): ZAI | null {
  return _provider instanceof ZaiProvider ? _provider.raw : null;
}
