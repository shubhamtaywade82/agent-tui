import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '../components/ui/text-input';
import { Spinner } from '../components/ui/spinner';
import { Badge } from '../components/ui/badge';
import { StatusIndicator } from '../components/ui/status-indicator';
import { StreamingText } from '../components/ui/streaming-text';
import { Typewriter } from '../components/ui/typewriter';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { Message } from '@nemesis-oss/ollama-sdk';
import { Select } from './ui/select';
import { ToastStack, useToast } from './ui/toast';
import { useFocusManager } from './ui/hooks';

interface ChatMessage extends Message {
  timestamp?: number;
  thinking?: string;
}

interface ChatProps {
  client: OllamaClient | null;
  messages: ChatMessage[];
  onSendMessage: (
    userMessage: string,
    assistantMessage?: string,
    thinking?: string,
  ) => void;
  models?: string[];
  isConnected?: boolean;
  theme?: any;
}

const Chat: React.FC<ChatProps> = ({
  client,
  messages,
  onSendMessage,
  models = [],
  isConnected = false,
  theme,
}) => {
  const [input, setInput] = useState('');
  const [streamPhase, setStreamPhase] = useState<'idle' | 'thinking' | 'responding'>('idle');
  const [streamedThinking, setStreamedThinking] = useState('');
  const [streamedContent, setStreamedContent] = useState('');
  const [selectedModel, setSelectedModel] = useState(models[0] || 'qwen3:8b');
  const { toasts, show, dismiss } = useToast();

  const { isFocused, setFocus } = useFocusManager({
    count: 2,
    initialIndex: 1, // Start focus on chat input
  });
  const isModelFocused = isFocused(0);
  const isInputFocused = isFocused(1);

  useInput((_input, key) => {
    if (key.escape && isModelFocused) {
      setFocus(1);
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

  const maxVisibleMessages = 3;
  const visibleMessages = messages.slice(-maxVisibleMessages);
  const hiddenCount = Math.max(0, messages.length - maxVisibleMessages);

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
                setFocus(1);
              }}
              focus={isModelFocused}
              theme={theme}
              maxVisible={5}
            />
          </Box>
        )}
      </Box>

      {/* Messages Conversation Panel */}
      <Box
        borderStyle="single"
        borderColor={theme?.colors?.border ?? 'gray'}
        flexDirection="column"
        paddingX={1}
        minHeight={5}
      >
        {messages.length === 0 ? (
          <Box flexDirection="column" alignItems="center" justifyContent="center">
            <Typewriter
              text="Ready. Select a model with Tab, type your prompt, and press Enter..."
              speed={45}
              cursorChar="▌"
              theme={theme}
            />
          </Box>
        ) : (
          <>
            {hiddenCount > 0 && (
              <Box justifyContent="center">
                <Text color="gray" dimColor>
                  ── {hiddenCount} earlier messages hidden ──
                </Text>
              </Box>
            )}
            {visibleMessages.map((message, index) => (
              <Box key={index} flexDirection="column">
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Badge variant={message.role === 'user' ? 'info' : 'success'}>
                    {message.role === 'user' ? 'You' : 'AI'}
                  </Badge>
                  {message.timestamp ? (
                    <Text color="gray" dimColor>
                      {new Date(message.timestamp).toLocaleTimeString()}
                    </Text>
                  ) : null}
                </Box>
                {message.thinking ? (
                  <Box paddingLeft={2}>
                    <Text color="yellow" dimColor>
                      💭 Reasoning ({Math.ceil(message.thinking.length / 4)} tokens)
                    </Text>
                  </Box>
                ) : null}
                <Box paddingLeft={2}>
                  <Text>{message.content}</Text>
                </Box>
              </Box>
            ))}
          </>
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
            ? '↑/↓ Choose model • Enter Select • Esc/Tab back to Chat'
            : 'Tab Change Model • Enter Send Message • Ctrl+C Exit'}
        </Text>
      </Box>
    </Box>
  );
};

export default Chat;