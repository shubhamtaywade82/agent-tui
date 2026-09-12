import React, { useState, useEffect } from 'react';
import { Box } from 'ink';
import { Header } from './components/ui/header';
import { StatusIndicator } from './components/ui/status-indicator';
import Chat from './components/Chat';
import StatusBar from './components/StatusBar';
import { useOllama } from './hooks/useOllama';
import { myTheme } from './theme';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  tokens?: number;
  thinking?: string;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const { client, models, healthCheck, isLoading } = useOllama();

  useEffect(() => {
    if (client) {
      setIsConnected(true);
    }
  }, [client]);

  const handleSendMessage = (
    userMessage?: string,
    assistantMessage?: string,
    thinking?: string,
  ) => {
    setMessages((prev) => {
      const next: Message[] = [...prev];
      if (userMessage) {
        next.push({
          role: 'user',
          content: userMessage,
          timestamp: Date.now(),
        });
      }
      if (assistantMessage) {
        next.push({
          role: 'assistant',
          content: assistantMessage,
          timestamp: Date.now(),
          thinking,
        });
      }
      return next;
    });
  };

  const calculateTokenCount = () => {
    return messages.reduce(
      (acc, msg) => acc + (msg.tokens ?? Math.ceil(msg.content.length / 4)),
      0,
    );
  };

  if (isLoading) {
    return (
      <Box flexDirection="column">
        <Header
          title="Ollama TUI Harness"
          version="1.0.0"
          subtitle="Terminal AI Agent & LLM Playground"
          theme={myTheme}
        />
        <Box marginTop={1} paddingX={1}>
          <StatusIndicator
            status="loading"
            label="Initializing Ollama client..."
            theme={myTheme}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header
        title="Ollama TUI Harness"
        version="1.0.0"
        subtitle="Terminal AI Agent & LLM Playground"
        theme={myTheme}
      />

      {/* Main Chat Interface with Integrated Top Controls */}
      <Chat
        client={client}
        messages={messages}
        onSendMessage={handleSendMessage}
        models={models}
        isConnected={isConnected}
        theme={myTheme}
      />

      {/* Status Bar */}
      <StatusBar
        client={client}
        tokenCount={calculateTokenCount()}
        theme={myTheme}
      />
    </Box>
  );
};

export default App;