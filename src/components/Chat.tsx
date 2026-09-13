import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './ui/text-input/index.js';
import { Spinner } from './ui/spinner/index.js';
import { Badge } from './ui/badge/index.js';
import { StatusIndicator } from './ui/status-indicator/index.js';
import { Typewriter } from './ui/typewriter/index.js';
import { OllamaClient, Message } from '@nemesis-oss/ollama-sdk';
import { Select } from './ui/select/index.js';
import { ToastStack, useToast } from './ui/toast/index.js';
import { Markdown, parseMarkdownBlocks } from './ui/markdown/index.js';
import { ScrollArea } from './ui/scroll-area/index.js';
import { useFocusManager, useTerminalSize } from './ui/hooks/index.js';

interface ChatMessage extends Message {
  timestamp?: number;
  thinking?: string;
}

interface ChatProps {
  client: OllamaClient | null;
  messages: ChatMessage[];
  onSendMessage: (userMessage?: string, assistantMessage?: string, thinking?: string) => void;
  models?: string[];
  isConnected?: boolean;
  theme?: any;
  isActive?: boolean;
}

const Chat: React.FC<ChatProps> = ({
  client, messages, onSendMessage, models = [], isConnected = false, theme, isActive = true,
}) => {
  const [input, setInput] = useState('');
  const [streamPhase, setStreamPhase] = useState<'idle' | 'thinking' | 'responding'>('idle');
  const [streamedThinking, setStreamedThinking] = useState('');
  const [streamedContent, setStreamedContent] = useState('');
  const [selectedModel, setSelectedModel] = useState(models[0] || 'qwen3:8b');
  const { toasts, show, dismiss } = useToast();

  const { rows, columns } = useTerminalSize();
  const { isFocused, setFocus } = useFocusManager({ count: 3, initialIndex: 0 });
  const isInputFocused = isFocused(0);
  const isChatFocused = isFocused(1);
  const isModelFocused = isFocused(2);

  // Dynamic height accounting for fixed layout (14 rows now that VRAM StatusBar is in System tab)
  const selectOverhead = isModelFocused ? 1 + Math.min(models.length || 1, 5) + (models.length > 5 ? 1 : 0) : 0;
  const toastOverhead = toasts.length > 0 ? 1 : 0;
  const chatHeight = Math.max(3, rows - 14 - selectOverhead - toastOverhead);

  useInput((_input, key) => {
    if (!isActive) return;
    if (key.escape && !isInputFocused) setFocus(0);
  });

  useEffect(() => {
    if (models.length > 0 && !models.includes(selectedModel)) {
      setSelectedModel(models[0]!);
    }
  }, [models, selectedModel]);

  const modelItems = (models.length > 0 ? models : [selectedModel]).map((m) => ({ label: m, value: m }));

  const initialHistory = useMemo(
    () => messages.filter((m) => m.role === 'user' && m.content.trim()).map((m) => m.content.trim()),
    [],
  );
  const [history, setHistory] = useState<string[]>(initialHistory);

  const handleSendMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || !client || streamPhase !== 'idle') return;

    setHistory((prev) => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    setInput('');
    onSendMessage(trimmed); // Immediately display user prompt in conversation
    setStreamPhase('thinking');
    setStreamedThinking('');
    setStreamedContent('');

    try {
      const stream = await client.chatStream({
        model: selectedModel,
        messages: [...messages, { role: 'user', content: message }],
        think: 'high',
        options: { temperature: 0.7 },
      });

      let accumulatedThinking = '';
      let accumulatedContent = '';

      for await (const event of stream) {
        if (event.type === 'thinking') {
          accumulatedThinking += event.data.delta;
          setStreamedThinking((prev) => prev + event.data.delta);
        } else if (event.type === 'token') {
          setStreamPhase('responding');
          accumulatedContent += event.data.delta;
          setStreamedContent((prev) => prev + event.data.delta);
        }
      }

      const finalResponse = await stream.finalResult;
      const assistantText = finalResponse.message?.content || accumulatedContent;
      onSendMessage(undefined, assistantText, accumulatedThinking || undefined);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      show(`Error: ${errorMsg}`, 'error', 4000);
      onSendMessage(undefined, `⚠️ Error: ${errorMsg}`);
    } finally {
      setStreamPhase('idle');
      setStreamedThinking('');
      setStreamedContent('');
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

      const contentNodes = msg.role === 'user'
        ? msg.content.split('\n').map((line, li) => <Text key={li}>{line}</Text>)
        : parseMarkdownBlocks(msg.content, theme, Math.max(20, columns - 6));

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
        </Box>
      );
      const streamLines = streamedContent.split('\n');
      streamLines.forEach((line, sli) => {
        const isLast = sli === streamLines.length - 1;
        rows.push(
          <Box key={`stream-line-${sli}`} paddingLeft={2}>
            <Text>
              {line}
              {isLast && <Text color={theme?.colors?.primary ?? 'cyan'}>█</Text>}
            </Text>
          </Box>
        );
      });
    }

    return rows;
  }, [messages, streamPhase, streamedThinking, streamedContent, selectedModel, theme, columns]);

  return (
    <Box flexDirection="column" width={columns}>
      {/* Unified Top Controls: Status, Model Selector, Model Count */}
      <Box
        borderStyle="round"
        borderColor={isModelFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')}
        paddingX={1}
        flexDirection="column"
        width={columns}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" gap={1} alignItems="center">
            <StatusIndicator
              status={isConnected ? 'online' : 'offline'}
              label={isConnected ? 'Online' : 'Offline'}
              theme={theme}
            />
          </Box>

          <Box flexDirection="row" gap={1} alignItems="center">
            <Text bold color={isModelFocused ? (theme?.colors?.focus ?? 'green') : 'cyan'}>
              Model: <Text color="white">{selectedModel}</Text>
            </Text>
            <Text color="gray" dimColor>
              {isModelFocused ? '[↑/↓ Choose • Enter]' : '[Tab Switch]'}
            </Text>
          </Box>

          <Box flexDirection="row" gap={1} alignItems="center">
            <Text color="gray">Models: </Text>
            <Badge variant="info">{String(models.length || 0)}</Badge>
          </Box>
        </Box>

        {isModelFocused && (
          <Box marginTop={1} flexDirection="column">
            <Select
              items={modelItems}
              onSelect={(item) => {
                setSelectedModel(item.value);
                show(`Model switched to ${item.value}`, 'info', 2500);
                setFocus(0);
              }}
              focus={isActive && isModelFocused}
              theme={theme}
              maxVisible={5}
            />
          </Box>
        )}
      </Box>

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
          <ScrollArea height={chatHeight} width={columns - 4} focus={isActive && isChatFocused} autoScroll={true} theme={theme}>
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
          placeholder="Type your message (Enter to send)..."
          focus={isActive && isInputFocused}
          theme={theme}
        />
      </Box>
      <Box paddingX={1} width={columns}>
        <Text color="gray" dimColor>
          {isModelFocused
            ? '↑/↓ Choose model • Enter Select • Esc/Tab to Input'
            : isChatFocused
              ? '↑/↓/j/k or Wheel Scroll • PgUp/PgDn Page • Home/End Top/Bottom • Esc to Input'
              : '↑/↓ History • Tab Focus • Ctrl+T System Tab • Enter Send • Ctrl+C Exit'}
        </Text>
      </Box>
    </Box>
  );
};

export default Chat;