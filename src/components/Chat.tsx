import React, { useState, useEffect, useMemo } from 'react';
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
import {
  getActiveToolRegistry,
  consumeStream,
  dispatchSlashCommand,
  SLASH_COMMANDS,
  executeMcpCalls,
} from '../tools.js';

export interface ChatMessage extends Message {
  timestamp?: number;
  thinking?: string;
  tokens?: number;
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

const COMMAND_NAMES = SLASH_COMMANDS.map((c) => c.name);

function renderMessageHeader(msg: ChatMessage, idx: number) {
  const variant = msg.role === 'user' ? 'info' : msg.role === 'tool' ? 'warning' : msg.role === 'system' ? 'default' : 'success';
  const label = msg.role === 'user' ? 'You' : msg.role === 'tool' ? 'Tool' : msg.role === 'system' ? 'System' : 'AI';
  return (
    <Box key={`h-${idx}`} flexDirection="row" gap={1} alignItems="center">
      <Badge variant={variant}>{label}</Badge>
      {msg.timestamp && <Text color="gray" dimColor>{new Date(msg.timestamp).toLocaleTimeString()}</Text>}
    </Box>
  );
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
  if (phase === 'thinking') {
    return (
      <Box flexDirection="row" gap={1} alignItems="center" paddingLeft={2}>
        <Spinner type="dots" />
        <Text color="yellow"> {model} is thinking...</Text>
        {thinking.length > 0 && <Text color="gray" dimColor>({Math.ceil(thinking.length / 4)} tokens)</Text>}
      </Box>
    );
  }
  if (phase === 'executing-tools') {
    return <Box flexDirection="row" gap={1} alignItems="center" paddingLeft={2}><Spinner type="dots" /><Text color="cyan"> Executing MCP tool call...</Text></Box>;
  }
  if (phase === 'responding') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center"><Badge variant="success">AI</Badge><Text color="green" dimColor>streaming</Text><Spinner type="dots" /></Box>
        {parseMarkdownBlocks(`${content}█`, theme, maxWidth).map((n, bi) => <Box key={`sb-${bi}`} paddingLeft={2}>{n}</Box>)}
      </Box>
    );
  }
  return null;
};

const Chat: React.FC<ChatProps> = ({
  client, messages, onSendMessage, setMessages, models = [], theme, isActive = true,
  columns: propCols, rows: propRows, selectedModel: propModel, isSelectingModel = false, onSelectModel,
}) => {
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'responding' | 'executing-tools'>('idle');
  const [streamedThinking, setStreamedThinking] = useState('');
  const [streamedContent, setStreamedContent] = useState('');
  const [registry, setRegistry] = useState<any>(null);
  const selectedModel = propModel || models[0] || 'qwen3:8b';
  const { toasts, show, dismiss } = useToast();

  const termSize = useTerminalSize();
  const columns = propCols ?? termSize.columns;
  const rows = propRows ?? termSize.rows;
  const { isFocused, setFocus } = useFocusManager({ count: 2, initialIndex: 0 });
  const isInputFocused = isFocused(0);
  const isChatFocused = isFocused(1);

  const matchingCommands = useMemo(() => {
    if (!input.startsWith('/')) return [];
    const query = input.split(/\s+/)[0]?.toLowerCase() || '/';
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
  }, [input]);

  const selectOverhead = isSelectingModel ? 1 + Math.min(models.length || 1, 5) + (models.length > 5 ? 1 : 0) : 0;
  const menuOverhead = input.startsWith('/') && matchingCommands.length > 0 ? Math.min(matchingCommands.length, 3) + 2 : 0;
  const chatHeight = Math.max(3, rows - 13 - selectOverhead - menuOverhead - (toasts.length > 0 ? 1 : 0));

  useEffect(() => {
    getActiveToolRegistry().then(setRegistry).catch(() => undefined);
  }, []);

  useInput((_input, key) => {
    if (!isActive || isSelectingModel) return;
    if (key.escape && !isInputFocused) setFocus(0);
  });

  const [history, setHistory] = useState<string[]>(() =>
    messages.filter((m) => m.role === 'user' && m.content.trim() && !m.content.trim().startsWith('/')).map((m) => m.content.trim()),
  );

  const resetStream = (p: typeof phase = 'idle') => {
    setPhase(p);
    setStreamedThinking('');
    setStreamedContent('');
  };

  const executeSlashCommand = (trimmed: string): boolean => {
    return dispatchSlashCommand(trimmed, {
      messages,
      model: selectedModel,
      setModel: onSelectModel,
      models,
      clearMessages: () => onSendMessage('/clear'),
      setMessages: setMessages ?? (() => {}),
      showToast: show,
      addSystemCard: (text) => onSendMessage(undefined, text, undefined, { role: 'system', content: text, timestamp: Date.now() }),
      registry,
    });
  };

  const executeSingleTurn = async (chatHistory: ChatMessage[]) => {
    const tools = registry ? registry.definitions() : undefined;
    const stream = await client!.chatStream({
      model: selectedModel,
      messages: chatHistory,
      think: 'high',
      tools,
      options: { temperature: 0.7 },
    });
    const { thinking, content } = await consumeStream(
      stream,
      (d) => setStreamedThinking((prev) => prev + d),
      (d) => { setPhase('responding'); setStreamedContent((prev) => prev + d); },
    );
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
      setInput('');
      const ok = executeSlashCommand(trimmed);
      if (!ok) show(`Unknown command: ${trimmed}. Type /help for manual`, 'error', 3000);
      return;
    }
    setHistory((prev) => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    setInput('');
    onSendMessage(trimmed);
    resetStream('thinking');
    await runAgentLoop([...messages, { role: 'user', content: trimmed, timestamp: Date.now() }]);
  };

  const messageRows = useMemo(() => {
    const maxWidth = Math.max(20, columns - 6);
    const rows = messages.flatMap((msg, mi) => [
      renderMessageHeader(msg, mi),
      ...(msg.thinking ? [<Box key={`t-${mi}`} paddingLeft={2}><Text color="yellow" dimColor>💭 Reasoning ({Math.ceil(msg.thinking.length / 4)} tokens)</Text></Box>] : []),
      ...(msg.tool_calls?.map((tc: any, tci: number) => (
        <Box key={`tc-${mi}-${tci}`} paddingLeft={2} flexDirection="row" gap={1}>
          <Badge variant="warning">Tool Call</Badge>
          <Text color="yellow">{tc.function?.name}</Text>
          <Text color="gray" dimColor>({JSON.stringify(tc.function?.arguments || {})})</Text>
        </Box>
      )) || []),
      ...renderMessageContent(msg, mi, theme, maxWidth),
    ]);
    if (phase !== 'idle') {
      rows.push(<StreamingIndicator key="stream" phase={phase} model={selectedModel} thinking={streamedThinking} content={streamedContent} theme={theme} maxWidth={maxWidth} />);
    }
    return rows;
  }, [messages, phase, streamedThinking, streamedContent, selectedModel, theme, columns]);

  return (
    <Box flexDirection="column" width={columns}>
      <Box borderStyle="single" borderColor={isChatFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')} flexDirection="column" paddingX={1} width={columns}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={isChatFocused ? (theme?.colors?.focus ?? 'green') : 'gray'}>{isChatFocused ? '● Chat History (Focused)' : 'Chat History'}</Text>
          <Text color="gray" dimColor>{isChatFocused ? '↑/↓/j/k Scroll • PgUp/PgDn • Home/End • Esc to Input' : 'Mouse Wheel to Scroll • Tab to Focus'}</Text>
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
            <Text bold color="cyan">Commands ({matchingCommands.length})</Text>
            <Text color="gray" dimColor>Press [Tab] to autocomplete</Text>
          </Box>
          {matchingCommands.slice(0, 3).map((cmd) => (
            <Box key={cmd.name} flexDirection="row" gap={1}>
              <Text bold color="yellow">{cmd.name}</Text>
              {cmd.args && <Text color="gray">{cmd.args}</Text>}
              <Text color="gray" dimColor>— {cmd.desc}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box borderStyle="round" borderColor={isInputFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')} paddingX={1} width={columns}>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSendMessage}
          history={history}
          placeholder={phase === 'thinking' ? '⚡ Thinking... [Esc to stop]' : phase === 'executing-tools' ? '🔧 Executing MCP tools...' : phase === 'responding' ? 'Streaming... [Esc to stop]' : 'Type prompt or /command (Enter to send)...'}
          focus={isActive && !isSelectingModel && isInputFocused}
          theme={theme}
          suggestions={COMMAND_NAMES}
          disabled={phase !== 'idle'}
          showCounter={true}
          onCancel={() => { if (phase !== 'idle') { resetStream('idle'); show('Cancelled', 'warning', 2000); } }}
        />
      </Box>
      <Box paddingX={1} width={columns}>
        <Text color="gray" dimColor>
          {isChatFocused ? '↑/↓/j/k or Wheel Scroll • PgUp/PgDn Page • Home/End Top/Bottom • Esc to Input' : '↑/↓ History • Tab Auto/Scroll • Ctrl+A/E Line • Ctrl+W Del Word • Ctrl+U Clear • Esc Stop'}
        </Text>
      </Box>
    </Box>
  );
};

export default Chat;