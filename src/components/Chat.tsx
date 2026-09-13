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

interface ChatMessage extends Message {
  timestamp?: number;
  thinking?: string;
}

interface ChatProps {
  client: OllamaClient | null;
  messages: ChatMessage[];
  onSendMessage: (user?: string, assistant?: string, thinking?: string) => void;
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

async function consumeStream(
  stream: AsyncIterable<any>,
  onThinking: (delta: string) => void,
  onToken: (delta: string) => void,
) {
  let thinking = '';
  let content = '';
  for await (const event of stream) {
    if (event.type === 'thinking') {
      thinking += event.data.delta;
      onThinking(event.data.delta);
    } else if (event.type === 'token') {
      content += event.data.delta;
      onToken(event.data.delta);
    }
  }
  return { thinking, content };
}

const SLASH_COMMANDS = ['/clear', '/help', '/model', '/system'];

function isLocalSlashCommand(
  cmd: string,
  onClear: () => void,
  showToast: (msg: string, type: 'info' | 'error' | 'warning', duration?: number) => void,
): boolean {
  if (cmd === '/clear') {
    onClear();
    showToast('Chat history cleared', 'info', 2000);
    return true;
  }
  if (cmd === '/help') {
    showToast('Commands: /clear, /model, /system, /help • Esc: cancel stream', 'info', 4000);
    return true;
  }
  return false;
}

const Chat: React.FC<ChatProps> = ({
  client, messages, onSendMessage, models = [], isConnected = false, theme, isActive = true,
  columns: propCols, rows: propRows, selectedModel: propModel, isSelectingModel = false,
}) => {
  const [input, setInput] = useState('');
  const [streamPhase, setStreamPhase] = useState<'idle' | 'thinking' | 'responding'>('idle');
  const [streamedThinking, setStreamedThinking] = useState('');
  const [streamedContent, setStreamedContent] = useState('');
  const selectedModel = propModel || models[0] || 'qwen3:8b';
  const { toasts, show, dismiss } = useToast();

  const termSize = useTerminalSize();
  const columns = propCols ?? termSize.columns;
  const rows = propRows ?? termSize.rows;
  const { isFocused, setFocus } = useFocusManager({ count: 2, initialIndex: 0 });
  const isInputFocused = isFocused(0);
  const isChatFocused = isFocused(1);

  // Safe height: reserves fixed UI rows + 3-4 terminal headroom rows to prevent scroll & cursor desync
  const selectOverhead = isSelectingModel ? 1 + Math.min(models.length || 1, 5) + (models.length > 5 ? 1 : 0) : 0;
  const toastOverhead = toasts.length > 0 ? 1 : 0;
  const chatHeight = Math.max(3, rows - 13 - selectOverhead - toastOverhead);

  useInput((_input, key) => {
    if (!isActive || isSelectingModel) return;
    if (key.escape && !isInputFocused) setFocus(0);
  });

  const [history, setHistory] = useState<string[]>(() =>
    messages.filter((m) => m.role === 'user' && m.content.trim()).map((m) => m.content.trim()),
  );

  const resetStream = (phase: 'idle' | 'thinking' = 'idle') => {
    setStreamPhase(phase);
    setStreamedThinking('');
    setStreamedContent('');
  };

  const handleCancelStream = () => {
    if (streamPhase !== 'idle') {
      resetStream('idle');
      show('Generation cancelled', 'warning', 2000);
    }
  };

  const handleSendMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || !client || streamPhase !== 'idle') return;

    if (isLocalSlashCommand(trimmed, () => onSendMessage('/clear'), show)) {
      setInput('');
      return;
    }

    setHistory((prev) => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    setInput('');
    onSendMessage(trimmed);
    resetStream('thinking');

    try {
      const stream = await client.chatStream({
        model: selectedModel,
        messages: [...messages, { role: 'user', content: message }],
        think: 'high',
        options: { temperature: 0.7 },
      });

      const { thinking, content } = await consumeStream(
        stream,
        (d) => setStreamedThinking((prev) => prev + d),
        (d) => { setStreamPhase('responding'); setStreamedContent((prev) => prev + d); },
      );

      const final = await stream.finalResult;
      onSendMessage(undefined, final.message?.content || content, thinking || undefined);
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
    messages.forEach((msg, mi) => {
      rows.push(
        <Box key={`h-${mi}`} flexDirection="row" gap={1} alignItems="center">
          <Badge variant={msg.role === 'user' ? 'info' : 'success'}>
            {msg.role === 'user' ? 'You' : 'AI'}
          </Badge>
          {msg.timestamp && (
            <Text color="gray" dimColor>{new Date(msg.timestamp).toLocaleTimeString()}</Text>
          )}
        </Box>
      );

      if (msg.thinking) {
        rows.push(
          <Box key={`t-${mi}`} paddingLeft={2}>
            <Text color="yellow" dimColor>💭 Reasoning ({Math.ceil(msg.thinking.length / 4)} tokens)</Text>
          </Box>
        );
      }

      const maxWidth = Math.max(20, columns - 6);
      const contentNodes = msg.role === 'user'
        ? msg.content.split('\n').flatMap((line, li) =>
            wrapTextLine(line, maxWidth).map((wl, wli) => <Text key={`${li}-${wli}`}>{wl}</Text>)
          )
        : parseMarkdownBlocks(msg.content, theme, maxWidth);

      contentNodes.forEach((node, bi) => {
        rows.push(<Box key={`c-${mi}-${bi}`} paddingLeft={2}>{node}</Box>);
      });
    });

    if (streamPhase === 'thinking') {
      rows.push(
        <Box key="stream-think" flexDirection="row" gap={1} alignItems="center" paddingLeft={2}>
          <Spinner type="dots" />
          <Text color="yellow"> {selectedModel} is thinking...</Text>
          {streamedThinking.length > 0 && (
            <Text color="gray" dimColor>({Math.ceil(streamedThinking.length / 4)} tokens)</Text>
          )}
        </Box>
      );
    } else if (streamPhase === 'responding') {
      rows.push(
        <Box key="stream-header" flexDirection="row" gap={1} alignItems="center">
          <Badge variant="success">AI</Badge>
          <Text color="green" dimColor>streaming</Text>
          <Spinner type="dots" />
        </Box>
      );
      const streamBlocks = parseMarkdownBlocks(
        `${streamedContent}█`,
        theme,
        Math.max(20, columns - 6),
      );
      streamBlocks.forEach((node, bi) => {
        rows.push(<Box key={`stream-b-${bi}`} paddingLeft={2}>{node}</Box>);
      });
    }

    return rows;
  }, [messages, streamPhase, streamedThinking, streamedContent, selectedModel, theme, columns]);

  return (
    <Box flexDirection="column" width={columns}>
      {/* Messages Conversation Panel with ScrollArea */}
      <Box
        borderStyle="single"
        borderColor={isChatFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')}
        flexDirection="column"
        paddingX={1}
        width={columns}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={isChatFocused ? (theme?.colors?.focus ?? 'green') : 'gray'}>
            {isChatFocused ? '● Chat History (Focused)' : 'Chat History'}
          </Text>
          <Text color="gray" dimColor>
            {isChatFocused
              ? '↑/↓/j/k Scroll • PgUp/PgDn • Home/End • Esc to Input'
              : 'Mouse Wheel to Scroll • Tab to Focus'}
          </Text>
        </Box>

        {messageRows.length === 0 ? (
          <Box height={chatHeight} flexDirection="column" alignItems="center" justifyContent="center">
            <Typewriter text="Ready. Type prompt and press Enter... (Tab to scroll)" speed={45} cursorChar="▌" theme={theme} />
          </Box>
        ) : (
          <ScrollArea height={chatHeight} width="100%" focus={isActive && isChatFocused} autoScroll={true} theme={theme}>
            {messageRows}
          </ScrollArea>
        )}
      </Box>

      {/* Toast Notification Stack - on top of TextInput */}
      {toasts.length > 0 && (
        <Box paddingX={1} width={columns}>
          <ToastStack toasts={toasts.slice(-1)} onDismiss={dismiss} theme={theme} />
        </Box>
      )}

      {/* Input Area */}
      <Box
        borderStyle="round"
        borderColor={isInputFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')}
        paddingX={1}
        width={columns}
      >
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSendMessage}
          history={history}
          placeholder={
            streamPhase === 'thinking'
              ? '⚡ Model is thinking... [Esc to stop]'
              : streamPhase === 'responding'
                ? 'Streaming response... [Esc to stop]'
                : 'Type prompt or /command (Enter to send)...'
          }
          focus={isActive && !isSelectingModel && isInputFocused}
          theme={theme}
          suggestions={SLASH_COMMANDS}
          disabled={streamPhase !== 'idle'}
          showCounter={true}
          onCancel={handleCancelStream}
        />
      </Box>
      <Box paddingX={1} width={columns}>
        <Text color="gray" dimColor>
          {isChatFocused
            ? '↑/↓/j/k or Wheel Scroll • PgUp/PgDn Page • Home/End Top/Bottom • Esc to Input'
            : '↑/↓ History • Tab Auto/Scroll • Ctrl+A/E Line • Ctrl+W Del Word • Ctrl+U Clear • Esc Stop'}
        </Text>
      </Box>
    </Box>
  );
};

export default Chat;