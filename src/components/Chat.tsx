import React, { useState, useEffect, useMemo } from 'react';
import { existsSync, readFileSync, writeFileSync } from 'fs'; import { Box, Text, useInput } from '@nemesis-oss/termina-core';
import { TextInput } from './ui/text-input/index.js'; import { Divider } from './ui/divider/index.js';
import { OllamaClient, Message } from '@nemesis-oss/ollama-sdk'; import { ToastStack, useToast } from './ui/toast/index.js'; import { ScrollArea } from './ui/scroll-area/index.js';
import { useFocusManager, useTerminalSize } from './ui/hooks/index.js';
import { getActiveToolRegistry, consumeStream, dispatchSlashCommand, SLASH_COMMANDS, executeMcpCalls, loadAvailableSkills, loadUserConfig, saveUserConfig, matchBestSkill, findSkillFile } from '../tools.js';
import { ChatAccordion, renderSingleTurn, renderStreamingRows, parseTextToolCalls } from './ChatAccordion.js';
import { budgetMessages, resolveMessageTokenBudget } from '../utils/context.js';
import { ToolCallLedger } from '../utils/tool-loop-guard.js';
import { loadConfig } from '../config.js';
import {
  createOllamaRunRoutingState,
  maybeEscalateOllamaModel,
  resolveOllamaModelForTaskAsync,
} from '../ollama-routing.js';
import { autoMaxChains } from '../auto-mode.js';
import { getTaskRuntime, buildTaskPrompt, isPlanSatisfied } from '../tasks.js';
import { TranscriptView } from './TranscriptView.js';
import { useTranscript } from '../hooks/useTranscript.js';
import { runOllamaChat, makeUserEvent, makePlanEvent, makePlanStatusPatch, makeSystemEvent } from '../transcript/index.js';

export interface ChatMessage extends Message { timestamp?: number; thinking?: string; tokens?: number; skill?: string; }
export interface PendingContinuation { type: 'task' | 'turn_limit'; taskId?: string; label: string; detail?: string; prompt: string; }

const HIST = '.history';
const filterValidHistory = (items: string[]): string[] => {
  const result: string[] = []; const seen = new Set<string>();
  for (const item of items) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (s.length > 3 && !seen.has(s)) { seen.add(s); result.push(s); }
  }
  return result;
};
const saveHistoryFile = (items: string[]): void => {
  try { writeFileSync(HIST, items.slice(0, 500).map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf-8'); } catch {}
};
const loadHistory = (): string[] => {
  if (!existsSync(HIST)) return [];
  try { return filterValidHistory(readFileSync(HIST, 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } })); } catch { return []; }
};

const DEFAULT_SYSTEM_PROMPT = `You are an expert AI assistant. Workspace: ${process.cwd()}. Use run_shell to execute commands (e.g. rails new, bundle, npm, git). Use filesystem tools to inspect or edit files. For multi-step tasks, create a plan with create_task (with id, title, objective), execute the steps, and call complete_task when done. Do not stall or narrate future steps; execute tools directly.`;
const prepareMessages = (h: ChatMessage[], skillName?: string, budget = 9000, compactionHint?: string | null): ChatMessage[] => {
  let prompt = DEFAULT_SYSTEM_PROMPT;
  if (skillName) {
    const file = findSkillFile(skillName);
    if (file) {
      try {
        const raw = readFileSync(file, 'utf8');
        const snippet = raw.length > 2500 ? raw.slice(0, 2500) + '\n...' : raw;
        prompt += `\n\n[AUTHORITATIVE SKILL: ${skillName}]\n${snippet}`;
      } catch {}
    }
  }
  return budgetMessages(h.some((m) => m.role === 'system') ? h : [{ role: 'system', content: prompt, timestamp: Date.now() }, ...h], budget, compactionHint);
};
const isPrematureStall = (t: string): boolean =>
  t.length <= 300 && /(let me|i('ll| will))\s+(start|inspect|check|create|look|run|examine|verify|see|read|find)/i.test(t);
const cleanContinuation = (inp: string, acc: string): string => {
  const norm = inp.trim().toLowerCase(); const c = acc.replace(/^["']|["']$/g, '').split('\n')[0]?.trim() || '';
  if (!c || norm.startsWith(c.toLowerCase())) return '';
  if (c.toLowerCase().startsWith(norm)) return c.slice(norm.length).trimStart();
  const inW = norm.split(/\s+/); const accW = c.toLowerCase().split(/\s+/);
  for (let i = Math.min(inW.length, accW.length); i > 0; i--) if (inW.slice(-i).join(' ') === accW.slice(0, i).join(' ')) return c.split(/\s+/).slice(i).join(' ');
  return c;
};

const DEFAULT_PROMPTS = [
  'tell me about rails models and controllers', 'tell me about the architecture of this agent', 'tell me about available MCP tools and skills',
  'how to test and run the agent', 'what tools and skills are available', 'refactor this component for KISS', 'write unit tests for this function',
];

function getMenuOptions(input: string, models: string[], ghost?: string, pool: string[] = []): Array<{ name: string; args?: string; desc: string }> {
  if (!input) return [];
  const low = input.toLowerCase();
  if (input.startsWith('/')) {
    if (!input.includes(' ')) return SLASH_COMMANDS.filter((c) => c.name.startsWith(low));
    if (input.startsWith('/model ')) return models.filter((m) => m.toLowerCase().includes(input.slice(7).toLowerCase())).map((m) => ({ name: `/model ${m}`, desc: `Switch to ${m}` }));
    if (input.startsWith('/skills ')) return loadAvailableSkills().filter((s) => s.name.includes(input.slice(8).toLowerCase())).slice(0, 10).map((s) => ({ name: `/skills ${s.name}`, desc: `${s.family}` }));
    return input.startsWith('/style ') ? ['box', 'line'].filter((s) => s.startsWith(input.slice(7))).map((s) => ({ name: `/style ${s}`, desc: `Style: ${s}` })) : [];
  }
  if (input.trim().length < 2) return [];
  const items: Array<{ name: string; desc: string }> = [];
  if (ghost && ghost !== input && ghost.toLowerCase().startsWith(low)) items.push({ name: ghost, desc: 'AI completion' });
  const seen = new Set(items.map((i) => i.name.toLowerCase()));
  const words = low.trim().split(/\s+/).filter(Boolean);
  for (const p of pool) {
    const pLow = p.toLowerCase();
    if (p !== input && words.every((w) => pLow.includes(w)) && !seen.has(pLow)) {
      items.push({ name: p, desc: pLow.startsWith(low) ? 'Prompt template' : 'History match' });
      seen.add(pLow);
      if (items.length >= 4) break;
    }
  }
  return items;
}

function resolvePendingContinuation(isDone: boolean): PendingContinuation | null {
  const rt = getTaskRuntime();
  const next = rt.nextReady();
  if (next) {
    return {
      type: 'task',
      taskId: next.id,
      label: `Next Task: [${next.id}] ${next.title}`,
      detail: next.objective,
      prompt: buildTaskPrompt(next),
    };
  }
  if (!isDone) {
    return {
      type: 'turn_limit',
      label: 'Step Limit Reached with Pending Work',
      detail: 'Would you like to continue execution from where it left off?',
      prompt: 'Please continue execution directly from where you left off. Proceed with the remaining tasks and verify the implementation.',
    };
  }
  return null;
}

interface ChatProps {
  client: OllamaClient | null; messages: ChatMessage[]; theme?: any; isActive?: boolean;
  onSendMessage: (u?: string, a?: string, t?: string, x?: Partial<ChatMessage>) => void; setMessages?: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  models?: string[]; isConnected?: boolean; columns?: number; rows?: number; selectedModel?: string; onSelectModel?: (m: string) => void;
  isSelectingModel?: boolean; onOpenModal?: (m: 'model' | 'clear' | 'skills') => void;
  /** Auto-continue through tasks / turn limits without Y/N prompts. */
  autoMode?: boolean;
}

const Chat: React.FC<ChatProps> = ({
  client, messages, onSendMessage, setMessages, models = [], theme, isActive = true,
  columns: propCols, rows: propRows, selectedModel: propModel, isSelectingModel = false, onSelectModel, onOpenModal,
  autoMode = false,
}) => {
  const [input, setInput] = useState(''); const [selectedCmdIndex, setSelectedCmdIndex] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'responding' | 'executing-tools'>('idle');
  const [activeTool, setActiveTool] = useState<{ name: string; args?: any } | undefined>();
  const [activeSkill, setActiveSkill] = useState<string | undefined>();
  const [streamedThinking, setStreamedThinking] = useState(''); const [streamedContent, setStreamedContent] = useState('');
  const [viewMode, setViewMode] = useState<'stream' | 'accordion' | 'transcript'>('stream'); const [expandThinking, setExpandThinking] = useState(false);
  const [registry, setRegistry] = useState<any>(null); const [scrollOffset, setScrollOffset] = useState(0);
  const [inputStyle, setInputStyle] = useState<'box' | 'line'>(() => loadUserConfig().inputStyle || 'line');
  const [pendingContinuation, setPendingContinuation] = useState<PendingContinuation | null>(null);
  // Mouse/keyboard per-turn view state. Keyed by turn index — the messages
  // array is append-only within a run, so indices stay stable.
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(() => new Set());
  const [expandedThinkingTurns, setExpandedThinkingTurns] = useState<Set<number>>(() => new Set());
  const [expandedToolCallKeys, setExpandedToolCallKeys] = useState<Set<string>>(() => new Set());
  // Live scroll telemetry from ScrollArea — powers the footer jump pills.
  const [scrollInfo, setScrollInfo] = useState<{ offset: number; total: number }>({ offset: 0, total: 0 });
  const selectedModel = propModel || models[0] || 'qwen3:8b'; const { toasts, show, dismiss } = useToast();
  // Step 5 batch 2: the transcript state + callbacks for the 'transcript' viewMode.
  // Lives alongside the existing ChatMessage[] state — both flows can run, only
  // one is visible at a time based on viewMode.
  const { state: transcriptState, cb: transcriptCb } = useTranscript();
  const transcriptAbortRef = React.useRef<AbortController | null>(null);
  // Step 5 batch 3: refs for slash-command-set state that the next
  // runOllamaChat call should pick up. /skills <name> stores the skill body
  // here; /system <prompt> stores the system prompt here. They get
  // injected into the messages array on the next runTranscriptPrompt call.
  const transcriptSkillRef = React.useRef<string | null>(null);
  const transcriptSystemPromptRef = React.useRef<string | null>(null);
  // Step 5 batch 5.5: a dedicated ToolCallLedger for the transcript path.
  // Separate from loopLedgerRef (used by runAgentLoop) so the two paths
  // don't interfere. The ledger persists across turns within a session
  // so a re-read in turn 5 is caught even if turn 4 already read the file.
  // Reset when /clear is dispatched in transcript mode.
  const transcriptLedgerRef = React.useRef<ToolCallLedger | null>(null);

  const term = useTerminalSize(); const columns = propCols ?? term.columns; const rows = propRows ?? term.rows;
  const { isFocused, setFocus } = useFocusManager({ count: 2, initialIndex: 0, nextKey: 'none', prevKey: 'none' });
  const isInputFocused = isFocused(0); const isChatFocused = isFocused(1);
  const [history, setHistory] = useState<string[]>(() => {
    const userMsgs = [...messages].reverse().filter((m) => m.role === 'user' && m.content.trim()).map((m) => m.content.trim());
    return filterValidHistory([...userMsgs, ...loadHistory()]);
  });
  const [ghostText, setGhostText] = useState(''); const [dismissedInput, setDismissedInput] = useState('');
  const lastReq = React.useRef(0); const abortRef = React.useRef<AbortController | null>(null);
  const chatAbortRef = React.useRef<AbortController | null>(null); const userCancelledRef = React.useRef(false);
  const loopLedgerRef = React.useRef<ToolCallLedger | null>(null);
  const runModelRef = React.useRef<string | undefined>(undefined);
  const routingStateRef = React.useRef<ReturnType<typeof createOllamaRunRoutingState> | null>(null);
  // Token batching: stream deltas land here and flush to React state on a
  // ~40ms cadence. Without this, every token triggers a full conversation
  // re-render (messageRows rebuild + Yoga relayout), which is the main
  // source of the jittery, unprofessional streaming feel.
  const streamBufRef = React.useRef({ thinking: '', content: '' });
  const streamFlushTimerRef = React.useRef<NodeJS.Timeout | null>(null);
  // Per-turn element cache: completed turns render identical elements across
  // stream flushes, so only the active turn rebuilds per flush.
  const turnCacheRef = React.useRef(new Map<ChatMessage, { key: string; rows: React.ReactElement[] }>());

  const promptPool = useMemo(() => Array.from(new Set([...history.filter((h) => !h.startsWith('/')), ...DEFAULT_PROMPTS])), [history]);
  const activeMenu = useMemo(() => dismissedInput === input ? [] : getMenuOptions(input, models, ghostText, promptPool), [input, models, ghostText, promptPool, dismissedInput]);
  const menuOverhead = activeMenu.length > 0 ? 7 : 0;
  const toastOverhead = toasts.length > 0 ? 2 : 0;
  // Plan-continuation panel: outer rounded border (2 rows) + label row +
  // optional detail row + margin row + bordered button row (3 rows).
  // Subtracting it from the chat viewport is what keeps the total frame
  // exactly `rows` tall — the old build overflowed here, which pushed the
  // whole UI down line by line.
  const contOverhead = pendingContinuation ? (pendingContinuation.detail ? 8 : 7) : 0;
  const chatHeight = Math.max(3, rows - 7 - menuOverhead - toastOverhead - contOverhead);

  useEffect(() => {
    setSelectedCmdIndex(0); abortRef.current?.abort();
    if (!input || input.startsWith('/') || phase !== 'idle' || !client) { setGhostText(''); return; }
    const timer = setTimeout(async () => {
      if (input.trim().length < 2) return;
      const id = ++lastReq.current; const ac = new AbortController(); abortRef.current = ac;
      try {
        const comp = models.find((m) => /0\.[58]b|1b|tiny/i.test(m)) || selectedModel;
        const prompt = `Instruction: Autocomplete prefix with 3 to 6 words.\n\nInput: How do I\nCompletion: install ruby gems\n\nInput: ${input}\nCompletion:`;
        const stream = await client.generateStream({
          model: comp, prompt, options: { num_predict: 8, temperature: 0.2, stop: ['\n', 'Input:', 'Completion:'] },
          signal: ac.signal,
        });
        let acc = '';
        for await (const chunk of stream) {
          if (id !== lastReq.current || ac.signal.aborted) break;
          if (chunk.type === 'token' && chunk.data?.delta) {
            acc += chunk.data.delta;
            const c = cleanContinuation(input, acc);
            if (c) { const b = input.endsWith(' ') ? input : input + ' '; setGhostText(b + c.replace(/^\s+/, '')); }
          }
        }
      } catch {}
    }, 100);
    return () => { lastReq.current++; abortRef.current?.abort(); clearTimeout(timer); };
  }, [input, client, selectedModel, models, phase]);
  useEffect(() => { getActiveToolRegistry().then(setRegistry).catch(() => undefined); }, []);

  const toggleStyle = (target?: 'box' | 'line') => {
    const next = target || (inputStyle === 'box' ? 'line' : 'box');
    setInputStyle(next); saveUserConfig({ inputStyle: next }); show(`Input style: ${next}`, 'info', 1500);
  };

  const toggleTurnCollapse = (mi: number) =>
    setCollapsedTurns((prev) => { const n = new Set(prev); if (n.has(mi)) n.delete(mi); else n.add(mi); return n; });
  const toggleTurnThinking = (mi: number) =>
    setExpandedThinkingTurns((prev) => { const n = new Set(prev); if (n.has(mi)) n.delete(mi); else n.add(mi); return n; });
  const toggleToolCallExpanded = (key: string) =>
    setExpandedToolCallKeys((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const flushStreamBuffer = () => {
    if (streamFlushTimerRef.current) { clearTimeout(streamFlushTimerRef.current); streamFlushTimerRef.current = null; }
    const buf = streamBufRef.current;
    if (!buf.thinking && !buf.content) return;
    if (buf.thinking) setStreamedThinking((p) => p + buf.thinking);
    if (buf.content) { setPhase('responding'); setStreamedContent((p) => p + buf.content); }
    streamBufRef.current = { thinking: '', content: '' };
  };
  const bufferStreamDelta = (kind: 'thinking' | 'content', d: string) => {
    streamBufRef.current[kind] += d;
    if (!streamFlushTimerRef.current) {
      streamFlushTimerRef.current = setTimeout(() => { streamFlushTimerRef.current = null; flushStreamBuffer(); }, 40);
    }
  };

  const acceptContinuation = () => {
    if (!pendingContinuation) return;
    const cont = pendingContinuation;
    setPendingContinuation(null);
    show(`Continuing: ${cont.label}`, 'info', 2000);
    void handleContinuation(cont);
  };
  const pauseContinuation = () => {
    if (!pendingContinuation) return;
    setPendingContinuation(null);
    show('Plan paused', 'info', 2000);
  };

  useInput((inp, key) => {
    if (!isActive || isSelectingModel) return;
    if (pendingContinuation) {
      if (inp === 'y' || inp === 'Y') {
        acceptContinuation();
        return;
      }
      // Bare Enter must never chain another loop — pause instead, unless a
      // typed message is waiting (TextInput submits that one separately).
      if (inp === 'n' || inp === 'N' || key.escape || (key.return && !input.trim())) {
        pauseContinuation();
        return;
      }
    }
    if (key.ctrl && (inp === 'a' || inp === '\x01')) return setViewMode((v) => v === 'stream' ? 'accordion' : v === 'accordion' ? 'transcript' : 'stream');
    if (key.ctrl && (inp === 'b' || inp === '\x02')) return toggleStyle();
    if (inp === 't' && isChatFocused) return setExpandThinking((p) => !p);
    if ((key.escape || key.tab) && isChatFocused) setFocus(0);
  });

  const handleContinuation = async (cont: PendingContinuation) => {
    if (cont.taskId) {
      const rt = getTaskRuntime();
      try { rt.start(cont.taskId); } catch {}
    }
    onSendMessage(cont.prompt);
    resetStream('thinking');
    await runAgentLoop([...messages, { role: 'user', content: cont.prompt, timestamp: Date.now() }], activeSkill);
  };

  const resetStream = (p: typeof phase = 'idle') => {
    // Discard anything still buffered — committed content already reached the
    // transcript via onSendMessage by the time resetStream runs.
    if (streamFlushTimerRef.current) { clearTimeout(streamFlushTimerRef.current); streamFlushTimerRef.current = null; }
    streamBufRef.current = { thinking: '', content: '' };
    setPhase(p); setStreamedThinking(''); setStreamedContent(''); setActiveTool(undefined);
    if (p === 'idle') { setActiveSkill(undefined); setCollapsedTurns(new Set()); setExpandedThinkingTurns(new Set()); setExpandedToolCallKeys(new Set()); }
  };

  const pickModelForRun = async (prompt: string, toolCount = 0): Promise<string> => {
    const cfg = loadConfig();
    const explicitModel = cfg.provider.ollama.routingMode === 'auto' ? undefined : selectedModel;
    const routerGenerate =
      client && cfg.provider.ollama.routerModel
        ? (p: string) => client.generateText({
          model: cfg.provider.ollama.routerModel,
          prompt: p,
          options: { temperature: 0, num_predict: 8 },
        })
        : undefined;
    const pick = await resolveOllamaModelForTaskAsync(cfg, prompt, {
      explicitModel,
      toolCount,
      routerGenerate,
    });
    if (
      pick.reason.startsWith('auto')
      || pick.reason === 'cloud-first'
      || pick.reason.startsWith('router')
      || pick.reason.startsWith('mid-run')
    ) {
      show(`Model route: ${pick.model} (${pick.reason})`, 'info', 2800);
    }
    return pick.model;
  };

  const runPrompt = async (text: string) => {
    if (phase !== 'idle') { show('Agent is busy; try again once it finishes', 'warning', 2500); return; }
    // Transcript view mode routes through the new contract (step 5 batch 2).
    // The existing 'stream' / 'accordion' modes keep using runAgentLoop.
    if (viewMode === 'transcript') {
      await runTranscriptPrompt(text);
      return;
    }
    runModelRef.current = await pickModelForRun(text, registry?.definitions?.()?.length ?? 0);
    const match = matchBestSkill(text);
    if (match) { setActiveSkill(match.name); show(`Matched skill: ${match.name}`, 'info', 2000); }
    onSendMessage(text); resetStream('thinking');
    if (match) setActiveSkill(match.name);
    await runAgentLoop([...messages, { role: 'user', content: text, timestamp: Date.now() }], match?.name);
  };

  /**
   * Parallel transcript path (step 5 batches 2 + 4 + 3 + 5). Uses the step-2
   * TranscriptCallbacks contract + step-3 runOllamaChat bridge. The bridge
   * supports multi-turn tool execution (batch 4): when the model requests
   * a tool, the onToolCall callback delegates to the existing ToolRegistry,
   * the result is appended to the conversation, and the bridge loops for
   * another model turn. Batch 3 added skill + system prompt injection via
   * the transcriptSkillRef / transcriptSystemPromptRef refs. Batch 5 adds
   * auto-mode continuation: after each runOllamaChat completes, if there
   * is a pending task in the runtime, the loop dispatches a plan event
   * (in_progress), chains another runOllamaChat with the task's prompt,
   * and patches the plan event to completed / blocked based on the result.
   *
   * Still missing vs runAgentLoop: context-compaction ledger (the loop
   * will eventually OOM long sessions — fix in a future batch).
   */
  const runTranscriptPrompt = async (text: string) => {
    if (!client) { show('Ollama client not ready', 'error', 2500); return; }
    setPhase('thinking');
    transcriptAbortRef.current = new AbortController();
    // Mint the user event + dispatch the runOllamaChat bridge.
    transcriptCb.add(makeUserEvent(transcriptCb.nextId(), text));
    try {
      // Resolve the tool registry lazily — same one runAgentLoop uses.
      const reg = registry || await getActiveToolRegistry();
      if (!registry && reg) setRegistry(reg);
      const cfg = loadConfig();

      // Build the message list for this run. Includes:
      //   - The system prompt (from transcriptSystemPromptRef if set by
      //     /system, else the legacy saved systemPrompt, else undefined).
      //   - Recent user/assistant messages from the legacy ChatMessage[]
      //     state (last 8) for context continuity.
      //   - The skill body (from transcriptSkillRef if set by /skills).
      //   - The new user message.
      const historyMsgs = messages
        .filter((m) => m.role === 'system' || m.role === 'user')
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content } as Message));
      const systemPrompt = transcriptSystemPromptRef.current
        ?? messages.find((m) => m.role === 'system')?.content;
      const skillBody = transcriptSkillRef.current;
      const sysMsg: Message | null = systemPrompt || skillBody
        ? {
            role: 'system',
            content: [
              systemPrompt ? systemPrompt : '',
              skillBody ? `\n\n[AUTHORITATIVE SKILL]\n${skillBody}` : '',
            ].join('').trim() || 'You are a helpful assistant.',
          }
        : null;

      // The shared onToolCall callback — reused across the initial run and
      // any auto-mode continuation chains. Integrates the ToolCallLedger
      // (step 5 batch 5.5) so repeated identical tool calls get short-
      // circuited: the model sees a "[Loop guard] Blocked..." message
      // instead of the real result, breaking out of re-read loops that
      // happen when context compaction hides prior results.
      const ledger = transcriptLedgerRef.current ?? (transcriptLedgerRef.current = new ToolCallLedger());
      const onToolCall = reg ? async (tc: any) => {
        const name = tc?.function?.name ?? '<unknown>';
        const args = tc?.function?.arguments ?? {};
        // Step 5 batch 5.5: ask the ledger if this call should be short-circuited.
        const blocked = ledger.beforeExecute(name, args);
        if (blocked) {
          return {
            result: blocked,
            durationMs: 0,
            status: 'blocked' as const,
          };
        }
        const execStartedAt = Date.now();
        try {
          const results = await reg.executeToolCalls([tc]);
          const r = results[0];
          const result = r?.outputString || (r?.success ? 'Success' : 'Execution error');
          // Record the call so future duplicate calls get blocked.
          ledger.afterExecute(name, args, r?.outputString ?? result);
          return {
            result,
            error: r?.success ? undefined : r.error.message,
            durationMs: Date.now() - execStartedAt,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Still record the failed attempt — the ledger counts attempts,
          // not just successes.
          ledger.afterExecute(name, args, `Error: ${message}`);
          return {
            result: `Tool threw: ${message}`,
            error: message,
            durationMs: Date.now() - execStartedAt,
          };
        }
      } : undefined;

      // Initial run.
      let currentMessages: Message[] = [
        ...(sysMsg ? [sysMsg] : []),
        ...historyMsgs,
        { role: 'user' as const, content: text },
      ];
      let result = await runOllamaChat(client, transcriptCb, {
        model: selectedModel,
        messages: currentMessages,
        think: true,
        signal: transcriptAbortRef.current.signal,
        contextWindow: cfg.numCtx || 32768,
        onToolCall,
        maxToolIterations: autoMaxChains(),
      });

      // Step 5 batch 5: auto-mode continuation loop. After the initial
      // runOllamaChat completes, check for pending task continuations.
      // If autoMode is on, chain another run (up to autoMaxChains),
      // dispatching plan events for each task lifecycle.
      let autoChains = 0;
      const maxAuto = autoMaxChains();
      while (autoMode) {
        // Check if the plan is fully satisfied — if so, stop.
        if (isPlanSatisfied()) {
          show('Plan complete — all tasks finished', 'success', 3000);
          break;
        }
        // resolvePendingContinuation mirrors the existing runAgentLoop
        // logic: returns the next ready task, or a turn_limit prompt.
        const cont = resolvePendingContinuation(!result.hitIterationLimit);
        if (!cont) break;
        if (autoChains >= maxAuto) {
          show(`Auto mode stopped after ${maxAuto} continuations — confirm to proceed`, 'warning', 4000);
          setPendingContinuation(cont);
          break;
        }
        autoChains += 1;
        show(`Auto [${autoChains}/${maxAuto}]: ${cont.label}`, 'info', 2500);

        // For task continuations, dispatch a plan event + patch it as
        // the chained turn progresses. For turn-limit continuations
        // (no taskId), just chain another runOllamaChat without a plan event.
        let planEventId: number | null = null;
        if (cont.taskId) {
          try { getTaskRuntime().start(cont.taskId); } catch {}
          const task = getTaskRuntime().getTask(cont.taskId);
          if (task) {
            planEventId = transcriptCb.nextId();
            transcriptCb.add(makePlanEvent(
              planEventId,
              task.id,
              task.title,
              task.objective,
              task.maxAttempts,
            ));
            transcriptCb.patch(planEventId, makePlanStatusPatch('in_progress', {
              attempts: task.attempts,
            }));
          }
        }

        // Chain another runOllamaChat with the continuation prompt.
        currentMessages = [
          ...(sysMsg ? [sysMsg] : []),
          { role: 'user' as const, content: cont.prompt },
        ];
        try {
          result = await runOllamaChat(client, transcriptCb, {
            model: selectedModel,
            messages: currentMessages,
            think: true,
            signal: transcriptAbortRef.current.signal,
            contextWindow: cfg.numCtx || 32768,
            onToolCall,
            maxToolIterations: autoMaxChains(),
          });
          // Patch the plan event based on the result.
          if (planEventId !== null) {
            if (result.hitIterationLimit) {
              transcriptCb.patch(planEventId, makePlanStatusPatch('blocked', {
                attempts: autoChains,
                failureReason: 'Hit iteration limit',
              }));
            } else if (cont.taskId) {
              try {
                getTaskRuntime().complete(cont.taskId, { note: 'Auto-completed' });
                transcriptCb.patch(planEventId, makePlanStatusPatch('completed', {
                  attempts: autoChains,
                  note: 'Auto-completed',
                }));
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                try { getTaskRuntime().fail(cont.taskId, reason); } catch {}
                transcriptCb.patch(planEventId, makePlanStatusPatch('blocked', {
                  attempts: autoChains,
                  failureReason: reason,
                }));
              }
            }
          }
        } catch (err) {
          // Chained turn errored — patch the plan event as blocked.
          const reason = err instanceof Error ? err.message : String(err);
          if (planEventId !== null && cont.taskId) {
            try { getTaskRuntime().fail(cont.taskId, reason); } catch {}
            transcriptCb.patch(planEventId, makePlanStatusPatch('blocked', {
              attempts: autoChains,
              failureReason: reason,
            }));
          }
          throw err;
        }
      }

      const iterSuffix = result.iterations > 1 ? ` · ${result.iterations} turns` : '';
      const limitSuffix = result.hitIterationLimit ? ' · hit iteration limit' : '';
      const autoSuffix = autoChains > 0 ? ` · ${autoChains} auto-chains` : '';
      show(`Done in ${(result.durationMs / 1000).toFixed(1)}s${iterSuffix}${limitSuffix}${autoSuffix}`, 'info', 2200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      show(`Transcript error: ${message}`, 'error', 3500);
    } finally {
      transcriptAbortRef.current = null;
      setPhase('idle');
    }
  };

  const executeSlashCommand = (cmd: string): boolean => {
    if (cmd === '/accordion') return (setViewMode((v) => v === 'stream' ? 'accordion' : 'stream'), true);
    if (cmd === '/transcript') return (setViewMode('transcript'), true);
    if (cmd.startsWith('/style')) { const a = cmd.split(/\s+/)[1]; toggleStyle(a === 'box' || a === 'line' ? a : undefined); return true; }
    return dispatchSlashCommand(cmd, {
      messages, model: selectedModel, setModel: onSelectModel, models, showToast: show, registry,
      clearMessages: () => onSendMessage('/clear'), setMessages: setMessages ?? (() => {}),
      addSystemCard: (t) => onSendMessage(undefined, t, undefined, { role: 'system', content: t, timestamp: Date.now() }), openModal: onOpenModal,
      runPrompt: (text) => { void runPrompt(text); },
    });
  };

  /**
   * Step 5 batch 3: transcript-specific slash command dispatcher.
   * Handles commands that need to operate on the transcript state instead
   * of the legacy ChatMessage[] state. Returns true if the command was
   * recognized and handled; false to fall through to the existing
   * executeSlashCommand (for commands that work the same in both modes
   * like /help, /tools, /mcp, /quit).
   */
  const executeTranscriptSlashCommand = (rawInput: string): boolean => {
    if (!rawInput.startsWith('/')) return false;
    const [cmd, ...rest] = rawInput.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd?.toLowerCase()) {
      case '/clear':
        transcriptCb.clear();
        // Reset the loop-guard ledger so a fresh session starts with no
        // counts — without this, re-running the same prompt after /clear
        // would immediately hit the duplicate-call guard.
        transcriptLedgerRef.current = null;
        // Also reset skill + system-prompt refs so /clear truly starts fresh.
        transcriptSkillRef.current = null;
        transcriptSystemPromptRef.current = null;
        show('Transcript cleared', 'info', 2000);
        return true;
      case '/compact': {
        // Compaction affects BOTH the UI transcript (cb.truncate) AND
        // the model's context (setMessages). The legacy /compact does
        // the same: it inserts a "[Compacted context: N turns]" system
        // message at the front of the model's messages and drops the
        // older messages. Without the setMessages call, the model
        // would still see all the old context (the transcript events
        // are UI-only — they don't feed back into the model's context).
        const total = transcriptState.events.length;
        if (total <= 3) { show('Transcript too short to compact', 'warning', 2500); return true; }
        const keepFromIndex = total - 2;
        const droppedCount = total - 2;
        // Summarize the dropped events for the system message (both UI + model).
        const dropped = transcriptState.events.slice(0, keepFromIndex);
        const droppedSummary = dropped
          .map((ev) => {
            if (ev.kind === 'user') return `user: ${ev.text.slice(0, 40)}`;
            if (ev.kind === 'assistant') return `assistant: ${ev.text.slice(0, 40)}`;
            if (ev.kind === 'thinking') return ev.text ? `thinking: ${ev.text.slice(0, 30)}` : 'thinking';
            if (ev.kind === 'tool') return `tool(${ev.name}): ${ev.status}`;
            if (ev.kind === 'plan') return `plan[${ev.taskId}]: ${ev.status}`;
            if (ev.kind === 'error') return `error(${ev.category})`;
            if (ev.kind === 'usage') return `usage(${ev.scope}: ${ev.tokens})`;
            if (ev.kind === 'system') return `system(${ev.category})`;
            return ev.kind;
          })
          .join('; ')
          .slice(0, 200);
        // 1. Truncate the transcript UI events.
        transcriptCb.truncate(keepFromIndex);
        // 2. Emit a system event so the user sees what was compacted.
        transcriptCb.add(makeSystemEvent(
          transcriptCb.nextId(),
          'compacted',
          `${droppedCount} events dropped: ${droppedSummary}`,
        ));
        // 3. Mutate the model's messages state to compact its context.
        //    This mirrors the legacy /compact: insert a system message
        //    summarizing the compaction, then keep only the last 2 messages.
        if (setMessages) {
          setMessages((prev) => {
            if (prev.length <= 3) return prev;
            const olderMsgCount = prev.length - 2;
            return [
              { role: 'system' as const, content: `[Compacted context: ${olderMsgCount} earlier turns summarized]`, timestamp: Date.now() },
              ...prev.slice(-2),
            ];
          });
        }
        show(`Compacted ${droppedCount} events`, 'info', 2500);
        return true;
      }
      case '/save': {
        const file = arg || `transcript-${new Date().toISOString().slice(0, 10)}.md`;
        const body = transcriptState.events.map((ev) => {
          const ts = new Date(ev.timestamp).toISOString().slice(11, 19);
          if (ev.kind === 'user') return `### USER [${ts}]\n\n${ev.text}`;
          if (ev.kind === 'assistant') return `### ASSISTANT [${ts}]\n\n${ev.text}`;
          if (ev.kind === 'thinking') return `### THINKING [${ts}]\n\n${ev.text || '(empty)'}`;
          if (ev.kind === 'tool') return `### TOOL [${ts}] ${ev.name} (${ev.status})\n\nargs: ${JSON.stringify(ev.arguments)}\nresult: ${ev.result ?? '(none)'}`;
          if (ev.kind === 'error') return `### ERROR [${ts}] ${ev.category}\n\n${ev.message}`;
          if (ev.kind === 'usage') return `### USAGE [${ts}] ${ev.scope}: ${ev.tokens} tokens`;
          if (ev.kind === 'system') return `### SYSTEM [${ts}] ${ev.category}\n\n${ev.message}`;
          if (ev.kind === 'plan') return `### PLAN [${ts}] ${ev.taskId} (${ev.status})\n\n${ev.title}: ${ev.objective}`;
          if (ev.kind === 'file_op') return `### FILE_OP [${ts}] ${ev.op} ${ev.path}${ev.toPath ? ` -> ${ev.toPath}` : ''}`;
          if (ev.kind === 'mcp') return `### MCP [${ts}] ${ev.server} (${ev.status})${ev.toolName ? ` · ${ev.toolName}` : ''}`;
          if (ev.kind === 'elicitation') return `### ELICITATION [${ts}] ${ev.toolName} -> ${ev.choice ?? '(pending)'}`;
          // Exhaustiveness — if a new event kind is added in types.ts,
          // this line becomes unreachable and TS flags it.
          return `### UNKNOWN [${ts}]\n\n${JSON.stringify(ev, null, 2)}`;
        }).join('\n\n---\n\n');
        try {
          writeFileSync(file, `# Transcript (${new Date().toLocaleString()})\n\n${body}\n`, 'utf8');
          show(`Saved to ${file}`, 'info', 3000);
        } catch (err) { show(`Failed to save: ${String(err)}`, 'error', 4000); }
        return true;
      }
      case '/context': {
        const events = transcriptState.events;
        const byKind = new Map<string, number>();
        for (const ev of events) byKind.set(ev.kind, (byKind.get(ev.kind) ?? 0) + 1);
        const breakdown = [...byKind.entries()].map(([k, n]) => `${k}: ${n}`).join(' · ');
        show(`Transcript: ${events.length} events (${breakdown})`, 'info', 3500);
        return true;
      }
      case '/skills': {
        if (arg) {
          const file = findSkillFile(arg);
          if (file) {
            const body = readFileSync(file, 'utf8');
            transcriptSkillRef.current = body;
            show(`Loaded skill for next transcript run: ${arg}`, 'info', 2500);
          } else {
            show(`Skill ${arg} not found in any pack`, 'error', 3000);
          }
        } else if (onOpenModal) {
          onOpenModal('skills');
        } else {
          const list = loadAvailableSkills().slice(0, 15).map((s) => `• ${s.name} [${s.pack}]`).join('\n');
          show(`Available Skills:\n${list}`, 'info', 4000);
        }
        return true;
      }
      case '/system': {
        if (arg === 'reset' || arg === 'clear') {
          transcriptSystemPromptRef.current = null;
          saveUserConfig({ systemPrompt: undefined });
          show('System prompt reset to default', 'info', 2000);
        } else if (arg) {
          transcriptSystemPromptRef.current = arg;
          saveUserConfig({ systemPrompt: arg });
          show('System prompt set for next transcript run', 'info', 2000);
        } else {
          const sp = transcriptSystemPromptRef.current ?? '(default)';
          show(`System prompt: ${sp}`, 'info', 3500);
        }
        return true;
      }
      // Commands that work the same in both modes fall through to false:
      // /help, /tools, /mcp, /model, /tasks, /quit, /accordion, /transcript, /style
      default:
        return false;
    }
  };

  const executeSingleTurn = async (chatHistory: ChatMessage[], allowTools = true, currentSkill?: string) => {
    const reg = registry || await getActiveToolRegistry();
    if (!registry && reg) setRegistry(reg);
    const tools = (allowTools && reg) ? reg.definitions() : undefined;
    const cfg = loadConfig();
    const tokenBudget = resolveMessageTokenBudget({
      configuredBudget: cfg.contextBudget,
      numCtx: cfg.numCtx,
      toolDefs: tools,
      reserveTokens: cfg.contextReserve,
    });
    const ledger = loopLedgerRef.current;
    const ac = new AbortController();
    chatAbortRef.current = ac;
    const activeModel = runModelRef.current || selectedModel;
    const stream = await client!.chatStream({
      model: activeModel, messages: prepareMessages(chatHistory, currentSkill, tokenBudget, ledger?.compactionNote()),
      think: 'high', tools, options: { temperature: 0.7, num_ctx: cfg.numCtx }, timeoutMs: 120000, signal: ac.signal,
    });
    const { thinking, content } = await consumeStream(stream, (d) => bufferStreamDelta('thinking', d), (d) => bufferStreamDelta('content', d));
    flushStreamBuffer();
    const final = await stream.finalResult;
    let toolCalls = final.message?.tool_calls; let rawContent = final.message?.content || content;
    if ((!toolCalls || !toolCalls.length) && rawContent) {
      const parsed = parseTextToolCalls(rawContent);
      if (parsed.length) { toolCalls = parsed; rawContent = rawContent.replace(/<function[\s\S]*?<\/function>|<tool_call>[\s\S]*?<\/tool_call>/g, '').trim(); }
    }
    if (allowTools && toolCalls?.length && reg) {
      const readCall = toolCalls.find((tc: any) => tc.function?.name === 'read_skill');
      const rawArg = readCall?.function?.arguments;
      const skillName: string | undefined = typeof rawArg === 'string' ? rawArg : ((rawArg as any)?.name ?? currentSkill);
      if (skillName) setActiveSkill(skillName);
      const first = toolCalls[0];
      setActiveTool({ name: first?.function?.name || 'tool', args: first?.function?.arguments });
      const asst: ChatMessage = { role: 'assistant', content: rawContent, thinking: thinking || undefined, tool_calls: toolCalls, timestamp: Date.now(), skill: skillName };
      onSendMessage(undefined, asst.content, asst.thinking, asst); setPhase('executing-tools');
      show(`Executing: ${toolCalls.map((tc: any) => tc.function?.name || 'tool').join(', ')}...`, 'info', 2500);
      const toolMsgs = await executeMcpCalls(reg, toolCalls, loopLedgerRef.current ?? undefined);
      if (routingStateRef.current) {
        routingStateRef.current.toolCalls += toolCalls.length;
        if (toolMsgs.some((tm) => tm.content.includes('[Loop guard]'))) {
          routingStateRef.current.loopBlocks += 1;
        }
      }
      setActiveTool(undefined);
      toolMsgs.forEach((tm) => onSendMessage(undefined, tm.content, undefined, tm));
      return { asst, toolMsgs, done: false as const };
    }
    const clean = rawContent.replace(/<function[\s\S]*?<\/function>|<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    const asst: ChatMessage = { role: 'assistant', content: clean, thinking: thinking || undefined, timestamp: Date.now(), skill: currentSkill };
    return clean ? (onSendMessage(undefined, clean, thinking || undefined, asst), { done: true as const, content: clean }) : { done: false as const, needsSynthesis: true as const };
  };

  const runAgentLoop = async (initialHistory: ChatMessage[], skillName?: string) => {
    const cfg = loadConfig();
    routingStateRef.current = createOllamaRunRoutingState();
    if (!runModelRef.current) {
      const lastUser = [...initialHistory].reverse().find((m) => m.role === 'user');
      runModelRef.current = await pickModelForRun(lastUser?.content ?? '', registry?.definitions?.()?.length ?? 0);
    }
    loopLedgerRef.current = new ToolCallLedger({ repeatLimit: cfg.toolRepeatLimit });
    const maxTurns = 15;
    let history = initialHistory;
    let autoChains = 0;
    const maxAuto = autoMaxChains();
    try {
      loop: while (true) {
        let currentHistory = history;
        let isDone = false;
        try {
          for (let turn = 0; turn < maxTurns; turn++) {
            if (userCancelledRef.current) { userCancelledRef.current = false; return; }
            const rs = routingStateRef.current;
            if (rs) {
              rs.iterations += 1;
              const explicitModel = cfg.provider.ollama.routingMode === 'auto' ? undefined : selectedModel;
              const mid = maybeEscalateOllamaModel(cfg, rs, runModelRef.current || selectedModel, explicitModel);
              if (mid) {
                runModelRef.current = mid.model;
                show(`Model route: ${mid.model} (${mid.reason})`, 'info', 2800);
              }
            }
            const res = await executeSingleTurn(currentHistory, true, skillName);
            if (res.done) {
              if (res.content && isPrematureStall(res.content)) {
                currentHistory = [
                  ...currentHistory,
                  { role: 'assistant', content: res.content, timestamp: Date.now(), skill: skillName },
                  { role: 'user', content: 'Proceed directly with executing the required tools and commands now without waiting.', timestamp: Date.now() },
                ];
                resetStream('thinking');
                continue;
              }
              isDone = true;
              break;
            }
            if (res.asst && res.toolMsgs) currentHistory = [...currentHistory, res.asst, ...res.toolMsgs];
            resetStream('thinking');
            if (skillName) setActiveSkill(skillName);
          }
          if (!isDone) {
            show('Synthesizing final response...', 'info', 3000); resetStream('thinking');
            if (skillName) setActiveSkill(skillName);
            await executeSingleTurn([...currentHistory, { role: 'user', content: 'Output final comprehensive response in full detail.', timestamp: Date.now() }], false, skillName);
          }
          history = currentHistory;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (userCancelledRef.current) {
            userCancelledRef.current = false;
            return;
          }
          if (/exceed.*context/i.test(msg)) {
            show(autoMode ? 'Context limit — compacting (auto)...' : 'Context limit reached. Compacting & recovering...', 'warning', 3000);
            if (autoMode) {
              history = currentHistory.slice(-4);
              resetStream('thinking');
              continue loop;
            }
            try { await executeSingleTurn(currentHistory.slice(-2), false, skillName); return; } catch {}
            show(`Error: ${msg}`, 'error', 4000); onSendMessage(undefined, `⚠️ Error: ${msg}`);
            return;
          }
          if (/abort/i.test(msg)) {
            show('Stream interrupted (timeout or connection lost)', 'warning', 4000);
            onSendMessage(undefined, '⚠️ Stream interrupted (timeout or connection lost)');
          } else {
            show(`Error: ${msg}`, 'error', 4000); onSendMessage(undefined, `⚠️ Error: ${msg}`);
          }
          return;
        }

        if (isPlanSatisfied()) {
          show('Plan complete — all tasks finished', 'success', 3000);
          break;
        }

        const cont = resolvePendingContinuation(isDone);
        if (!cont) break;

        if (!autoMode) {
          setPendingContinuation(cont);
          break;
        }

        if (autoChains >= maxAuto) {
          show(`Auto mode stopped after ${maxAuto} continuations — confirm to proceed`, 'warning', 4000);
          setPendingContinuation(cont);
          break;
        }

        autoChains += 1;
        show(`Auto [${autoChains}/${maxAuto}]: ${cont.label}`, 'info', 2500);
        if (cont.taskId) {
          try { getTaskRuntime().start(cont.taskId); } catch {}
        }
        onSendMessage(cont.prompt);
        history = [...history, { role: 'user', content: cont.prompt, timestamp: Date.now() }];
        resetStream('thinking');
      }
    } finally { resetStream('idle'); }
  };

  const handleSendMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || !client || phase !== 'idle') return;
    if (pendingContinuation) setPendingContinuation(null);
    abortRef.current?.abort(); setGhostText('');
    const saveEntry = (t: string) => {
      const s = t.trim();
      if (s.length <= 3) return;
      setHistory((prev) => {
        const next = [s, ...prev.filter((i) => i !== s)].slice(0, 500);
        saveHistoryFile(next);
        return next;
      });
    };
    let cmd = trimmed;
    if (trimmed.startsWith('/')) {
      if (trimmed === '/' || !SLASH_COMMANDS.some((c) => c.name === trimmed.split(/\s+/)[0])) {
        const sel = activeMenu[selectedCmdIndex] || activeMenu[0];
        if (sel) { if (sel.args && trimmed === '/') return setInput(sel.name + ' '); cmd = sel.name; }
      }
      saveEntry(cmd); setInput(''); setSelectedCmdIndex(0);
      // Step 5 batch 3: in transcript mode, try the transcript-specific
      // dispatcher first. If it returns false (command not recognized as
      // transcript-specific), fall through to the existing dispatcher so
      // commands like /help, /tools, /mcp, /quit work in both modes.
      if (viewMode === 'transcript' && executeTranscriptSlashCommand(cmd)) return;
      return executeSlashCommand(cmd) ? undefined : (show(`Unknown command: ${cmd}. Type /help for manual`, 'error', 3000), undefined);
    }
    // Step 5 batch 2 fix: route non-slash input through the transcript path
    // when in transcript viewMode. (Original batch 2 wiring only hooked
    // runPrompt, which is invoked by slash commands like /tasks — not by
    // normal Enter-key submit.)
    if (viewMode === 'transcript') {
      saveEntry(trimmed); setInput(''); setSelectedCmdIndex(0);
      await runTranscriptPrompt(trimmed);
      return;
    }
    runModelRef.current = await pickModelForRun(trimmed, registry?.definitions?.()?.length ?? 0);
    const match = matchBestSkill(trimmed);
    if (match) { setActiveSkill(match.name); show(`Matched skill: ${match.name}`, 'info', 2000); }
    saveEntry(trimmed); setInput(''); setScrollOffset(Infinity); onSendMessage(trimmed); resetStream('thinking');
    if (match) setActiveSkill(match.name);
    await runAgentLoop([...messages, { role: 'user', content: trimmed, timestamp: Date.now() }], match?.name);
  };

  const handleArrow = (d: -1 | 1): boolean => !activeMenu.length ? false : (setSelectedCmdIndex((p) => (d === 1 ? (p + 1) % activeMenu.length : p <= 0 ? activeMenu.length - 1 : p - 1)), true);
  const handleTab = (): boolean => {
    const sel = activeMenu[selectedCmdIndex] || activeMenu[0];
    if (sel) { setInput(sel.name.includes(' ') || !sel.args ? sel.name : sel.name + ' '); setSelectedCmdIndex(0); return true; }
    return input === '' ? (setFocus(1), true) : false;
  };
  // Mouse equivalent of Tab+Enter on a suggestion row: slash commands with
  // arguments fill the input for completion, everything else runs at once.
  const runMenuCommand = (c: { name: string; args?: string }) => {
    if (c.name.startsWith('/') && c.args) {
      setInput(c.name.includes(' ') ? c.name : `${c.name} `);
      setSelectedCmdIndex(0); setFocus(0);
      return;
    }
    setInput(''); setSelectedCmdIndex(0);
    void handleSendMessage(c.name);
  };

  const maxWidth = Math.max(20, columns - 8);
  const messageRows = useMemo(() => {
    const rows: React.ReactElement[] = [];
    const cache = turnCacheRef.current;
    // Prune entries for messages that left the transcript (/clear, compaction).
    if (cache.size > messages.length + 64) {
      const alive = new Set(messages);
      for (const k of cache.keys()) if (!alive.has(k)) cache.delete(k);
    }
    messages.forEach((msg, mi) => {
      const clickableToolCalls = !collapsedTurns.has(mi) && (msg.tool_calls?.length ?? 0) > 0;
      // Cache key: layout inputs + this turn's view flags + tool-call
      // expansion bits. Completed turns keep the same message object
      // identity across stream flushes, so they hit the cache and only the
      // active turn rebuilds per 40ms flush.
      const toolBits = (msg.tool_calls ?? []).map((_: any, tci: number) => (expandedToolCallKeys.has(`${mi}:${tci}`) ? 1 : 0)).join('');
      const key = `${maxWidth}|${expandThinking || expandedThinkingTurns.has(mi) ? 1 : 0}|${collapsedTurns.has(mi) ? 1 : 0}|${toolBits}`;
      const cached = cache.get(msg);
      if (cached && cached.key === key) { rows.push(...cached.rows); return; }
      const built = renderSingleTurn(msg, mi, {
        theme,
        maxWidth,
        expandThinking: expandThinking || expandedThinkingTurns.has(mi),
        collapsed: collapsedTurns.has(mi),
        onToggleCollapse: () => toggleTurnCollapse(mi),
        onToggleThinking: () => toggleTurnThinking(mi),
        onToggleToolCall: clickableToolCalls ? (tci: number) => toggleToolCallExpanded(`${mi}:${tci}`) : undefined,
        isToolCallExpanded: clickableToolCalls ? (tci: number) => expandedToolCallKeys.has(`${mi}:${tci}`) : undefined,
      });
      if (cache.size > 512) cache.clear();
      cache.set(msg, { key, rows: built });
      rows.push(...built);
    });
    if (phase !== 'idle') {
      if (messages.length > 0) rows.push(<Box key="st-gap"><Text>{' '}</Text></Box>);
      rows.push(...renderStreamingRows({ phase, model: selectedModel, thinking: streamedThinking, content: streamedContent, activeTool, activeSkill }, { theme, maxWidth, expandThinking }));
    }
    return rows;
  }, [messages, phase, streamedThinking, streamedContent, selectedModel, theme, maxWidth, expandThinking, activeTool, activeSkill, collapsedTurns, expandedThinkingTurns, expandedToolCallKeys]);

  const totalRows = scrollInfo.total || messageRows.length;
  const maxScrollOffset = Math.max(0, totalRows - chatHeight);
  const rowsBelow = Math.max(0, totalRows - chatHeight - Math.min(scrollInfo.offset, maxScrollOffset));
  const menuStart = Math.min(Math.max(0, selectedCmdIndex - 1), Math.max(0, activeMenu.length - 4));
  const visibleCommands = activeMenu.slice(menuStart, menuStart + 4);

  const reversedHistory = useMemo(() => [...history].reverse(), [history]);
  const textInputNode = (
    <TextInput
      value={input} onChange={(v) => { setInput(v); if (dismissedInput && dismissedInput !== v) setDismissedInput(''); }}
      onSubmit={handleSendMessage} onUpArrow={() => handleArrow(-1)} onDownArrow={() => handleArrow(1)}
      onPageUp={() => (setScrollOffset((p) => Math.max(0, p - 6)), true)} onPageDown={() => (setScrollOffset((p) => Math.min(maxScrollOffset, p + 6)), true)}
      onTab={handleTab} onEscape={() => activeMenu.length > 0 ? (setDismissedInput(input), true) : input.startsWith('/') ? (setInput(''), setSelectedCmdIndex(0), true) : false}
      history={reversedHistory} focus={isActive && !isSelectingModel && isInputFocused} theme={theme}
      placeholder={isChatFocused ? 'Chat scroll focused — Press Tab or Esc to type...' : phase === 'thinking' ? '⚡ Thinking... [Esc stop]' : phase === 'executing-tools' ? '🔧 Running tools...' : phase === 'responding' ? 'Streaming... [Esc stop]' : 'Type prompt or /command...'}
      disabled={phase !== 'idle'} showCounter={true} suggestions={activeMenu[selectedCmdIndex] ? [activeMenu[selectedCmdIndex]!.name, ...promptPool] : promptPool} ghostText={ghostText}
      onCancel={() => {
        if (phase !== 'idle') {
          userCancelledRef.current = true;
          chatAbortRef.current?.abort();
          resetStream('idle');
          show('Cancelled', 'warning', 2000);
        }
      }}
    />
  );

  return (
    <Box flexDirection="column" width={columns}>
      <Box paddingX={1} width={columns}>
        {messages.length === 0 ? (
          <Box height={chatHeight} width="100%" flexDirection="column" alignItems="center" justifyContent="center">
            <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column" alignItems="center" width={Math.min(74, columns - 4)}>
              <Box flexDirection="row" gap={1}><Text bold color="cyan">⚡ AGENTIC HARNESS</Text><Text color="gray">│ <Text color="white" bold>Autonomous Agent Cockpit</Text></Text></Box>
              <Text color="gray">Model: <Text color="cyan" bold>{selectedModel}</Text> • <Text color="green">● MCP Active</Text></Text>
              <Text color="gray"><Text color="yellow">❯ </Text>Type prompt to reason & tools • <Text color="cyan">/model</Text> switch • <Text color="cyan">/skills</Text> load</Text>
              {autoMode && <Text color="green">Auto mode — continues through plan steps without Y/N prompts</Text>}
              <Text color="gray" dimColor>[Tab Autocomplete • Ctrl+O Model • Ctrl+T View • Ctrl+A: Stream/Accordion/Transcript]</Text>
            </Box>
          </Box>
        ) : viewMode === 'accordion' ? (
          <ChatAccordion messages={messages} height={chatHeight} width={columns - 4} focus={isActive && isChatFocused} theme={theme} />
        ) : viewMode === 'transcript' ? (
          <TranscriptView events={transcriptState.events} height={chatHeight} isActive={isActive && isChatFocused} width={columns} />
        ) : (
          <Box width="100%" onClick={() => { if (!isChatFocused) setFocus(1); }}>
            <ScrollArea
              height={chatHeight} width="100%" scrollOffset={scrollOffset}
              onScrollOffsetChange={setScrollOffset}
              onScroll={(o, t) => setScrollInfo({ offset: o, total: t })}
              focus={isActive && isChatFocused} autoScroll={true} theme={theme}
            >
              {messageRows}
            </ScrollArea>
          </Box>
        )}
      </Box>

      {toasts.length > 0 && <Box flexDirection="column" paddingX={1} width={columns}><Text>{' '}</Text><ToastStack toasts={toasts.slice(-1)} onDismiss={dismiss} theme={theme} /></Box>}

      {activeMenu.length > 0 && (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" width={columns} height={7}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color="cyan">⚡ Suggestions & Commands</Text>
            <Text color="gray" dimColor>↑/↓ Nav • Tab Select • Enter Run • Click runs ({selectedCmdIndex + 1}/{activeMenu.length})</Text>
          </Box>
          {visibleCommands.map((c) => (
            <Box key={c.name} flexDirection="row" gap={1} onClick={() => runMenuCommand(c)}>
              <Text bold color={c === activeMenu[selectedCmdIndex] ? 'cyan' : 'yellow'} inverse={c === activeMenu[selectedCmdIndex]}>{c === activeMenu[selectedCmdIndex] ? '❯ ' : '  '}{c.name}</Text>
              {c.args && <Text color={c === activeMenu[selectedCmdIndex] ? 'white' : 'gray'}>{c.args}</Text>}
              <Text color="gray" dimColor={c !== activeMenu[selectedCmdIndex]}>— {c.desc}</Text>
            </Box>
          ))}
        </Box>
      )}

      {pendingContinuation && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column" width={columns}>
          <Box flexDirection="row" gap={1}>
            <Text bold color="yellow">⚡ Plan Continuation</Text>
            <Text color="gray">│</Text>
            <Text bold color="white">{pendingContinuation.label}</Text>
          </Box>
          {pendingContinuation.detail && <Text color="gray" dimColor>{pendingContinuation.detail}</Text>}
          <Box flexDirection="row" gap={2} marginTop={1} alignItems="center">
            <Box onClick={acceptContinuation} borderStyle="round" borderColor="green" paddingX={1}>
              <Text color="green" bold>▶ Continue with task</Text>
            </Box>
            <Box onClick={pauseContinuation} borderStyle="round" borderColor="red" paddingX={1}>
              <Text color="red" bold>⏸ Pause</Text>
            </Box>
            <Text color="gray" dimColor>or press Y / N</Text>
          </Box>
        </Box>
      )}

      {inputStyle === 'box' ? (
        <Box onClick={() => { if (!isInputFocused) setFocus(0); }} borderStyle="round" borderColor={isInputFocused ? (theme?.colors?.focus ?? 'cyan') : (theme?.colors?.border ?? 'gray')} paddingX={1} width={columns}>{textInputNode}</Box>
      ) : (
        <Box flexDirection="column" width={columns} onClick={() => { if (!isInputFocused) setFocus(0); }}>
          <Divider width={columns} theme={theme} color={isInputFocused ? (theme?.colors?.focus ?? 'cyan') : undefined} />
          <Box paddingX={1} width={columns}>{textInputNode}</Box>
          <Divider width={columns} theme={theme} color={isInputFocused ? (theme?.colors?.focus ?? 'cyan') : undefined} />
        </Box>
      )}

      <Box paddingX={1} width={columns} flexDirection="row" justifyContent="space-between">
        <Text color="gray" dimColor>{isChatFocused ? '↑/↓ Scroll • Wheel works anywhere • Esc/Tab Type' : `PgUp/PgDn Scroll • Tab/→ Complete • Ctrl+→ Word • ↑/↓ History • Ctrl+B Style [${inputStyle}]`}</Text>
        <Box flexDirection="row" gap={1}>
          {viewMode === 'stream' && scrollInfo.offset > 0 && (
            <Box onClick={() => setScrollOffset(0)}><Text color="yellow">▲ Top</Text></Box>
          )}
          {viewMode === 'stream' && rowsBelow > 0 && (
            <Box onClick={() => setScrollOffset(maxScrollOffset)}><Text color="green" bold>▼ {rowsBelow} below — Jump to latest</Text></Box>
          )}
          {viewMode === 'stream' && rowsBelow === 0 && scrollInfo.offset > 0 && maxScrollOffset > 0 && (
            <Box onClick={() => setScrollOffset(maxScrollOffset)}><Text color="yellow">▼ Bottom</Text></Box>
          )}
          {viewMode === 'accordion' && <Text color="cyan">[Accordion]</Text>}
          {viewMode === 'transcript' && <Text color="green">[Transcript · {transcriptState.events.length} events{phase !== 'idle' ? ' · streaming' : ''}]</Text>}
        </Box>
      </Box>
    </Box>
  );
};

export default Chat;