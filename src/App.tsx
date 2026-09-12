import React, { useState, useEffect } from 'react';
import { Box, Text, Newline } from 'ink';
import { Header } from './components/ui/header';
import { Badge } from './components/ui/badge';
import { Toast } from './components/ui/toast';
import { ProgressBar } from './components/ui/progress-bar';
import { Select } from './components/ui/select';
import { Dialog } from './components/ui/dialog';
import { StatusIndicator } from './components/ui/status-indicator';
import { Chat } from './components/Chat';
import { StatusBar } from './components/StatusBar';
import { useOllama } from './hooks/useOllama';
import { myTheme } from './theme';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  tokens?: number;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [showThinking, setShowThinking] = useState(false);

  const { client, models, healthCheck, isLoading } = useOllama();

  useEffect(() => {
    if (client) {
      setIsConnected(true);
    }
  }, [client]);

  if (isLoading) {
    return (
      <Box>
        <Header title="Ollama TUI Harness" version="1.0.0" />
        <StatusIndicator status="loading" label="Initializing Ollama client..." />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Header
        title="Ollama TUI Harness"
        version="1.0.0"
        theme={myTheme}
      />

      {/* Connection Status */}
      <Box marginY={1}>
        <StatusIndicator
          status={isConnected ? 'connected' : 'disconnected'}
          label={isConnected ? 'Connected' : 'Disconnected'}
          theme={myTheme}
        />
        <Badge color={isConnected ? 'green' : 'red'}>
          {isConnected ? 'Online' : 'Offline'}
        </Badge>
      </Box>

      {/* Main Chat Interface */}
      <Chat
        client={client}
        messages={messages}
        onSendMessage={handleSendMessage}
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