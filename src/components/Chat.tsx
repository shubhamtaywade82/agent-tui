import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '../components/ui/text-input';
import { Spinner } from '../components/ui/spinner';
import { Badge } from '../components/ui/badge';
import { StatusIndicator } from '../components/ui/status-indicator';
import { StreamingText } from '../components/ui/streaming-text';
import { Typewriter } from '../components/ui/typewriter';
import { OllamaClient, Message } from '@nemesis-oss/ollama-sdk';
import { Select } from './ui/select';
import { ToastStack, useToast } from './ui/toast';
import { Markdown } from './ui/markdown';
import { ScrollArea } from './ui/scroll-area';
import { useFocusManager } from './ui/hooks';

interface ChatMessage extends Message {
  timestamp?: number;
  thinking?: string;
}

interface ChatProps {
  client: OllamaClient | null;
  messages: ChatMessage[];
  onSendMessage: (userMessage: string, assistantMessage?: string, thinking?: string) => void;
  models?: string[];
  isConnected?: boolean;
  theme?: any;
}

const Chat: React.FC<ChatProps> = ({
  client, messages, onSendMessage, models = [], isConnected = false, theme,
}) => {
  const [input, setInput] = useState('');
  const [streamPhase, setStreamPhase] = useState<'idle' | 'thinking' | 'responding'>('idle');
  const [streamedThinking, setStreamedThinking] = useState('');
  const [streamedContent, setStreamedContent] = useState('');
  const [selectedModel, setSelectedModel] = useState(models[0] || 'qwen3:8b');
  const { toasts, show, dismiss } = useToast();

  const { isFocused, setFocus } = useFocusManager({
    count: 3,
    initialIndex: 2, // Start focus on chat input
  });
  const isModelFocused = isFocused(0);
  const isChatFocused = isFocused(1);
  const isInputFocused = isFocused(2);

  useInput((_input, key) => {
    if (key.escape && !isInputFocused) {
      setFocus(2);
    }
  });

  useEffect(() => {
    if (models.length > 0 && !models.includes(selectedModel)) {
      setSelectedModel(models[0]!);
    }
  }, [models, selectedModel]);

  const modelItems = (models.length > 0 ? models : [selectedModel]).map(
    (m) => ({ label: m, value: m }),
  );

  const handleSendMessage = async (message: string) => {
    if (!message.trim() || !client || streamPhase !== 'idle') return;

    setInput('');
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
      onSendMessage(message, assistantText, accumulatedThinking || undefined);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      show(`Error: ${errorMsg}`, 'error', 4000);
      onSendMessage(message, `⚠️ Error: ${errorMsg}`);
    } finally {
      setStreamPhase('idle');
      setStreamedThinking('');
      setStreamedContent('');
    }
  };

  const messageRows: React.ReactNode[] = [];
  messages.forEach((msg, mi) => {
    messageRows.push(
      <Box key={`h-${mi}`} flexDirection="row" gap={1} alignItems="center">
        <Badge variant={msg.role === 'user' ? 'info' : 'success'}>
          {msg.role === 'user' ? 'You' : 'AI'}
        </Badge>
        {msg.timestamp && (
          <Text color="gray" dimColor>
            {new Date(msg.timestamp).toLocaleTimeString()}
          </Text>
        )}
      </Box>
    );

    if (msg.thinking) {
      messageRows.push(
        <Box key={`t-${mi}`} paddingLeft={2}>
          <Text color="yellow" dimColor>
            💭 Reasoning ({Math.ceil(msg.thinking.length / 4)} tokens)
          </Text>
        </Box>
      );
    }

    const lines = msg.content.split('\n');
    lines.forEach((line, li) => {
      messageRows.push(
        <Box key={`c-${mi}-${li}`} paddingLeft={2}>
          {msg.role === 'assistant' ? (
            <Markdown content={line} theme={theme} />
          ) : (
            <Text>{line}</Text>
          )}
        </Box>
      );
    });
  });

  return (
    <Box flexDirection="column">
      {/* Unified Top Controls: Status, Model Selector, Model Count */}
      <Box
        borderStyle="round"
        borderColor={isModelFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')}
        paddingX={1}
        flexDirection="column"
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
                setFocus(2);
              }}
              focus={isModelFocused}
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
      >
        {messageRows.length === 0 ? (
          <Box flexDirection="column" alignItems="center" justifyContent="center">
            <Typewriter
              text="Ready. Select a model with Tab, type your prompt, and press Enter..."
              speed={45}
              cursorChar="▌"
              theme={theme}
            />
          </Box>
        ) : (
          <ScrollArea
            height={7}
            focus={isChatFocused}
            autoScroll={true}
            theme={theme}
          >
            {messageRows}
          </ScrollArea>
        )}

        {/* Streaming indicator: Phase 1 (Reasoning) */}
        {streamPhase === 'thinking' && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Spinner type="dots" />
            <Text color="yellow"> {selectedModel} is thinking...</Text>
            {streamedThinking.length > 0 && (
              <Text color="gray" dimColor>
                ({Math.ceil(streamedThinking.length / 4)} tokens)
              </Text>
            )}
          </Box>
        )}

        {/* Streaming indicator: Phase 2 (Proper Token Streaming) */}
        {streamPhase === 'responding' && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center">
              <Badge variant="success">AI</Badge>
              <Text color="green" dimColor>streaming</Text>
            </Box>
            <Box paddingLeft={2}>
              <StreamingText
                text={streamedContent.split('\n').slice(-4).join('\n')}
                streaming={true}
                cursor="█"
                cursorBlinkSpeed={530}
                theme={theme}
              />
            </Box>
          </Box>
        )}
      </Box>

      {/* Toast Notification Stack - on top of TextInput */}
      {toasts.length > 0 && (
        <Box paddingX={1}>
          <ToastStack toasts={toasts.slice(-1)} onDismiss={dismiss} theme={theme} />
        </Box>
      )}

      {/* Input Area */}
      <Box
        borderStyle="round"
        borderColor={isInputFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')}
        paddingX={1}
      >
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSendMessage}
          placeholder="Type your message (Enter to send)..."
          focus={isInputFocused}
          theme={theme}
        />
      </Box>
      <Box paddingX={1}>
        <Text color="gray" dimColor>
          {isModelFocused
            ? '↑/↓ Choose model • Enter Select • Esc to Input'
            : isChatFocused
              ? '↑/↓/PgUp/PgDn Scroll • g/G Top/End • Esc to Input'
              : 'Tab Focus (Model/Chat/Input) • Enter Send • Ctrl+C Exit'}
        </Text>
      </Box>
    </Box>
  );
};

export default Chat;