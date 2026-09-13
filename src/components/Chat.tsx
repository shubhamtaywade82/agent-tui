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
  isLocalSlashCommand,
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

const COMMANDS = ['/clear', '/help', '/mcp', '/model', '/system'];

const Chat: React.FC<ChatProps> = ({
  client, messages, onSendMessage, models = [], theme, isActive = true,
  columns: propCols, rows: propRows, selectedModel: propModel, isSelectingModel = false,
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

  const selectOverhead = isSelectingModel ? 1 + Math.min(models.length || 1, 5) + (models.length > 5 ? 1 : 0) : 0;
  const chatHeight = Math.max(3, rows - 13 - selectOverhead - (toasts.length > 0 ? 1 : 0));

  useEffect(() => {
    getActiveToolRegistry().then(setRegistry).catch(() => undefined);
  }, []);

  useInput((_input, key) => {
    if (!isActive || isSelectingModel) return;
    if (key.escape && !isInputFocused) setFocus(0);
  });

  const [history, setHistory] = useState<string[]>(() =>
    messages.filter((m) => m.role === 'user' && m.content.trim()).map((m) => m.content.trim()),
  );

  const resetStream = (p: typeof phase = 'idle') => {
    setPhase(p);
    setStreamedThinking('');
    setStreamedContent('');
  };

  const handleSendMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || !client || phase !== 'idle') return;
    if (isLocalSlashCommand(trimmed, () => onSendMessage('/clear'), show)) {
      setInput('');
      return;
    }

    setHistory((prev) => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    setInput('');
    onSendMessage(trimmed);
    resetStream('thinking');

    let chatHistory: ChatMessage[] = [...messages, { role: 'user', content: message, timestamp: Date.now() }];
    try {
      const tools = registry ? registry.definitions() : undefined;
      for (let turn = 0; turn < 5; turn++) {
        const stream = await client.chatStream({
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
        if (!toolCalls || toolCalls.length === 0 || !registry) {
          onSendMessage(undefined, final.message?.content || content, thinking || undefined);
          break;
        }

        const asst: ChatMessage = { role: 'assistant', content: final.message?.content || content, thinking: thinking || undefined, tool_calls: toolCalls, timestamp: Date.now() };
        onSendMessage(undefined, asst.content, asst.thinking, asst);
        chatHistory = [...chatHistory, asst];

        setPhase('executing-tools');
        show(`Calling ${toolCalls.length} MCP tool(s)...`, 'info', 2000);
        const toolMsgs = await executeMcpCalls(registry, toolCalls);
        toolMsgs.forEach((tm) => { onSendMessage(undefined, tm.content, undefined, tm); chatHistory.push(tm); });
        resetStream('thinking');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      show(`Error: ${errorMsg}`, 'error', 4000);
      onSendMessage(undefined, `⚠️ Error: ${errorMsg}`);
    } finally {
      resetStream('idle');
    }
  };

  const messageRows = useMemo(() => {
    const rows: React.ReactNode[] = [];
    const maxWidth = Math.max(20, columns - 6);

    messages.forEach((msg, mi) => {
      rows.push(
        <Box key={`h-${mi}`} flexDirection="row" gap={1} alignItems="center">
          <Badge variant={msg.role === 'user' ? 'info' : msg.role === 'tool' ? 'warning' : 'success'}>
            {msg.role === 'user' ? 'You' : msg.role === 'tool' ? 'Tool' : 'AI'}
          </Badge>
          {msg.timestamp && <Text color="gray" dimColor>{new Date(msg.timestamp).toLocaleTimeString()}</Text>}
        </Box>
      );

      if (msg.thinking) {
        rows.push(<Box key={`t-${mi}`} paddingLeft={2}><Text color="yellow" dimColor>💭 Reasoning ({Math.ceil(msg.thinking.length / 4)} tokens)</Text></Box>);
      }

      msg.tool_calls?.forEach((tc: any, tci: number) => {
        rows.push(
          <Box key={`tc-${mi}-${tci}`} paddingLeft={2} flexDirection="row" gap={1}>
            <Badge variant="warning">Tool Call</Badge>
            <Text color="yellow">{tc.function?.name}</Text>
            <Text color="gray" dimColor>({JSON.stringify(tc.function?.arguments || {})})</Text>
          </Box>
        );
      });

      if (msg.role === 'tool') {
        rows.push(<Box key={`tr-${mi}`} paddingLeft={2}><Text color="cyan" dimColor>Result: {msg.content.slice(0, 100)}{msg.content.length > 100 ? '...' : ''}</Text></Box>);
      } else {
        const nodes = msg.role === 'user'
          ? msg.content.split('\n').flatMap((l, li) => wrapTextLine(l, maxWidth).map((wl, wli) => <Text key={`${li}-${wli}`}>{wl}</Text>))
          : parseMarkdownBlocks(msg.content, theme, maxWidth);
        nodes.forEach((node, bi) => rows.push(<Box key={`c-${mi}-${bi}`} paddingLeft={2}>{node}</Box>));
      }
    });

    if (phase === 'thinking') {
      rows.push(
        <Box key="stream-think" flexDirection="row" gap={1} alignItems="center" paddingLeft={2}>
          <Spinner type="dots" />
          <Text color="yellow"> {selectedModel} is thinking...</Text>
          {streamedThinking.length > 0 && <Text color="gray" dimColor>({Math.ceil(streamedThinking.length / 4)} tokens)</Text>}
        </Box>
      );
    } else if (phase === 'executing-tools') {
      rows.push(<Box key="stream-tools" flexDirection="row" gap={1} alignItems="center" paddingLeft={2}><Spinner type="dots" /><Text color="cyan"> Executing MCP tool call...</Text></Box>);
    } else if (phase === 'responding') {
      rows.push(<Box key="stream-header" flexDirection="row" gap={1} alignItems="center"><Badge variant="success">AI</Badge><Text color="green" dimColor>streaming</Text><Spinner type="dots" /></Box>);
      parseMarkdownBlocks(`${streamedContent}█`, theme, maxWidth).forEach((n, bi) => rows.push(<Box key={`stream-b-${bi}`} paddingLeft={2}>{n}</Box>));
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
            <Typewriter text="Ready. Type prompt and press Enter... (Tab to scroll)" speed={45} cursorChar="▌" theme={theme} />
          </Box>
        ) : (
          <ScrollArea height={chatHeight} width="100%" focus={isActive && isChatFocused} autoScroll={true} theme={theme}>{messageRows}</ScrollArea>
        )}
      </Box>

      {toasts.length > 0 && <Box paddingX={1} width={columns}><ToastStack toasts={toasts.slice(-1)} onDismiss={dismiss} theme={theme} /></Box>}

      <Box borderStyle="round" borderColor={isInputFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')} paddingX={1} width={columns}>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSendMessage}
          history={history}
          placeholder={phase === 'thinking' ? '⚡ Thinking... [Esc to stop]' : phase === 'executing-tools' ? '🔧 Executing MCP tools...' : phase === 'responding' ? 'Streaming... [Esc to stop]' : 'Type prompt or /command (Enter to send)...'}
          focus={isActive && !isSelectingModel && isInputFocused}
          theme={theme}
          suggestions={COMMANDS}
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