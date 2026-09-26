import React, { useState, useEffect, useMemo } from 'react';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './ui/text-input/index.js';
import { Divider } from './ui/divider/index.js';
import { OllamaClient, Message } from '@nemesis-oss/ollama-sdk';
import { ToastStack, useToast } from './ui/toast/index.js';
import { ScrollArea } from './ui/scroll-area/index.js';
import { useFocusManager, useTerminalSize } from './ui/hooks/index.js';
import { getActiveToolRegistry, consumeStream, dispatchSlashCommand, SLASH_COMMANDS, executeMcpCalls, loadAvailableSkills, loadUserConfig, saveUserConfig } from '../tools.js';
import { ChatAccordion, renderSingleTurn, renderStreamingRows, parseTextToolCalls } from './ChatAccordion.js';

export interface ChatMessage extends Message { timestamp?: number; thinking?: string; tokens?: number; }

const HISTORY_FILE = '.history'; const MAX_HISTORY = 500;
const loadLocalHistory = (): string[] => {
  if (!existsSync(HISTORY_FILE)) return [];
  try { return readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean).slice(-MAX_HISTORY).map((l) => { try { return JSON.parse(l); } catch { return l; } }); } catch { return []; }
};
const appendLocalHistory = (p: string) => { try { appendFileSync(HISTORY_FILE, JSON.stringify(p) + '\n', 'utf-8'); } catch {} };

const DEFAULT_SYSTEM_PROMPT =
  `You are an expert AI assistant. Workspace: ${process.cwd()}. Use ruby-agent-skills via list_skills/read_skill and filesystem MCP tools when inspecting files.`;

const prepareMessages = (h: ChatMessage[]): ChatMessage[] =>
  h.some((m) => m.role === 'system') ? h : [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT, timestamp: Date.now() }, ...h];

const isPrematureStall = (t: string): boolean => t.length <= 250 && /then i('ll| will)|(let me|i will) check/i.test(t);

const DEFAULT_PROMPTS = ['Create a Guide on Ruby OOPs', 'Explain architecture', 'Explore ruby-agent-skills', 'Refactor for KISS', 'Write unit tests'];

function getMenuOptions(input: string, models: string[]): Array<{ name: string; args?: string; desc: string }> {
  if (!input.startsWith('/')) return [];
  const low = input.toLowerCase();
  if (!input.includes(' ')) return SLASH_COMMANDS.filter((c) => c.name.startsWith(low));
  if (input.startsWith('/model ')) return models.filter((m) => m.toLowerCase().includes(input.slice(7).toLowerCase())).map((m) => ({ name: `/model ${m}`, desc: `Switch to ${m}` }));
  if (input.startsWith('/skills ')) return loadAvailableSkills().filter((s) => s.name.includes(input.slice(8).toLowerCase())).slice(0, 10).map((s) => ({ name: `/skills ${s.name}`, desc: `${s.family}: ${s.triggers.slice(0, 24) || 'standard'}` }));
  if (input.startsWith('/save ')) return ['chat.md', 'transcript.md'].filter((f) => f.includes(input.slice(6))).map((f) => ({ name: `/save ${f}`, desc: 'Save transcript' }));
  if (input.startsWith('/style ')) return ['box', 'line'].filter((s) => s.startsWith(input.slice(7))).map((s) => ({ name: `/style ${s}`, desc: `Switch input style to ${s}` }));
  return [];
}

interface ChatProps {
  client: OllamaClient | null; messages: ChatMessage[]; theme?: any; isActive?: boolean;
  onSendMessage: (u?: string, a?: string, t?: string, x?: Partial<ChatMessage>) => void;
  setMessages?: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  models?: string[]; isConnected?: boolean; columns?: number; rows?: number;
  selectedModel?: string; onSelectModel?: (m: string) => void;
  isSelectingModel?: boolean; onOpenModal?: (m: 'model' | 'clear' | 'skills') => void;
}

const Chat: React.FC<ChatProps> = ({
  client, messages, onSendMessage, setMessages, models = [], theme, isActive = true,
  columns: propCols, rows: propRows, selectedModel: propModel, isSelectingModel = false, onSelectModel, onOpenModal,
}) => {
  const [input, setInput] = useState(''); const [selectedCmdIndex, setSelectedCmdIndex] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'responding' | 'executing-tools'>('idle');
  const [streamedThinking, setStreamedThinking] = useState(''); const [streamedContent, setStreamedContent] = useState('');
  const [viewMode, setViewMode] = useState<'stream' | 'accordion'>('stream'); const [expandThinking, setExpandThinking] = useState(false);
  const [registry, setRegistry] = useState<any>(null); const [scrollOffset, setScrollOffset] = useState(0);
  const [inputStyle, setInputStyle] = useState<'box' | 'line'>(() => loadUserConfig().inputStyle || 'line');
  const selectedModel = propModel || models[0] || 'qwen3:8b'; const { toasts, show, dismiss } = useToast();

  const termSize = useTerminalSize();
  const columns = propCols ?? termSize.columns; const rows = propRows ?? termSize.rows;
  const { isFocused, setFocus } = useFocusManager({ count: 2, initialIndex: 0, nextKey: 'none', prevKey: 'none' });
  const isInputFocused = isFocused(0); const isChatFocused = isFocused(1);
  const [history, setHistory] = useState<string[]>(() => Array.from(new Set([...loadLocalHistory(), ...messages.filter((m) => m.role === 'user' && m.content.trim()).map((m) => m.content.trim())])));

  const activeMenu = useMemo(() => getMenuOptions(input, models), [input, models]);
  const promptSuggestions = useMemo(() => {
    if (!input.startsWith('/')) return Array.from(new Set([...history.filter((h) => !h.startsWith('/')), ...DEFAULT_PROMPTS])).reverse();
    return activeMenu.length > 0 ? activeMenu.map((m) => m.name) : SLASH_COMMANDS.map((c) => c.name);
  }, [input, activeMenu, history]);
  const menuOverhead = activeMenu.length > 0 ? Math.min(activeMenu.length, 4) + 2 : 0;
  const chatHeight = Math.max(3, rows - 7 - menuOverhead - (toasts.length > 0 ? 1 : 0));

  useEffect(() => { setSelectedCmdIndex(0); }, [input]);
  useEffect(() => { getActiveToolRegistry().then(setRegistry).catch(() => undefined); }, []);

  const toggleStyle = (target?: 'box' | 'line') => {
    const next = target || (inputStyle === 'box' ? 'line' : 'box');
    setInputStyle(next); saveUserConfig({ inputStyle: next }); show(`Input style: ${next}`, 'info', 1500);
  };

  useInput((inp, key) => {
    if (!isActive || isSelectingModel) return;
    if (key.ctrl && (inp === 'a' || inp === '\x01')) setViewMode((v) => (v === 'stream' ? 'accordion' : 'stream'));
    else if (key.ctrl && (inp === 'b' || inp === '\x02')) toggleStyle();
    else if (inp === 't' && isChatFocused) setExpandThinking((p) => !p);
    else if ((key.escape || key.tab) && isChatFocused) setFocus(0);
  });

  const resetStream = (p: typeof phase = 'idle') => { setPhase(p); setStreamedThinking(''); setStreamedContent(''); };

  const executeSlashCommand = (cmd: string): boolean => {
    if (cmd === '/accordion') { setViewMode((v) => (v === 'stream' ? 'accordion' : 'stream')); return true; }
    if (cmd.startsWith('/style')) {
      const a = cmd.split(/\s+/)[1];
      toggleStyle(a === 'box' || a === 'line' ? a : undefined); return true;
    }
    return dispatchSlashCommand(cmd, {
      messages, model: selectedModel, setModel: onSelectModel, models, showToast: show, registry,
      clearMessages: () => onSendMessage('/clear'), setMessages: setMessages ?? (() => {}),
      addSystemCard: (text) => onSendMessage(undefined, text, undefined, { role: 'system', content: text, timestamp: Date.now() }),
      openModal: onOpenModal,
    });
  };

  const executeSingleTurn = async (chatHistory: ChatMessage[], allowTools = true) => {
    const reg = registry || await getActiveToolRegistry();
    if (!registry && reg) setRegistry(reg);
    const stream = await client!.chatStream({
      model: selectedModel, messages: prepareMessages(chatHistory),
      think: 'high', tools: (allowTools && reg) ? reg.definitions() : undefined, options: { temperature: 0.7, num_ctx: 16384 },
    });
    const { thinking, content } = await consumeStream(stream, (d) => setStreamedThinking((p) => p + d), (d) => { setPhase('responding'); setStreamedContent((p) => p + d); });
    const final = await stream.finalResult;
    let toolCalls = final.message?.tool_calls;
    let rawContent = final.message?.content || content;
    if ((!toolCalls || !toolCalls.length) && rawContent) {
      const parsed = parseTextToolCalls(rawContent);
      if (parsed.length) { toolCalls = parsed; rawContent = rawContent.replace(/<function[\s\S]*?<\/function>|<tool_call>[\s\S]*?<\/tool_call>/g, '').trim(); }
    }
    if (allowTools && toolCalls?.length && reg) {
      const asst: ChatMessage = { role: 'assistant', content: rawContent, thinking: thinking || undefined, tool_calls: toolCalls, timestamp: Date.now() };
      onSendMessage(undefined, asst.content, asst.thinking, asst);
      setPhase('executing-tools');
      show(`Executing: ${toolCalls.map((tc: any) => tc.function?.name || 'tool').join(', ')}...`, 'info', 2500);
      const toolMsgs = await executeMcpCalls(reg, toolCalls);
      toolMsgs.forEach((tm) => onSendMessage(undefined, tm.content, undefined, tm));
      return { asst, toolMsgs, done: false as const };
    }
    const clean = rawContent.replace(/<function[\s\S]*?<\/function>|<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    if (clean) { onSendMessage(undefined, clean, thinking || undefined); return { done: true as const, content: clean }; }
    return { done: false as const, needsSynthesis: true as const };
  };

  const runAgentLoop = async (initialHistory: ChatMessage[]) => {
    let currentHistory = initialHistory;
    let isDone = false;
    try {
      for (let turn = 0; turn < 5; turn++) {
        const res = await executeSingleTurn(currentHistory, true);
        if (res.done) {
          if (res.content && isPrematureStall(res.content)) currentHistory = [...currentHistory, { role: 'assistant', content: res.content, timestamp: Date.now() }];
          else isDone = true;
          break;
        }
        if (res.asst && res.toolMsgs) currentHistory = [...currentHistory, res.asst, ...res.toolMsgs];
        resetStream('thinking');
      }
      if (!isDone) {
        show('Synthesizing final response...', 'info', 3000); resetStream('thinking');
        const synth: ChatMessage = { role: 'user', content: 'You have finished exploring. Now output the complete, comprehensive response to the original user request in full detail. Do not mention checking or searching further.', timestamp: Date.now() };
        await executeSingleTurn([...currentHistory, synth], false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      show(`Error: ${msg}`, 'error', 4000); onSendMessage(undefined, `⚠️ Error: ${msg}`);
    } finally { resetStream('idle'); }
  };

  const handleSendMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || !client || phase !== 'idle') return;
    if (trimmed.startsWith('/')) {
      let cmd = trimmed;
      if (trimmed === '/' || !SLASH_COMMANDS.some((c) => c.name === trimmed.split(/\s+/)[0])) {
        const sel = activeMenu[selectedCmdIndex] || activeMenu[0];
        if (sel) { if (sel.args && trimmed === '/') { setInput(sel.name + ' '); return; } cmd = sel.name; }
      }
      setHistory((prev) => (prev[prev.length - 1] === cmd ? prev : [...prev, cmd]));
      appendLocalHistory(cmd); setInput(''); setSelectedCmdIndex(0);
      if (!executeSlashCommand(cmd)) show(`Unknown command: ${cmd}. Type /help for manual`, 'error', 3000);
      return;
    }
    setHistory((prev) => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    appendLocalHistory(trimmed); setInput(''); setScrollOffset(Infinity);
    onSendMessage(trimmed); resetStream('thinking');
    await runAgentLoop([...messages, { role: 'user', content: trimmed, timestamp: Date.now() }]);
  };

  const handleArrow = (d: -1 | 1): boolean => {
    if (!activeMenu.length) return false;
    setSelectedCmdIndex((p) => (d === 1 ? (p + 1) % activeMenu.length : p <= 0 ? activeMenu.length - 1 : p - 1));
    return true;
  };
  const handleTab = (): boolean => {
    if (activeMenu.length > 0) {
      const sel = activeMenu[selectedCmdIndex] || activeMenu[0];
      if (sel) { setInput(sel.name.includes(' ') || !sel.args ? sel.name : sel.name + ' '); setSelectedCmdIndex(0); return true; }
    }
    if (input === '') { setFocus(1); return true; }
    return false;
  };

  const maxWidth = Math.max(20, columns - 8);
  const messageRows = useMemo(() => {
    const opts = { theme, maxWidth, expandThinking };
    const rows = messages.flatMap((msg, mi) => renderSingleTurn(msg, mi, opts));
    if (phase !== 'idle') {
      if (messages.length > 0) rows.push(<Box key="st-gap"><Text>{' '}</Text></Box>);
      rows.push(...renderStreamingRows({ phase, model: selectedModel, thinking: streamedThinking, content: streamedContent }, opts));
    }
    return rows;
  }, [messages, phase, streamedThinking, streamedContent, selectedModel, theme, maxWidth, expandThinking]);

  const maxScrollOffset = Math.max(0, messageRows.length - chatHeight);
  const menuStart = Math.min(Math.max(0, selectedCmdIndex - 1), Math.max(0, activeMenu.length - 4));
  const visibleCommands = activeMenu.slice(menuStart, menuStart + 4);

  const textInputNode = (
    <TextInput
      value={input} onChange={setInput} onSubmit={handleSendMessage}
      onUpArrow={() => handleArrow(-1)} onDownArrow={() => handleArrow(1)}
      onPageUp={() => { setScrollOffset((p) => Math.max(0, p - 6)); return true; }} onPageDown={() => { setScrollOffset((p) => Math.min(maxScrollOffset, p + 6)); return true; }}
      onTab={handleTab} onEscape={() => { if (input.startsWith('/')) { setInput(''); setSelectedCmdIndex(0); return true; } return false; }}
      history={history} focus={isActive && !isSelectingModel && isInputFocused} theme={theme}
      placeholder={isChatFocused ? 'Chat scroll focused — Press Tab or Esc to type...' : phase === 'thinking' ? '⚡ Thinking... [Esc stop]' : phase === 'executing-tools' ? '🔧 Running tools...' : phase === 'responding' ? 'Streaming... [Esc stop]' : 'Type prompt or /command...'}
      disabled={phase !== 'idle'} showCounter={true} suggestions={promptSuggestions}
      onCancel={() => { if (phase !== 'idle') { resetStream('idle'); show('Cancelled', 'warning', 2000); } }}
    />
  );

  return (
    <Box flexDirection="column" width={columns}>
      <Box paddingX={1} width={columns}>
        {messages.length === 0 ? (
          <Box height={chatHeight} width="100%" flexDirection="column" alignItems="center" justifyContent="center">
            <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={0} flexDirection="column" alignItems="center" width={Math.min(74, columns - 4)}>
              <Box flexDirection="row" gap={1}>
                <Text bold color="cyan">⚡ AGENTIC HARNESS</Text>
                <Text color="gray">│ <Text color="white" bold>Autonomous Agent Cockpit</Text> v1.0.0</Text>
              </Box>
              <Text color="gray">Model: <Text color="cyan" bold>{selectedModel}</Text> • Context: <Text color="white">16k tokens</Text> • <Text color="green">● MCP Active</Text></Text>
              <Box flexDirection="column" width="100%">
                <Text color="gray"><Text color="yellow">❯ </Text><Text color="white">Type an engineering prompt to begin reasoning & tool execution</Text></Text>
                <Text color="gray"><Text color="yellow">❯ </Text>Type <Text color="cyan">/model</Text> switch model • <Text color="cyan">/skills</Text> load skills • <Text color="cyan">/tools</Text> inspect tools</Text>
              </Box>
              <Text color="gray" dimColor>[Tab Autocomplete • Ctrl+O Model • Ctrl+T View • Ctrl+A Accordion]</Text>
            </Box>
          </Box>
        ) : viewMode === 'accordion' ? (
          <ChatAccordion messages={messages} height={chatHeight} width={columns - 4} focus={isActive && isChatFocused} theme={theme} />
        ) : (
          <ScrollArea height={chatHeight} width="100%" scrollOffset={scrollOffset} onScrollOffsetChange={setScrollOffset} focus={isActive && isChatFocused} autoScroll={true} theme={theme}>
            {messageRows}
          </ScrollArea>
        )}
      </Box>

      {toasts.length > 0 && <Box paddingX={1} width={columns}><ToastStack toasts={toasts.slice(-1)} onDismiss={dismiss} theme={theme} /></Box>}

      {activeMenu.length > 0 && (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" width={columns}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color="cyan">⚡ Suggestions & Commands</Text>
            <Text color="gray" dimColor>↑/↓ Nav • Tab Select • Enter Run • Esc Close ({selectedCmdIndex + 1}/{activeMenu.length})</Text>
          </Box>
          {visibleCommands.map((c) => (
            <Box key={c.name} flexDirection="row" gap={1}>
              <Text bold color={c === activeMenu[selectedCmdIndex] ? 'cyan' : 'yellow'} inverse={c === activeMenu[selectedCmdIndex]}>
                {c === activeMenu[selectedCmdIndex] ? '❯ ' : '  '}{c.name}
              </Text>
              {c.args && <Text color={c === activeMenu[selectedCmdIndex] ? 'white' : 'gray'}>{c.args}</Text>}
              <Text color="gray" dimColor={c !== activeMenu[selectedCmdIndex]}>— {c.desc}</Text>
            </Box>
          ))}
        </Box>
      )}

      {inputStyle === 'box' ? (
        <Box borderStyle="round" borderColor={isInputFocused ? (theme?.colors?.focus ?? 'cyan') : (theme?.colors?.border ?? 'gray')} paddingX={1} width={columns}>
          {textInputNode}
        </Box>
      ) : (
        <Box flexDirection="column" width={columns}>
          <Divider width={columns} theme={theme} style={isInputFocused ? 'bold' : 'single'} />
          <Box paddingX={1} width={columns}>{textInputNode}</Box>
          <Divider width={columns} theme={theme} />
        </Box>
      )}

      <Box paddingX={1} width={columns} flexDirection="row" justifyContent="space-between">
        <Text color="gray" dimColor>
          {isChatFocused ? '↑/↓ Scroll • Esc/Tab Type' : `PgUp/PgDn Scroll • Tab Complete • ↑/↓ History • Ctrl+B Style [${inputStyle}]`}
        </Text>
        <Box flexDirection="row" gap={1}>
          {viewMode === 'stream' && scrollOffset > 0 && <Text color="yellow">▲ Above (PgUp)</Text>}
          {viewMode === 'stream' && scrollOffset < maxScrollOffset && <Text color="yellow">▼ Below (PgDn)</Text>}
          {viewMode === 'accordion' && <Text color="cyan">[Accordion]</Text>}
        </Box>
      </Box>
    </Box>
  );
};

export default Chat;