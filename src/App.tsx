import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Header } from './components/ui/header/index.js';
import { StatusIndicator } from './components/ui/status-indicator/index.js';
import { Tabs } from './components/ui/tabs/index.js';
import type { Tab } from './components/ui/tabs/index.js';
import Chat from './components/Chat.js';
import StatusBar from './components/StatusBar.js';
import { useOllama } from './hooks/useOllama.js';
import { useTerminalSize } from './components/ui/hooks/index.js';
import { myTheme } from './theme.js';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  tokens?: number;
  thinking?: string;
}

const TABS: Tab[] = [
  { key: 'chat', label: '💬 Chat' },
  { key: 'system', label: '📊 System & Hardware' },
];

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('chat');

  const { client, models, isLoading } = useOllama();
  const { columns } = useTerminalSize();

  useEffect(() => {
    if (client) setIsConnected(true);
  }, [client]);

  useInput((input, key) => {
    // Global tab switcher with Ctrl+T or F1/F2
    if ((key.ctrl && input === 't') || input === '\x14') {
      setActiveTab((prev) => (prev === 'chat' ? 'system' : 'chat'));
      return;
    }
    if (input === '\x1bOP') { setActiveTab('chat'); return; }
    if (input === '\x1bOQ') { setActiveTab('system'); return; }

    // On system tab, allow single-key return to chat
    if (activeTab === 'system' && (input === '1' || input === 'c' || key.escape || key.leftArrow)) {
      setActiveTab('chat');
    }
  });

  const handleSendMessage = (
    userMessage?: string,
    assistantMessage?: string,
    thinking?: string,
  ) => {
    setMessages((prev) => {
      const next: Message[] = [...prev];
      if (userMessage) {
        next.push({ role: 'user', content: userMessage, timestamp: Date.now() });
      }
      if (assistantMessage) {
        next.push({ role: 'assistant', content: assistantMessage, timestamp: Date.now(), thinking });
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
      <Box flexDirection="column" width={columns}>
        <Header
          title="Ollama TUI Harness"
          version="1.0.0"
          subtitle="Terminal AI Agent & LLM Playground"
          theme={myTheme}
          width={columns}
        />
        <Box marginTop={1} paddingX={1} width={columns}>
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
    <Box flexDirection="column" width={columns}>
      <Header
        title="Ollama TUI Harness"
        version="1.0.0"
        subtitle="Terminal AI Agent & LLM Playground"
        theme={myTheme}
        width={columns}
      />

      {/* Top Tab Navigation Bar */}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1} width={columns}>
        <Tabs
          tabs={TABS}
          activeKey={activeTab}
          onChange={setActiveTab}
          variant="boxed"
          focus={false}
          theme={myTheme}
        />
        <Text color="gray" dimColor>[Ctrl+T / F2: Switch View]</Text>
      </Box>

      {/* Primary Chat View (persists in memory when inactive) */}
      <Box display={activeTab === 'chat' ? 'flex' : 'none'} width={columns}>
        <Chat
          client={client}
          messages={messages}
          onSendMessage={handleSendMessage}
          models={models}
          isConnected={isConnected}
          theme={myTheme}
          isActive={activeTab === 'chat'}
        />
      </Box>

      {/* Dedicated System & Telemetry Tab */}
      <Box display={activeTab === 'system' ? 'flex' : 'none'} width={columns}>
        <StatusBar
          client={client}
          tokenCount={calculateTokenCount()}
          theme={myTheme}
          width={columns}
        />
      </Box>
    </Box>
  );
};

export default App;