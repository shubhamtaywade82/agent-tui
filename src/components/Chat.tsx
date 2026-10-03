import React, { useState, useEffect, useMemo } from 'react';
import { existsSync, readFileSync, writeFileSync } from 'fs'; import { Box, Text, useInput } from 'ink';
import { TextInput } from './ui/text-input/index.js'; import { Divider } from './ui/divider/index.js';
import { OllamaClient, Message } from '@nemesis-oss/ollama-sdk'; import { ToastStack, useToast } from './ui/toast/index.js'; import { ScrollArea } from './ui/scroll-area/index.js';
import { useFocusManager, useTerminalSize } from './ui/hooks/index.js';
import { getActiveToolRegistry, consumeStream, dispatchSlashCommand, SLASH_COMMANDS, executeMcpCalls, loadAvailableSkills, loadUserConfig, saveUserConfig, matchBestSkill, findSkillFile } from '../tools.js';
import { ChatAccordion, renderSingleTurn, renderStreamingRows, parseTextToolCalls } from './ChatAccordion.js';
import { budgetMessages } from '../utils/context.js';

export interface ChatMessage extends Message { timestamp?: number; thinking?: string; tokens?: number; skill?: string; }

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

const DEFAULT_SYSTEM_PROMPT = `You are an expert AI assistant. Workspace: ${process.cwd()}. Use run_shell to execute shell/terminal commands (e.g. rails new, bundle, npm, git). Use filesystem tools when reading or writing files. Execute tools directly without stalling or narrating future steps.`;
const prepareMessages = (h: ChatMessage[], skillName?: string): ChatMessage[] => {
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
  return budgetMessages(h.some((m) => m.role === 'system') ? h : [{ role: 'system', content: prompt, timestamp: Date.now() }, ...h], 9000);
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

interface ChatProps {
  client: OllamaClient | null; messages: ChatMessage[]; theme?: any; isActive?: boolean;
  onSendMessage: (u?: string, a?: string, t?: string, x?: Partial<ChatMessage>) => void; setMessages?: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  models?: string[]; isConnected?: boolean; columns?: number; rows?: number; selectedModel?: string; onSelectModel?: (m: string) => void;
  isSelectingModel?: boolean; onOpenModal?: (m: 'model' | 'clear' | 'skills') => void;
}

const Chat: React.FC<ChatProps> = ({
  client, messages, onSendMessage, setMessages, models = [], theme, isActive = true,
  columns: propCols, rows: propRows, selectedModel: propModel, isSelectingModel = false, onSelectModel, onOpenModal,
}) => {
  const [input, setInput] = useState(''); const [selectedCmdIndex, setSelectedCmdIndex] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'responding' | 'executing-tools'>('idle');
  const [activeTool, setActiveTool] = useState<{ name: string; args?: any } | undefined>();
  const [activeSkill, setActiveSkill] = useState<string | undefined>();
  const [streamedThinking, setStreamedThinking] = useState(''); const [streamedContent, setStreamedContent] = useState('');
  const [viewMode, setViewMode] = useState<'stream' | 'accordion'>('stream'); const [expandThinking, setExpandThinking] = useState(false);
  const [registry, setRegistry] = useState<any>(null); const [scrollOffset, setScrollOffset] = useState(0);
  const [inputStyle, setInputStyle] = useState<'box' | 'line'>(() => loadUserConfig().inputStyle || 'line');
  const selectedModel = propModel || models[0] || 'qwen3:8b'; const { toasts, show, dismiss } = useToast();

  const term = useTerminalSize(); const columns = propCols ?? term.columns; const rows = propRows ?? term.rows;
  const { isFocused, setFocus } = useFocusManager({ count: 2, initialIndex: 0, nextKey: 'none', prevKey: 'none' });
  const isInputFocused = isFocused(0); const isChatFocused = isFocused(1);
  const [history, setHistory] = useState<string[]>(() => {
    const userMsgs = [...messages].reverse().filter((m) => m.role === 'user' && m.content.trim()).map((m) => m.content.trim());
    return filterValidHistory([...userMsgs, ...loadHistory()]);
  });
  const [ghostText, setGhostText] = useState(''); const [dismissedInput, setDismissedInput] = useState('');
  const lastReq = React.useRef(0); const abortRef = React.useRef<AbortController | null>(null);

  const promptPool = useMemo(() => Array.from(new Set([...history.filter((h) => !h.startsWith('/')), ...DEFAULT_PROMPTS])), [history]);
  const activeMenu = useMemo(() => dismissedInput === input ? [] : getMenuOptions(input, models, ghostText, promptPool), [input, models, ghostText, promptPool, dismissedInput]);
  const menuOverhead = activeMenu.length > 0 ? 7 : 0; const chatHeight = Math.max(3, rows - 7 - menuOverhead - (toasts.length > 0 ? 2 : 0));

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

  useInput((inp, key) => {
    if (!isActive || isSelectingModel) return;
    if (key.ctrl && (inp === 'a' || inp === '\x01')) return setViewMode((v) => (v === 'stream' ? 'accordion' : 'stream'));
    if (key.ctrl && (inp === 'b' || inp === '\x02')) return toggleStyle();
    if (inp === 't' && isChatFocused) return setExpandThinking((p) => !p);
    if ((key.escape || key.tab) && isChatFocused) setFocus(0);
  });

  const resetStream = (p: typeof phase = 'idle') => {
    setPhase(p); setStreamedThinking(''); setStreamedContent(''); setActiveTool(undefined);
    if (p === 'idle') setActiveSkill(undefined);
  };

  const runPrompt = async (text: string) => {
    if (phase !== 'idle') { show('Agent is busy; try again once it finishes', 'warning', 2500); return; }
    const match = matchBestSkill(text);
    if (match) { setActiveSkill(match.name); show(`Matched skill: ${match.name}`, 'info', 2000); }
    onSendMessage(text); resetStream('thinking');
    if (match) setActiveSkill(match.name);
    await runAgentLoop([...messages, { role: 'user', content: text, timestamp: Date.now() }], match?.name);
  };

  const executeSlashCommand = (cmd: string): boolean => {
    if (cmd === '/accordion') return (setViewMode((v) => (v === 'stream' ? 'accordion' : 'stream')), true);
    if (cmd.startsWith('/style')) { const a = cmd.split(/\s+/)[1]; toggleStyle(a === 'box' || a === 'line' ? a : undefined); return true; }
    return dispatchSlashCommand(cmd, {
      messages, model: selectedModel, setModel: onSelectModel, models, showToast: show, registry,
      clearMessages: () => onSendMessage('/clear'), setMessages: setMessages ?? (() => {}),
      addSystemCard: (t) => onSendMessage(undefined, t, undefined, { role: 'system', content: t, timestamp: Date.now() }), openModal: onOpenModal,
      runPrompt: (text) => { void runPrompt(text); },
    });
  };

  const executeSingleTurn = async (chatHistory: ChatMessage[], allowTools = true, currentSkill?: string) => {
    const reg = registry || await getActiveToolRegistry();
    if (!registry && reg) setRegistry(reg);
    const stream = await client!.chatStream({
      model: selectedModel, messages: prepareMessages(chatHistory, currentSkill),
      think: 'high', tools: (allowTools && reg) ? reg.definitions() : undefined, options: { temperature: 0.7, num_ctx: 16384 }, timeoutMs: 120000,
    });
    const { thinking, content } = await consumeStream(stream, (d) => setStreamedThinking((p) => p + d), (d) => { setPhase('responding'); setStreamedContent((p) => p + d); });
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
      const toolMsgs = await executeMcpCalls(reg, toolCalls);
      setActiveTool(undefined);
      toolMsgs.forEach((tm) => onSendMessage(undefined, tm.content, undefined, tm));
      return { asst, toolMsgs, done: false as const };
    }
    const clean = rawContent.replace(/<function[\s\S]*?<\/function>|<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    const asst: ChatMessage = { role: 'assistant', content: clean, thinking: thinking || undefined, timestamp: Date.now(), skill: currentSkill };
    return clean ? (onSendMessage(undefined, clean, thinking || undefined, asst), { done: true as const, content: clean }) : { done: false as const, needsSynthesis: true as const };
  };

  const runAgentLoop = async (initialHistory: ChatMessage[], skillName?: string) => {
    let currentHistory = initialHistory; let isDone = false;
    const maxTurns = 15;
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/exceed.*context/i.test(msg)) {
        show('Context limit reached. Compacting & recovering...', 'warning', 3000);
        try { await executeSingleTurn(prepareMessages(currentHistory.slice(-2), skillName), false, skillName); return; } catch {}
      }
      show(`Error: ${msg}`, 'error', 4000); onSendMessage(undefined, `⚠️ Error: ${msg}`);
    } finally { resetStream('idle'); }
  };

  const handleSendMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || !client || phase !== 'idle') return;
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
      return executeSlashCommand(cmd) ? undefined : (show(`Unknown command: ${cmd}. Type /help for manual`, 'error', 3000), undefined);
    }
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

  const maxWidth = Math.max(20, columns - 8);
  const messageRows = useMemo(() => {
    const opts = { theme, maxWidth, expandThinking }; const rows = messages.flatMap((msg, mi) => renderSingleTurn(msg, mi, opts));
    if (phase !== 'idle') {
      if (messages.length > 0) rows.push(<Box key="st-gap"><Text>{' '}</Text></Box>);
      rows.push(...renderStreamingRows({ phase, model: selectedModel, thinking: streamedThinking, content: streamedContent, activeTool, activeSkill }, opts));
    }
    return rows;
  }, [messages, phase, streamedThinking, streamedContent, selectedModel, theme, maxWidth, expandThinking, activeTool, activeSkill]);

  const maxScrollOffset = Math.max(0, messageRows.length - chatHeight);
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
      onCancel={() => { if (phase !== 'idle') { resetStream('idle'); show('Cancelled', 'warning', 2000); } }}
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
              <Text color="gray" dimColor>[Tab Autocomplete • Ctrl+O Model • Ctrl+T View • Ctrl+A Accordion]</Text>
            </Box>
          </Box>
        ) : viewMode === 'accordion' ? (
          <ChatAccordion messages={messages} height={chatHeight} width={columns - 4} focus={isActive && isChatFocused} theme={theme} />
        ) : (
          <ScrollArea height={chatHeight} width="100%" scrollOffset={scrollOffset} onScrollOffsetChange={setScrollOffset} focus={isActive && isChatFocused} autoScroll={true} theme={theme}>{messageRows}</ScrollArea>
        )}
      </Box>

      {toasts.length > 0 && <Box flexDirection="column" paddingX={1} width={columns}><Text>{' '}</Text><ToastStack toasts={toasts.slice(-1)} onDismiss={dismiss} theme={theme} /></Box>}

      {activeMenu.length > 0 && (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" width={columns} height={7}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color="cyan">⚡ Suggestions & Commands</Text>
            <Text color="gray" dimColor>↑/↓ Nav • Tab Select • Enter Run • Esc Close ({selectedCmdIndex + 1}/{activeMenu.length})</Text>
          </Box>
          {visibleCommands.map((c) => (
            <Box key={c.name} flexDirection="row" gap={1}>
              <Text bold color={c === activeMenu[selectedCmdIndex] ? 'cyan' : 'yellow'} inverse={c === activeMenu[selectedCmdIndex]}>{c === activeMenu[selectedCmdIndex] ? '❯ ' : '  '}{c.name}</Text>
              {c.args && <Text color={c === activeMenu[selectedCmdIndex] ? 'white' : 'gray'}>{c.args}</Text>}
              <Text color="gray" dimColor={c !== activeMenu[selectedCmdIndex]}>— {c.desc}</Text>
            </Box>
          ))}
        </Box>
      )}

      {inputStyle === 'box' ? (
        <Box borderStyle="round" borderColor={isInputFocused ? (theme?.colors?.focus ?? 'cyan') : (theme?.colors?.border ?? 'gray')} paddingX={1} width={columns}>{textInputNode}</Box>
      ) : (
        <Box flexDirection="column" width={columns}>
          <Divider width={columns} theme={theme} color={isInputFocused ? (theme?.colors?.focus ?? 'cyan') : undefined} />
          <Box paddingX={1} width={columns}>{textInputNode}</Box>
          <Divider width={columns} theme={theme} color={isInputFocused ? (theme?.colors?.focus ?? 'cyan') : undefined} />
        </Box>
      )}

      <Box paddingX={1} width={columns} flexDirection="row" justifyContent="space-between">
        <Text color="gray" dimColor>{isChatFocused ? '↑/↓ Scroll • Esc/Tab Type' : `PgUp/PgDn Scroll • Tab/→ Complete • Ctrl+→ Word • ↑/↓ History • Ctrl+B Style [${inputStyle}]`}</Text>
        <Box flexDirection="row" gap={1}>
          {viewMode === 'stream' && scrollOffset > 0 && <Text color="yellow">▲ Above (PgUp)</Text>}{viewMode === 'stream' && scrollOffset < maxScrollOffset && <Text color="yellow">▼ Below (PgDn)</Text>}
          {viewMode === 'accordion' && <Text color="cyan">[Accordion]</Text>}
        </Box>
      </Box>
    </Box>
  );
};

export default Chat;