import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '../components/ui/text-input';
import { Spinner } from '../components/ui/spinner';
import { Badge } from '../components/ui/badge';
import { StreamingText } from '../components/ui/streaming-text';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { Message } from '@nemesis-oss/ollama-sdk';
import { Select } from './ui/select';
import { useFocusManager } from './ui/hooks';

interface ChatMessage extends Message {
  timestamp?: number;
}

interface ChatProps {
  client: OllamaClient | null;
  messages: ChatMessage[];
  onSendMessage: (userMessage: string, assistantMessage?: string) => void;
  models?: string[];
  theme?: any;
}

const Chat: React.FC<ChatProps> = ({
  client,
  messages,
  onSendMessage,
  models = [],
  theme,
}) => {
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [streamingTokens, setStreamingTokens] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState(models[0] || 'qwen3:8b');

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

  const modelItems = (models.length > 0 ? models : ['qwen3:8b', 'llama3.2', 'mistral']).map(
    (m) => ({ label: m, value: m }),
  );

  const handleSendMessage = async (message: string) => {
    if (!message.trim() || !client || isThinking) return;

    setInput('');
    setIsThinking(true);
    setStreamingTokens([]);

    try {
      const stream = await client.chatStream({
        model: selectedModel,
        messages: [...messages, { role: 'user', content: message }],
        think: 'high',
        options: { temperature: 0.7 },
      });

      for await (const event of stream) {
        if (event.type === 'thinking' || event.type === 'token') {
          setStreamingTokens((prev) => [...prev, event.data.delta]);
        }
      }

      const finalResponse = await stream.finalResult;
      const assistantText = finalResponse.message?.content || streamingTokens.join('');
      onSendMessage(message, assistantText);
    } catch (error) {
      console.error('Chat error:', error);
    } finally {
      setIsThinking(false);
      setStreamingTokens([]);
    }
  };

  const maxVisibleMessages = 5;
  const visibleMessages = messages.slice(-maxVisibleMessages);
  const hiddenCount = Math.max(0, messages.length - maxVisibleMessages);

  return (
    <Box flexDirection="column" flexGrow={1} marginY={1}>
      {/* Model Selection Header */}
      <Box
        borderStyle="round"
        borderColor={isModelFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')}
        paddingX={1}
        flexDirection="column"
        marginBottom={1}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color={isModelFocused ? (theme?.colors?.focus ?? 'green') : 'cyan'}>
            Model: <Text color="white">{selectedModel}</Text>
          </Text>
          <Text color="gray" dimColor>
            {isModelFocused ? '[↑/↓ Choose • Enter Confirm]' : '[Press Tab to change model]'}
          </Text>
        </Box>

        {isModelFocused && (
          <Box marginTop={1} flexDirection="column">
            <Select
              items={modelItems}
              onSelect={(item) => {
                setSelectedModel(item.value);
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
        flexGrow={1}
        paddingX={1}
        paddingY={1}
        minHeight={8}
      >
        {messages.length === 0 ? (
          <Box flexDirection="column" alignItems="center" justifyContent="center" paddingY={2}>
            <Text color="gray" dimColor>No messages yet.</Text>
            <Text color="gray" dimColor>
              Type a prompt below and press Enter to chat with {selectedModel}.
            </Text>
          </Box>
        ) : (
          <>
            {hiddenCount > 0 && (
              <Box marginBottom={1} justifyContent="center">
                <Text color="gray" dimColor>
                  ── {hiddenCount} earlier messages hidden ──
                </Text>
              </Box>
            )}
            {visibleMessages.map((message, index) => (
              <Box key={index} flexDirection="column" marginBottom={1}>
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
                <Box paddingLeft={2} marginTop={0}>
                  <Text>{message.content}</Text>
                </Box>
              </Box>
            ))}
          </>
        )}

        {/* Streaming indicator */}
        {isThinking && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Spinner type="dots" />
              <Text color="yellow"> Generating response from {selectedModel}...</Text>
            </Box>
            {streamingTokens.length > 0 && (
              <Box paddingLeft={2} marginTop={1}>
                <StreamingText text={streamingTokens.join('')} />
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Input Area */}
      <Box
        borderStyle="round"
        borderColor={isInputFocused ? (theme?.colors?.focus ?? 'green') : (theme?.colors?.border ?? 'gray')}
        paddingX={1}
        marginTop={1}
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
      <Box marginTop={0} paddingX={1}>
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