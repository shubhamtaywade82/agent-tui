import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { StatusIndicator } from './components/ui/status-indicator/index.js';
import { Badge } from './components/ui/badge/index.js';
import { Select } from './components/ui/select/index.js';
import { Tabs } from './components/ui/tabs/index.js';
import type { Tab } from './components/ui/tabs/index.js';
import { Divider } from './components/ui/divider/index.js';
import { Dialog } from './components/ui/dialog/index.js';
import Chat, { type ChatMessage } from './components/Chat.js';
import StatusBar from './components/StatusBar.js';
import { useOllama } from './hooks/useOllama.js';
import { useTerminalSize } from './components/ui/hooks/index.js';
import { myTheme } from './theme.js';
import { readFileSync } from 'node:fs';
import { closeMcpServers, loadAvailableSkills, loadUserConfig, saveUserConfig, findSkillFile } from './tools.js';

export type ModalType = 'model' | 'clear' | 'skills' | null;

const TABS: Tab[] = [
  { key: 'chat', label: '💬 Chat' },
  { key: 'system', label: '📊 System' },
];

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = loadUserConfig();
    return saved.systemPrompt ? [{ role: 'system', content: saved.systemPrompt, timestamp: Date.now() }] : [];
  });
  const [isConnected, setIsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('chat');
  const [activeModal, setActiveModal] = useState<ModalType>(null);

  const { client, models, isLoading } = useOllama();
  const { columns, rows } = useTerminalSize();
  const [selectedModel, setSelectedModel] = useState<string>(() => loadUserConfig().model || '');

  useEffect(() => {
    if (client) setIsConnected(true);
    return () => { closeMcpServers().catch(() => undefined); };
  }, [client]);

  useEffect(() => {
    if (models.length > 0 && (!selectedModel || !models.includes(selectedModel))) {
      const saved = loadUserConfig().model;
      const initial = saved && models.includes(saved) ? saved : models[0]!;
      setSelectedModel(initial);
      saveUserConfig({ model: initial });
    }
  }, [models, selectedModel]);

  useInput((input, key) => {
    if (activeModal && key.escape) { setActiveModal(null); return; }
    if ((key.ctrl && input === 't') || input === '\x14') {
      setActiveModal(null);
      setActiveTab((prev) => (prev === 'chat' ? 'system' : 'chat'));
      return;
    }
    if ((key.ctrl && input === 'o') || input === '\x0f' || input === '\x1bOR') {
      if (models.length > 0) setActiveModal((p) => (p === 'model' ? null : 'model'));
    }
    if (activeTab === 'system' && !activeModal) {
      if (input === '1' || input === 'c' || key.escape || key.leftArrow) setActiveTab('chat');
      else if (input === 'm' || input === 'o') setActiveModal('model');
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

  const renderStatusLine = () => (
    <Box paddingX={1} width={columns} flexDirection="row" justifyContent="space-between" alignItems="center">
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text bold color={myTheme.colors.primary}>⚡ Agentic TUI</Text>
        <Tabs
          tabs={TABS}
          activeKey={activeTab}
          onChange={(tab) => { setActiveModal(null); setActiveTab(tab); }}
          variant="pills"
          focus={false}
          theme={myTheme}
        />
      </Box>
      <Box flexDirection="row" gap={2} alignItems="center">
        <StatusIndicator status={isConnected ? 'online' : 'offline'} label={isConnected ? 'Online' : 'Offline'} theme={myTheme} />
        <Badge variant="success">MCP Active</Badge>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text bold color={activeModal === 'model' ? (myTheme.colors.focus ?? 'green') : 'cyan'}>
            Model: <Text color="white">{selectedModel || 'none'}</Text>
          </Text>
          <Badge variant="info">{String(models.length || 0)}</Badge>
        </Box>
      </Box>
      {columns >= 90 && (
        <Box flexDirection="row" alignItems="center">
          <Text color="gray" dimColor>{activeModal ? '[Esc Close Modal]' : '[Ctrl+O Model • Ctrl+T View]'}</Text>
        </Box>
      )}
    </Box>
  );

  if (isLoading) {
    return (
      <Box flexDirection="column" width={columns}>
        <Box paddingX={1} flexDirection="row" justifyContent="space-between" alignItems="center" width={columns}>
          <Text bold color={myTheme.colors.primary}>
            ⚡ Agentic TUI <Text color="gray" dimColor>v1.0.0</Text>
          </Text>
        </Box>
        <Divider width={columns} theme={myTheme} />
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
      {/* Top Header */}
      {renderStatusLine()}
      <Divider width={columns} theme={myTheme} style={activeModal ? 'bold' : 'single'} />

      {activeModal ? (
        <Box height={Math.max(6, rows - 4)} width={columns} alignItems="center" paddingTop={Math.max(1, Math.floor((rows - 16) / 2))}>
          {activeModal === 'model' && (
            <Box flexDirection="column" borderStyle="round" borderColor={myTheme.colors.primary} paddingX={2} paddingY={1} width={Math.min(64, columns - 4)}>
              <Text bold color={myTheme.colors.primary}>Select Ollama Model</Text>
              <Text color="gray" dimColor>Current: {selectedModel || 'none'}</Text>
              <Box marginTop={1}>
                <Select
                  items={models.map((m) => ({ label: `${m === selectedModel ? '● ' : '○ '}${m}${m === selectedModel ? ' (active)' : ''}`, value: m }))}
                  onSelect={(item) => { setSelectedModel(item.value); saveUserConfig({ model: item.value }); setActiveModal(null); }}
                  focus={true} theme={myTheme} maxVisible={6}
                />
              </Box>
              <Box marginTop={1}><Text color="gray" dimColor>[↑/↓ Navigate • Enter Select • Esc Close]</Text></Box>
            </Box>
          )}

          {activeModal === 'clear' && (
            <Dialog
              isOpen={true} title="Clear Chat History" message="Are you sure you want to clear all chat messages?"
              actions={[{ label: 'Clear History', value: 'clear' }, { label: 'Cancel', value: 'cancel' }]}
              onAction={(a) => { if (a.value === 'clear') setMessages([]); setActiveModal(null); }}
              onDismiss={() => setActiveModal(null)} theme={myTheme}
            />
          )}

          {activeModal === 'skills' && (
            <Box flexDirection="column" borderStyle="round" borderColor={myTheme.colors.primary} paddingX={2} paddingY={1} width={Math.min(74, columns - 4)}>
              <Text bold color={myTheme.colors.primary}>Engineering Skills (ruby + react + node packs)</Text>
              <Text color="gray" dimColor>Select a skill to load into session instructions:</Text>
              <Box marginTop={1}>
                <Select
                  items={loadAvailableSkills().map((s) => ({ label: `${s.name} [${s.pack}/${s.family}] - ${s.triggers.slice(0, 28) || 'standard'}`, value: s.name }))}
                  onSelect={(item) => {
                    const file = findSkillFile(item.value);
                    if (file) {
                      setMessages((prev) => [{ role: 'system', content: `[Skill loaded: ${item.value}]\n\n${readFileSync(file, 'utf8')}`, timestamp: Date.now() }, ...prev]);
                    }
                    setActiveModal(null);
                  }}
                  focus={true} theme={myTheme} maxVisible={6}
                />
              </Box>
              <Box marginTop={1}><Text color="gray" dimColor>[↑/↓ Navigate • Enter Load Skill • Esc Close]</Text></Box>
            </Box>
          )}
        </Box>
      ) : (
        <>
          <Box display={activeTab === 'chat' ? 'flex' : 'none'} width={columns}>
            <Chat
              client={client} messages={messages} onSendMessage={handleSendMessage} setMessages={setMessages}
              models={models} isConnected={isConnected} theme={myTheme} isActive={activeTab === 'chat'}
              columns={columns} rows={rows} selectedModel={selectedModel} onSelectModel={(m) => { setSelectedModel(m); saveUserConfig({ model: m }); }}
              isSelectingModel={Boolean(activeModal)} onOpenModal={(m) => setActiveModal(m)}
            />
          </Box>
          <Box display={activeTab === 'system' ? 'flex' : 'none'} width={columns} flexDirection="column">
            <StatusBar client={client} tokenCount={calculateTokenCount()} theme={myTheme} width={columns} />
          </Box>
        </>
      )}
    </Box>
  );
};

export default App;