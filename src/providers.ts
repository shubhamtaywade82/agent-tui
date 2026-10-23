/**
 * Multi-provider LLM abstraction.
 *
 * Unifies Ollama, OpenAI-compatible endpoints (OpenAI, Z.ai GLM, vLLM, ...), and
 * Anthropic-compatible APIs behind a single `LLMProvider` interface so the agent loop, tools, CLI, and
 * server can swap providers without touching call-sites.
 */
import { OllamaClient, HttpClient, AnthropicCompatClient } from '@nemesis-oss/ollama-sdk';
import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { loadConfig, parseOpenAIBaseUrl, type AgentConfig, type ProviderName } from './config.js';
import { buildOllamaClientOptions } from './ollama-endpoints.js';
import { log } from './logger.js';
import { parseTextToolCalls } from './utils/text-tool-calls.js';

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
  return new OllamaClient(buildOllamaClientOptions(cfg.provider.ollama, cfg.wallTimeMs));
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
      options: { temperature: opts.temperature ?? 0.7, num_ctx: opts.numCtx ?? 32768 },
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
      options: { temperature: opts.temperature ?? 0.7, num_ctx: opts.numCtx ?? 32768 },
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

/** Tool arguments as a JSON string for the wire. Strings pass through unchanged. */
function argumentsJson(args: unknown): string {
  return typeof args === 'string' ? args : JSON.stringify(args ?? {});
}

/**
 * Map internal messages to the OpenAI wire format. A tool call without an id gets a
 * synthetic one, and a tool result without an id is matched in order to the calls of the
 * assistant message just before it. Text-fallback tool calls and sessions saved before ids
 * were kept both take this path.
 */
function toWireMessages(messages: readonly ChatMessage[]): ChatCompletionMessageParam[] {
  const wire: ChatCompletionMessageParam[] = [];
  let unmatched: string[] = [];
  let synthetic = 0;
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        wire.push({ role: 'system', content: m.content });
        unmatched = [];
        break;
      case 'user':
        wire.push({ role: 'user', content: m.content });
        unmatched = [];
        break;
      case 'assistant': {
        if (!m.tool_calls?.length) {
          wire.push({ role: 'assistant', content: m.content });
          unmatched = [];
          break;
        }
        const ids = m.tool_calls.map((tc) => tc.id ?? `call_${synthetic++}`);
        unmatched = [...ids];
        wire.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc, i) => ({
            id: ids[i]!,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: argumentsJson(tc.function.arguments) },
          })),
        });
        break;
      }
      case 'tool': {
        const id = m.tool_call_id ?? unmatched[0];
        if (!id) throw new Error('Tool result has no tool_call_id and cannot be matched to a tool call');
        unmatched = unmatched.filter((u) => u !== id);
        wire.push({ role: 'tool', tool_call_id: id, content: m.content });
        break;
      }
    }
  }
  return wire;
}

function toWireTool(t: ToolDefinition): ChatCompletionTool {
  return { type: 'function', function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } };
}

/** Tool arguments arrive as a JSON string. Keep unparseable text raw so the registry reports the error to the model. */
function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return raw; }
}

/** A tool call as the wire sends it. Non-conforming servers may omit `type` or `arguments`. */
interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Convert wire tool calls. Calls without a function name are skipped, and custom tool calls are not supported. */
function toToolCalls(calls: readonly WireToolCall[] | undefined): ToolCall[] | undefined {
  const out: ToolCall[] = [];
  for (const tc of calls ?? []) {
    if (tc.type === 'custom' || !tc.function?.name) continue;
    out.push({ id: tc.id, function: { name: tc.function.name, arguments: parseArguments(tc.function.arguments ?? '') } });
  }
  return out.length ? out : undefined;
}

// The OpenAI-compatible provider runs on the official `openai` SDK. The SDK appends
// `/chat/completions` to `baseURL`, so the version segment must be part of it (see
// parseOpenAIBaseUrl). Z.ai GLM is served this way at https://api.z.ai/api/paas/v4.
class OpenAIProvider implements LLMProvider {
  readonly name = 'openai' as const;
  readonly defaultModel: string;
  private client: OpenAI;
  constructor(cfg: AgentConfig) {
    const apiKey = cfg.provider.openai.apiKey;
    if (!apiKey) throw new Error('OpenAI provider requires OPENAI_API_KEY in .env');
    const { baseURL, defaultQuery } = parseOpenAIBaseUrl(cfg.provider.openai.baseUrl);
    this.client = new OpenAI({ apiKey, baseURL, defaultQuery });
    this.defaultModel = cfg.provider.openai.defaultModel;
  }
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const page = await this.client.models.list(signal ? { signal } : undefined);
    return page.data.map((m) => m.id);
  }
  private request(opts: ChatOptions, model: string): Omit<ChatCompletionCreateParamsBase, 'stream'> {
    return {
      model,
      messages: toWireMessages(opts.messages),
      ...(opts.tools?.length ? { tools: opts.tools.map(toWireTool) } : {}),
      temperature: opts.temperature ?? 0.7,
    };
  }
  /** Omit unset keys: the SDK rejects an explicit `timeout: undefined` instead of using its default. */
  private requestOptions(opts: ChatOptions): { signal?: AbortSignal; timeout?: number } {
    return {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    };
  }
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const model = opts.model ?? this.defaultModel;
    const res = await this.client.chat.completions.create({ ...this.request(opts, model), stream: false }, this.requestOptions(opts));
    // `reasoning_content` is the de-facto reasoning field (GLM, DeepSeek, vLLM); it is not in the OpenAI types.
    const message = res.choices?.[0]?.message as { content?: string | null; tool_calls?: WireToolCall[]; reasoning_content?: string | null } | undefined;
    return {
      content: message?.content ?? '',
      thinking: message?.reasoning_content || undefined,
      tool_calls: toToolCalls(message?.tool_calls),
      usage: res.usage ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens } : undefined,
      model,
    };
  }
  async chatStream(opts: ChatOptions, cb?: StreamCallbacks): Promise<ChatResult> {
    const model = opts.model ?? this.defaultModel;
    const stream = await this.client.chat.completions.create({ ...this.request(opts, model), stream: true }, this.requestOptions(opts));
    let content = ''; let thinking = '';
    // Tool-call fragments are keyed by index. A different id on the same index starts a new call,
    // so non-conforming servers that reuse an index do not merge two calls into one.
    const pending = new Map<string, { id?: string; name: string; args: string }>();
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; cb?.onToken?.(delta.content); }
      const reasoning = (delta as { reasoning_content?: string | null }).reasoning_content;
      if (reasoning) { thinking += reasoning; cb?.onThinking?.(reasoning); }
      for (const part of delta.tool_calls ?? []) {
        let key = String(part.index);
        const current = pending.get(key);
        if (part.id && current?.id && current.id !== part.id) key = `${key}:${part.id}`;
        const slot = pending.get(key) ?? { name: '', args: '' };
        if (part.id) slot.id = part.id;
        if (part.function?.name && !slot.name) slot.name = part.function.name;
        if (part.function?.arguments) slot.args += part.function.arguments;
        pending.set(key, slot);
      }
    }
    const toolCalls: ToolCall[] = [];
    for (const slot of pending.values()) {
      if (!slot.name) continue;
      const tc: ToolCall = { id: slot.id, function: { name: slot.name, arguments: parseArguments(slot.args) } };
      toolCalls.push(tc);
      cb?.onToolCall?.(tc);
    }
    return { content, thinking: thinking || undefined, tool_calls: toolCalls.length ? toolCalls : undefined, model };
  }
  async generate(prompt: string, opts?: Partial<ChatOptions>): Promise<string> {
    const r = await this.chat({ ...opts, messages: [{ role: 'user', content: prompt }] });
    return r.content;
  }
  async embed(model: string, input: string | readonly string[]): Promise<readonly number[][]> {
    // Ask for floats explicitly: when encoding_format is unset the SDK expects base64 and decodes float arrays to [].
    const res = await this.client.embeddings.create({ model, input: typeof input === 'string' ? input : [...input], encoding_format: 'float' });
    return res.data.map((d) => d.embedding);
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

export { parseTextToolCalls };

/** Error for providers that were removed or never existed. Names the replacement for removed ones. */
export function unsupportedProviderError(name: string): Error {
  if (name === 'zai') {
    return new Error('AGENT_PROVIDER=zai was removed. Z.ai is OpenAI-compatible: set AGENT_PROVIDER=openai, OPENAI_BASE_URL=https://api.z.ai/api/paas/v4, OPENAI_API_KEY=<your Z.ai key>, OPENAI_MODEL=glm-4.6.');
  }
  return new Error(`Unknown AGENT_PROVIDER "${name}". Expected ollama | openai | anthropic.`);
}

/** Build (and cache) the active provider. */
let _provider: LLMProvider | null = null;
let _providerPromise: Promise<LLMProvider> | null = null;

export function getProvider(cfg?: AgentConfig): LLMProvider {
  const c = cfg ?? loadConfig();
  if (_provider && _provider.name === c.provider.active) return _provider;
  switch (c.provider.active) {
    case 'ollama': _provider = new OllamaProvider(c); return _provider;
    case 'openai': _provider = new OpenAIProvider(c); return _provider;
    case 'anthropic': _provider = new AnthropicProvider(c); return _provider;
    default: throw unsupportedProviderError(c.provider.active);
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
      default: throw unsupportedProviderError(c.provider.active);
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
