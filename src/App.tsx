import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { StatusIndicator } from './components/ui/status-indicator/index.js';
import { Badge } from './components/ui/badge/index.js';
import { Select } from './components/ui/select/index.js';
import { Tabs } from './components/ui/tabs/index.js';
import type { Tab } from './components/ui/tabs/index.js';
import Chat, { type ChatMessage } from './components/Chat.js';
import StatusBar from './components/StatusBar.js';
import { useOllama } from './hooks/useOllama.js';
import { useTerminalSize } from './components/ui/hooks/index.js';
import { myTheme } from './theme.js';
import { closeMcpServers } from './tools.js';

const TABS: Tab[] = [
  { key: 'chat', label: '💬 Chat' },
  { key: 'system', label: '📊 System' },
];

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('chat');


  const { client, models, isLoading } = useOllama();
  const { columns, rows } = useTerminalSize();
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [isSelectingModel, setIsSelectingModel] = useState(false);

  useEffect(() => {
    if (client) setIsConnected(true);
    return () => { closeMcpServers().catch(() => undefined); };
  }, [client]);

  useEffect(() => {
    if (models.length > 0 && (!selectedModel || !models.includes(selectedModel))) {
      setSelectedModel(models[0]!);
    }
  }, [models, selectedModel]);

  useInput((input, key) => {
    // Global tab switcher with Ctrl+T or F1/F2
    if ((key.ctrl && input === 't') || input === '\x14') {
      setIsSelectingModel(false);
      setActiveTab((prev) => (prev === 'chat' ? 'system' : 'chat'));
      return;
    }
    if (input === '\x1bOP') { setIsSelectingModel(false); setActiveTab('chat'); return; }
    if (input === '\x1bOQ') { setIsSelectingModel(false); setActiveTab('system'); return; }

    // Toggle model selector with Ctrl+O or F3
    if ((key.ctrl && input === 'o') || input === '\x0f' || input === '\x1bOR') {
      if (models.length > 0) {
        setIsSelectingModel((prev) => !prev);
        return;
      }
    }

    if (isSelectingModel && key.escape) {
      setIsSelectingModel(false);
      return;
    }

    // On system tab, allow quick navigation
    if (activeTab === 'system' && !isSelectingModel) {
      if (input === '1' || input === 'c' || key.escape || key.leftArrow) {
        setActiveTab('chat');
      } else if (input === 'm' || input === 'o') {
        setIsSelectingModel(true);
      }
    }
  });

  const handleSendMessage = (
    userMessage?: string,
    assistantMessage?: string,
    thinking?: string,
    extra?: Partial<ChatMessage>,
  ) => {
    if (userMessage === '/clear') {
      setMessages([]);
      return;
    }
    setMessages((prev) => {
      const next: ChatMessage[] = [...prev];
      if (userMessage) {
        next.push({ role: 'user', content: userMessage, timestamp: Date.now() });
      }
      if (assistantMessage !== undefined || extra?.tool_calls || extra?.content !== undefined) {
        next.push({
          role: extra?.role ?? 'assistant',
          content: assistantMessage ?? extra?.content ?? '',
          timestamp: extra?.timestamp ?? Date.now(),
          thinking,
          tool_calls: extra?.tool_calls,
          tool_call_id: extra?.tool_call_id,
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
      <Box flexDirection="column" width={columns}>
        <Box
          borderStyle="round"
          borderColor={myTheme.colors.border}
          paddingX={1}
          width={columns}
        >
          <Text bold color={myTheme.colors.primary}>
            ⚡ Ollama TUI <Text color="gray" dimColor>v1.0.0</Text>
          </Text>
        </Box>
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
      {/* Unified Top Navigation & Controls Header (Single Line) */}
      <Box
        borderStyle="round"
        borderColor={isSelectingModel ? (myTheme.colors.focus ?? 'green') : (myTheme.colors.border ?? 'gray')}
        paddingX={1}
        flexDirection="column"
        width={columns}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" gap={2} alignItems="center">
            <Text bold color={myTheme.colors.primary}>
              ⚡ Ollama TUI
            </Text>
            <Tabs
              tabs={TABS}
              activeKey={activeTab}
              onChange={(tab) => {
                setIsSelectingModel(false);
                setActiveTab(tab);
              }}
              variant="pills"
              focus={false}
              theme={myTheme}
            />
          </Box>

          <Box flexDirection="row" gap={2} alignItems="center">
            <StatusIndicator
              status={isConnected ? 'online' : 'offline'}
              label={isConnected ? 'Online' : 'Offline'}
              theme={myTheme}
            />
            <Badge variant="success">MCP Active</Badge>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text bold color={isSelectingModel ? (myTheme.colors.focus ?? 'green') : 'cyan'}>
                Model: <Text color="white">{selectedModel || 'none'}</Text>
              </Text>
              <Badge variant="info">{String(models.length || 0)}</Badge>
            </Box>
          </Box>

          {columns >= 90 && (
            <Box flexDirection="row" alignItems="center">
              <Text color="gray" dimColor>
                {isSelectingModel ? '[↑/↓ Choose • Enter • Esc]' : '[Ctrl+O Model • Ctrl+T View]'}
              </Text>
            </Box>
          )}
        </Box>

        {/* Expandable Model Selector dropdown */}
        {isSelectingModel && models.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Select
              items={models.map((m) => ({ label: m, value: m }))}
              onSelect={(item) => {
                setSelectedModel(item.value);
                setIsSelectingModel(false);
              }}
              focus={isSelectingModel}
              theme={myTheme}
              maxVisible={5}
            />
          </Box>
        )}
      </Box>

      {/* Primary Chat View */}
      <Box display={activeTab === 'chat' ? 'flex' : 'none'} width={columns}>
        <Chat
          client={client}
          messages={messages}
          onSendMessage={handleSendMessage}
          setMessages={setMessages}
          models={models}
          isConnected={isConnected}
          theme={myTheme}
          isActive={activeTab === 'chat'}
          columns={columns}
          rows={rows}
          selectedModel={selectedModel}
          onSelectModel={setSelectedModel}
          isSelectingModel={isSelectingModel}
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