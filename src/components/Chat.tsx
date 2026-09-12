import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '../ui/text-input';
import { Spinner } from '../ui/spinner';
import { Badge } from '../ui/badge';
import { StreamingText } from '../ui/streaming-text';
import { TokenCounter } from '../ui/token-counter';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

interface ChatProps {
  client: OllamaClient | null;
  messages: Message[];
  onSendMessage: (message: string) => void;
  theme?: any;
}

const Chat: React.FC<ChatProps> = ({ client, messages, onSendMessage, theme }) => {
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [streamingTokens, setStreamingTokens] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('qwen3:8b');

  const handleSendMessage = async (message: string) => {
    if (!message.trim() || !client) return;

    setIsThinking(true);
    setStreamingTokens([]);

    try {
      // Start streaming response
      const stream = await client.chatStream({
        model: selectedModel,
        messages: [...messages, { role: 'user', content: message }],
        think: 'high',
        options: { temperature: 0.7 }
      });

      for await (const event of stream) {
        if (event.type === 'thinking') {
          setStreamingTokens(prev => [...prev, event.data.delta]);
        } else if (event.type === 'token') {
          setStreamingTokens(prev => [...prev, event.data.delta]);
        }
      }

      const finalResponse = await stream.finalResult;
      onSendMessage(message);

    } catch (error) {
      console.error('Chat error:', error);
    } finally {
      setIsThinking(false);
    }
  };

  return (
    <Box flexDirection="column" flexGrow={1} marginY={1}>
      {/* Model Selector */}
      <Box marginBottom={1}>
        <Select
          label="Select Model"
          items={[
            { label: 'Qwen3 8B', value: 'qwen3:8b' },
            { label: 'Llama3.2', value: 'llama3.2' },
            { label: 'Mistral', value: 'mistral' }
          ]}
          onSelect={setSelectedModel}
          theme={theme}
        />
      </Box>

      {/* Messages Display */}
      <Box flexDirection="column" flexGrow={1} overflowY="scroll">
        {messages.map((message, index) => (
          <Box key={index} marginBottom={1}>
            {message.role === 'user' && (
              <Badge color="blue">You:</Badge>
            )}
            {message.role === 'assistant' && (
              <Badge color="green">AI:</Badge>
            )}
            <Text>{message.content}</Text>
          </Box>
        ))}

        {/* Streaming indicator */}
        {isThinking && (
          <Box>
            <Spinner type="dots" label="Generating response..." />
            {streamingTokens.length > 0 && (
              <StreamingText text={streamingTokens.join('')} />
            )}
          </Box>
        )}
      </Box>

      {/* Input Area */}
      <Box>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSendMessage}
          placeholder="Type your message..."
          theme={theme}
        />
      </Box>
    </Box>
  );
};

export default Chat;