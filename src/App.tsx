import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useWindowSize } from '@nemesis-oss/termina-core';
import { ThemeProvider, defaultTheme } from '@nemesis-oss/termina-ui';
import { StatusIndicator } from './components/ui/status-indicator/index.js';
import { Badge } from './components/ui/badge/index.js';
import { Select } from './components/ui/select/index.js';
import { ClickableSelect } from './components/ui/clickable-select/index.js';
import { useListNavigation } from './components/ui/hooks/index.js';
import { Tabs } from './components/ui/tabs/index.js';
import type { Tab } from './components/ui/tabs/index.js';
import { Divider } from './components/ui/divider/index.js';
import { Dialog } from './components/ui/dialog/index.js';
import { useMouseTrackingShim } from './components/ui/mouse/index.js';
import Chat, { type ChatMessage } from './components/Chat.js';
import StatusBar from './components/StatusBar.js';
import GenUIPanel from './components/GenUIPanel.js';
import { useOllama } from './hooks/useOllama.js';
import { myTheme } from './theme.js';
import { readFileSync } from 'node:fs';
import { closeMcpServers, loadAvailableSkills, loadUserConfig, saveUserConfig, findSkillFile } from './tools.js';
import { isAutoMode } from './auto-mode.js';
import { SupervisorPanel } from './components/SupervisorPanel.js';

export type ModalType = 'model' | 'clear' | 'skills' | null;

const TABS: Tab[] = [
  { key: 'chat', label: '💬 Chat' },
  { key: 'system', label: '📊 System' },
  { key: 'genui', label: '🎨 GenUI' },
  { key: 'supervisor', label: '⚡ Supervisor' },
];

const App: React.FC = () => {
  const autoMode = isAutoMode();
  // Upstream termina-core 0.1.0 ships a corrupted mouseTrackingEnable escape
  // sequence — without this shim the framework's hit-tested Box onClick /
  // onWheel handlers never receive any reports. See ui/mouse/mouseTrackingShim.
  useMouseTrackingShim();
  // Sync FS scan — must not run per render frame (it did before).
  const availableSkills = useMemo(() => loadAvailableSkills(), []);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = loadUserConfig();
    return saved.systemPrompt ? [{ role: 'system', content: saved.systemPrompt, timestamp: Date.now() }] : [];
  });
  const [isConnected, setIsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('chat');
  const [activeModal, setActiveModal] = useState<ModalType>(null);

  const { client, models, isLoading } = useOllama();
  const { columns, rows } = useWindowSize();
  const [selectedModel, setSelectedModel] = useState<string>(() => loadUserConfig().model || '');

  // Keyboard navigation for the model selector modal — only active when
  // the model modal is open. Up/Down moves the highlight, Enter selects,
  // Escape closes (handled by the existing useInput handler below).
  const modelNav = useListNavigation({
    length: models.length,
    onSelect: (i) => {
      const model = models[i];
      if (model) {
        setSelectedModel(model);
        saveUserConfig({ model });
        setActiveModal(null);
      }
    },
    isActive: activeModal === 'model',
  });

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
      setActiveTab((prev) =>
        prev === 'chat' ? 'system' : prev === 'system' ? 'genui' : prev === 'genui' ? 'supervisor' : 'chat');
      return;
    }
    if ((key.ctrl && input === 'o') || input === '\x0f' || input === '\x1bOR') {
      if (models.length > 0) setActiveModal((p) => (p === 'model' ? null : 'model'));
    }
    if ((activeTab === 'system' || activeTab === 'genui' || activeTab === 'supervisor') && !activeModal) {
      if (input === '1' || input === 'c' || key.escape || key.leftArrow) setActiveTab('chat');
      else if (input === '2' || input === 's') setActiveTab('system');
      else if (input === '3' || input === 'g') setActiveTab('genui');
      else if (input === '4' || input === 'v') setActiveTab('supervisor');
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
        <Box onClick={() => setActiveModal((prev) => (prev === 'skills' ? null : 'skills'))}>
          <Badge variant="info">{`📚 ${availableSkills.length} Skills`}</Badge>
        </Box>
        {autoMode && <Badge variant="warning">AUTO</Badge>}
        <Box
          flexDirection="row"
          gap={1}
          alignItems="center"
          onClick={() => {
            if (models.length > 0) setActiveModal((prev) => (prev === 'model' ? null : 'model'));
          }}
        >
          <Text bold color={activeModal === 'model' ? (myTheme.colors.focus ?? 'green') : 'cyan'}>
            Model: <Text color="white">{selectedModel || 'none'}</Text>
          </Text>
          <Badge variant="info">{String(models.length || 0)}</Badge>
        </Box>
      </Box>
      {columns >= 90 && (
        <Box
          flexDirection="row"
          alignItems="center"
          onClick={() => {
            if (activeModal) setActiveModal(null);
          }}
        >
          <Text color="gray" dimColor>{activeModal ? '[Esc Close Modal]' : '[Ctrl+O Model • Ctrl+T View]'}</Text>
        </Box>
      )}
    </Box>
  );

  if (isLoading) {
    return (
      <ThemeProvider theme={defaultTheme}>
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
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={defaultTheme}>
      <Box flexDirection="column" width={columns}>
        {/* Top Header */}
        {renderStatusLine()}
        <Divider width={columns} theme={myTheme} style={activeModal ? 'bold' : 'single'} />

        {activeModal ? (
          <Box
            height={rows - 4}
            width={columns}
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
          >
            {activeModal === 'model' && (
              <Box flexDirection="column" borderStyle="round" borderColor={myTheme.colors.primary} paddingX={2} paddingY={1} width={Math.min(64, columns - 4)}>
                <Text bold color={myTheme.colors.primary}>Select Ollama Model</Text>
                <Text color="gray" dimColor>Current: {selectedModel || 'none'}</Text>
                <Box marginTop={1}>
                  <ClickableSelect
                    options={models.map((m) => ({
                      label: `${m === selectedModel ? '● ' : '○ '}${m}`,
                      value: m,
                      icon: m === selectedModel ? '●' : '○',
                    }))}
                    activeIndex={modelNav.activeIndex}
                    onActiveChange={modelNav.setActiveIndex}
                    onSelect={(value) => {
                      setSelectedModel(value);
                      saveUserConfig({ model: value });
                      setActiveModal(null);
                    }}
                    visibleOptionCount={6}
                    color="white"
                    theme={myTheme}
                  />
                </Box>
                <Box marginTop={1} onClick={() => setActiveModal(null)}>
                  <Text color="gray" dimColor>[↑/↓ Navigate • Enter Select • Click to Select • Esc Close]</Text>
                </Box>
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
                    items={availableSkills.map((s) => ({ label: `${s.name} [${s.pack}/${s.family}] - ${s.triggers.slice(0, 28) || 'standard'}`, value: s.name }))}
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
                <Box marginTop={1} onClick={() => setActiveModal(null)}>
                  <Text color="gray" dimColor>[↑/↓ Navigate • Enter Load Skill • Esc Close]</Text>
                </Box>
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
                autoMode={autoMode}
              />
            </Box>
            <Box display={activeTab === 'system' ? 'flex' : 'none'} width={columns} flexDirection="column">
              <StatusBar client={client} tokenCount={calculateTokenCount()} theme={myTheme} width={columns} />
            </Box>
            <Box display={activeTab === 'genui' ? 'flex' : 'none'} width={columns} flexDirection="column">
              <GenUIPanel width={columns} height={Math.max(6, rows - 4)} theme={myTheme} isActive={activeTab === 'genui'} />
            </Box>
            <Box display={activeTab === 'supervisor' ? 'flex' : 'none'} width={columns} flexDirection="column">
              <SupervisorPanel
                width={columns}
                height={Math.max(6, rows - 4)}
                theme={myTheme}
                isActive={activeTab === 'supervisor'}
                pollMs={5_000}
              />
            </Box>
          </>
        )}
      </Box>
    </ThemeProvider>
  );
};

export default App;