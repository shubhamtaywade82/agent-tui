import React, { useState, useEffect, useMemo } from 'react';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './ui/text-input/index.js';
import { Spinner } from './ui/spinner/index.js';
import { Badge } from './ui/badge/index.js';
import { Typewriter } from './ui/typewriter/index.js';
import { OllamaClient, Message } from '@nemesis-oss/ollama-sdk';
import { ToastStack, useToast } from './ui/toast/index.js';
import { parseMarkdownBlocks, wrapTextLine } from './ui/markdown/index.js';
import { ScrollArea } from './ui/scroll-area/index.js';
import { useFocusManager, useTerminalSize } from './ui/hooks/index.js';
import { getActiveToolRegistry, consumeStream, dispatchSlashCommand, SLASH_COMMANDS, executeMcpCalls } from '../tools.js';

export interface ChatMessage extends Message {
  timestamp?: number;
  thinking?: string;
  tokens?: number;
}

const HISTORY_FILE = '.history';
const MAX_HISTORY = 500;

function loadLocalHistory(): string[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    return readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean).slice(-MAX_HISTORY).map((line) => {
      try { return JSON.parse(line); } catch { return line; }
    });
  } catch {
    return [];
  }
}

function appendLocalHistory(prompt: string) {
  try {
    appendFileSync(HISTORY_FILE, JSON.stringify(prompt) + '\n', 'utf-8');
  } catch {
    // Disk write failures should not break the UI session
  }
}

interface ChatProps {
  client: OllamaClient | null;
  messages: ChatMessage[];
  onSendMessage: (u?: string, a?: string, t?: string, x?: Partial<ChatMessage>) => void;
  setMessages?: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  models?: string[];
  isConnected?: boolean;
  theme?: any;
  isActive?: boolean;
  columns?: number;
  rows?: number;
  selectedModel?: string;
  onSelectModel?: (model: string) => void;
  isSelectingModel?: boolean;
}

function renderMessageHeader(msg: ChatMessage, idx: number) {
  const v = msg.role === 'user' ? 'info' : msg.role === 'tool' ? 'warning' : msg.role === 'system' ? 'default' : 'success';
  const l = msg.role === 'user' ? 'You' : msg.role === 'tool' ? 'Tool' : msg.role === 'system' ? 'System' : 'AI';
  const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
  return <Box key={`h-${idx}`} flexDirection="row" gap={1} alignItems="center"><Badge variant={v}>{l}</Badge>{time && <Text color="gray" dimColor>{time}</Text>}</Box>;
}

function renderMessageContent(msg: ChatMessage, idx: number, theme: any, maxWidth: number) {
  if (msg.role === 'tool') {
    return [<Box key={`tr-${idx}`} paddingLeft={2}><Text color="cyan" dimColor>Result: {msg.content.slice(0, 100)}{msg.content.length > 100 ? '...' : ''}</Text></Box>];
  }
  const nodes = msg.role === 'user'
    ? msg.content.split('\n').flatMap((l, li) => wrapTextLine(l, maxWidth).map((wl, wli) => <Text key={`${li}-${wli}`}>{wl}</Text>))
    : parseMarkdownBlocks(msg.content, theme, maxWidth);
  return nodes.map((n, bi) => <Box key={`c-${idx}-${bi}`} paddingLeft={2}>{n}</Box>);
}

const StreamingIndicator: React.FC<{ phase: string; model: string; thinking: string; content: string; theme: any; maxWidth: number }> = ({
  phase, model, thinking, content, theme, maxWidth,
}) => {
  if (phase === 'thinking') return <Box flexDirection="row" gap={1} alignItems="center" paddingLeft={2}><Spinner type="dots" /><Text color="yellow"> {model} is thinking...</Text>{thinking.length > 0 && <Text color="gray" dimColor>({Math.ceil(thinking.length / 4)} tokens)</Text>}</Box>;
  if (phase === 'executing-tools') return <Box flexDirection="row" gap={1} alignItems="center" paddingLeft={2}><Spinner type="dots" /><Text color="cyan"> Executing MCP tool call...</Text></Box>;
  if (phase === 'responding') return <Box flexDirection="column"><Box flexDirection="row" gap={1} alignItems="center"><Badge variant="success">AI</Badge><Text color="green" dimColor>streaming</Text><Spinner type="dots" /></Box>{parseMarkdownBlocks(`${content}█`, theme, maxWidth).map((n, bi) => <Box key={`sb-${bi}`} paddingLeft={2}>{n}</Box>)}</Box>;
  return null;
};

const Chat: React.FC<ChatProps> = ({
  client, messages, onSendMessage, setMessages, models = [], theme, isActive = true,
  columns: propCols, rows: propRows, selectedModel: propModel, isSelectingModel = false, onSelectModel,
}) => {
  const [input, setInput] = useState('');
  const [selectedCmdIndex, setSelectedCmdIndex] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'responding' | 'executing-tools'>('idle');
  const [streamedThinking, setStreamedThinking] = useState('');
  const [streamedContent, setStreamedContent] = useState('');
  const [registry, setRegistry] = useState<any>(null);
  const selectedModel = propModel || models[0] || 'qwen3:8b';
  const { toasts, show, dismiss } = useToast();

  const termSize = useTerminalSize();
  const columns = propCols ?? termSize.columns;
  const rows = propRows ?? termSize.rows;
  const { isFocused, setFocus } = useFocusManager({ count: 2, initialIndex: 0, nextKey: 'none', prevKey: 'none' });
  const isInputFocused = isFocused(0);
  const isChatFocused = isFocused(1);

  const matchingCommands = useMemo(() => {
    if (!input.startsWith('/')) return [];
    const query = input.split(/\s+/)[0]?.toLowerCase() || '/';
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
  }, [input]);

  const selectOverhead = isSelectingModel ? 1 + Math.min(models.length || 1, 5) + (models.length > 5 ? 1 : 0) : 0;
  const menuOverhead = input.startsWith('/') && matchingCommands.length > 0 ? Math.min(matchingCommands.length, 4) + 2 : 0;
  const chatHeight = Math.max(3, rows - 13 - selectOverhead - menuOverhead - (toasts.length > 0 ? 1 : 0));

  useEffect(() => { setSelectedCmdIndex(0); }, [input]);
  useEffect(() => { getActiveToolRegistry().then(setRegistry).catch(() => undefined); }, []);

  useInput((_input, key) => {
    if (!isActive || isSelectingModel) return;
    if ((key.escape || key.tab) && isChatFocused) setFocus(0);
  });

  const [history, setHistory] = useState<string[]>(() => {
    const loaded = loadLocalHistory();
    const initial = messages.filter((m) => m.role === 'user' && m.content.trim()).map((m) => m.content.trim());
    return Array.from(new Set([...loaded, ...initial]));
  });

  const resetStream = (p: typeof phase = 'idle') => {
    setPhase(p);
    setStreamedThinking('');
    setStreamedContent('');
  };

  const executeSlashCommand = (trimmed: string): boolean => {
    return dispatchSlashCommand(trimmed, {
      messages, model: selectedModel, setModel: onSelectModel, models,
      clearMessages: () => onSendMessage('/clear'), setMessages: setMessages ?? (() => {}),
      showToast: show, registry,
      addSystemCard: (text) => onSendMessage(undefined, text, undefined, { role: 'system', content: text, timestamp: Date.now() }),
    });
  };

  const executeSingleTurn = async (chatHistory: ChatMessage[]) => {
    const tools = registry ? registry.definitions() : undefined;
    const stream = await client!.chatStream({ model: selectedModel, messages: chatHistory, think: 'high', tools, options: { temperature: 0.7 } });
    const { thinking, content } = await consumeStream(stream, (d) => setStreamedThinking((prev) => prev + d), (d) => { setPhase('responding'); setStreamedContent((prev) => prev + d); });
    const final = await stream.finalResult;
    const toolCalls = final.message?.tool_calls;
    if (!toolCalls?.length || !registry) {
      onSendMessage(undefined, final.message?.content || content, thinking || undefined);
      return { done: true as const };
    }
    const asst: ChatMessage = { role: 'assistant', content: final.message?.content || content, thinking: thinking || undefined, tool_calls: toolCalls, timestamp: Date.now() };
    onSendMessage(undefined, asst.content, asst.thinking, asst);
    setPhase('executing-tools');
    show(`Calling ${toolCalls.length} MCP tool(s)...`, 'info', 2000);
    const toolMsgs = await executeMcpCalls(registry, toolCalls);
    toolMsgs.forEach((tm) => onSendMessage(undefined, tm.content, undefined, tm));
    return { asst, toolMsgs, done: false as const };
  };

  const runAgentLoop = async (initialHistory: ChatMessage[]) => {
    let currentHistory = initialHistory;
    try {
      for (let turn = 0; turn < 5; turn++) {
        const res = await executeSingleTurn(currentHistory);
        if (res.done || !res.asst) break;
        currentHistory = [...currentHistory, res.asst, ...(res.toolMsgs || [])];
        resetStream('thinking');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      show(`Error: ${msg}`, 'error', 4000);
      onSendMessage(undefined, `⚠️ Error: ${msg}`);
    } finally {
      resetStream('idle');
    }
  };

  const handleSendMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || !client || phase !== 'idle') return;
    if (trimmed.startsWith('/')) {
      let cmdToRun = trimmed;
      if (trimmed === '/' || !SLASH_COMMANDS.some((c) => c.name === trimmed.split(/\s+/)[0])) {
        const sel = matchingCommands[selectedCmdIndex] || matchingCommands[0];
        if (sel) {
          if (sel.args && trimmed === '/') { setInput(sel.name + ' '); return; }
          cmdToRun = sel.name;
        }
      }
      setHistory((prev) => (prev[prev.length - 1] === cmdToRun ? prev : [...prev, cmdToRun]));
      appendLocalHistory(cmdToRun);
      setInput('');
      setSelectedCmdIndex(0);
      const ok = executeSlashCommand(cmdToRun);
      if (!ok) show(`Unknown command: ${cmdToRun}. Type /help for manual`, 'error', 3000);
      return;
    }
    setHistory((prev) => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    appendLocalHistory(trimmed);
    setInput('');
    onSendMessage(trimmed);
    resetStream('thinking');
    await runAgentLoop([...messages, { role: 'user', content: trimmed, timestamp: Date.now() }]);
  };

  const handleArrow = (delta: -1 | 1): boolean => {
    if (!input.startsWith('/') || matchingCommands.length === 0) return false;
    setSelectedCmdIndex((prev) => (delta === 1 ? (prev + 1) % matchingCommands.length : prev <= 0 ? matchingCommands.length - 1 : prev - 1));
    return true;
  };

  const handleTab = (): boolean => {
    if (input.startsWith('/') && matchingCommands.length > 0) {
      const cmd = matchingCommands[selectedCmdIndex] || matchingCommands[0];
      if (cmd) { setInput(cmd.name + ' '); setSelectedCmdIndex(0); }
      return true;
    }
    if (input === '') { setFocus(1); return true; }
    return true;
  };

  const messageRows = useMemo(() => {
    const maxWidth = Math.max(20, columns - 6);
    const rows = messages.flatMap((msg, mi) => [
      renderMessageHeader(msg, mi),
      ...(msg.thinking ? [<Box key={`t-${mi}`} paddingLeft={2}><Text color="yellow" dimColor>💭 Reasoning ({Math.ceil(msg.thinking.length / 4)} tokens)</Text></Box>] : []),
      ...(msg.tool_calls?.map((tc: any, tci: number) => (
        <Box key={`tc-${mi}-${tci}`} paddingLeft={2} flexDirection="row" gap={1}><Badge variant="warning">Tool Call</Badge><Text color="yellow">{tc.function?.name}</Text><Text color="gray" dimColor>({JSON.stringify(tc.function?.arguments || {})})</Text></Box>
      )) || []),
      ...renderMessageContent(msg, mi, theme, maxWidth),
    ]);
    if (phase !== 'idle') rows.push(<StreamingIndicator key="stream" phase={phase} model={selectedModel} thinking={streamedThinking} content={streamedContent} theme={theme} maxWidth={maxWidth} />);
    return rows;
  }, [messages, phase, streamedThinking, streamedContent, selectedModel, theme, columns]);

  const menuStart = Math.min(Math.max(0, selectedCmdIndex - 1), Math.max(0, matchingCommands.length - 4));
  const visibleCommands = matchingCommands.slice(menuStart, menuStart + 4);

  return (
    <Box flexDirection="column" width={columns}>
      <Box borderStyle="single" borderColor={isChatFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')} flexDirection="column" paddingX={1} width={columns}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={isChatFocused ? (theme?.colors?.focus ?? 'green') : 'gray'}>{isChatFocused ? '● Chat History (Focused)' : 'Chat History'}</Text>
          <Text color="gray" dimColor>{isChatFocused ? '↑/↓/j/k Scroll • PgUp/PgDn • Home/End • Esc/Tab to Input' : 'Mouse Wheel to Scroll • Tab (when empty) to Focus'}</Text>
        </Box>
        {messageRows.length === 0 ? (
          <Box height={chatHeight} flexDirection="column" alignItems="center" justifyContent="center">
            <Typewriter text="Ready. Type prompt or /command... (Tab to scroll)" speed={45} cursorChar="▌" theme={theme} />
          </Box>
        ) : (
          <ScrollArea height={chatHeight} width="100%" focus={isActive && isChatFocused} autoScroll={true} theme={theme}>{messageRows}</ScrollArea>
        )}
      </Box>

      {toasts.length > 0 && <Box paddingX={1} width={columns}><ToastStack toasts={toasts.slice(-1)} onDismiss={dismiss} theme={theme} /></Box>}

      {input.startsWith('/') && matchingCommands.length > 0 && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} width={columns}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color="cyan">⚡ Commands ({selectedCmdIndex + 1}/{matchingCommands.length})</Text>
            <Text color="gray" dimColor>↑/↓ Navigate • Tab Select • Enter Run • Esc Close</Text>
          </Box>
          {visibleCommands.map((cmd) => {
            const isSel = matchingCommands.indexOf(cmd) === selectedCmdIndex;
            return (
              <Box key={cmd.name} flexDirection="row" gap={1}>
                <Text bold color="cyan">{isSel ? '❯' : ' '}</Text>
                <Text bold color={isSel ? 'cyan' : 'yellow'} inverse={isSel}>{cmd.name}</Text>
                {cmd.args && <Text color={isSel ? 'white' : 'gray'}>{cmd.args}</Text>}
                <Text color="gray" dimColor={!isSel}>— {cmd.desc}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box borderStyle="round" borderColor={isInputFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')} paddingX={1} width={columns}>
        <TextInput
          value={input} onChange={setInput} onSubmit={handleSendMessage}
          onUpArrow={() => handleArrow(-1)} onDownArrow={() => handleArrow(1)} onTab={handleTab}
          onEscape={() => { if (input.startsWith('/')) { setInput(''); setSelectedCmdIndex(0); return true; } return false; }}
          history={history} focus={isActive && !isSelectingModel && isInputFocused} theme={theme}
          placeholder={phase === 'thinking' ? '⚡ Thinking... [Esc to stop]' : phase === 'executing-tools' ? '🔧 Executing MCP tools...' : phase === 'responding' ? 'Streaming... [Esc to stop]' : 'Type prompt or /command (Enter to send)...'}
          disabled={phase !== 'idle'} showCounter={true}
          onCancel={() => { if (phase !== 'idle') { resetStream('idle'); show('Cancelled', 'warning', 2000); } }}
        />
      </Box>
      <Box paddingX={1} width={columns}>
        <Text color="gray" dimColor>
          {isChatFocused ? '↑/↓/j/k or Wheel Scroll • PgUp/PgDn Page • Home/End Top/Bottom • Esc/Tab to Input' : '↑/↓ History/Menu • Tab Complete • Ctrl+A/E Line • Ctrl+W Del Word • Ctrl+U Clear • Esc Stop'}
        </Text>
      </Box>
    </Box>
  );
};

export default Chat;