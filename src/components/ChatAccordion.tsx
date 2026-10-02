import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from './ui/spinner/index.js';
import { Stepper, type Step } from './ui/stepper/index.js';
import { parseMarkdownBlocks, wrapTextLine } from './ui/markdown/index.js';
import { ScrollArea } from './ui/scroll-area/index.js';
import { Thinking } from './ui/thinking/index.js';
import { ToolCall } from './ui/tool-call/index.js';
import type { ChatMessage } from './Chat.js';

export interface TurnOptions {
  theme?: any;
  maxWidth: number;
  expandThinking?: boolean;
}

export interface StreamState {
  phase: string;
  model: string;
  thinking: string;
  content: string;
}

export interface ChatAccordionProps {
  messages: ChatMessage[];
  height: number;
  width: number;
  focus?: boolean;
  theme?: any;
}

const STEPS: Step[] = [
  { key: 'thinking', title: 'Think' },
  { key: 'executing-tools', title: 'Tools' },
  { key: 'responding', title: 'Respond' },
];

const formatTime = (ts?: number): string => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

export function renderMessageHeader(msg: ChatMessage, idx: number, showTime = true): React.ReactElement {
  const conf = msg.role === 'user'
    ? { icon: '❯', label: undefined, color: 'cyan' }
    : msg.role === 'tool'
    ? { icon: '⚙', label: 'Tool Output', color: 'yellow' }
    : msg.role === 'system'
    ? { icon: '◈', label: 'System', color: 'gray' }
    : { icon: '✦', label: undefined, color: 'green' };
  const time = msg.timestamp ? formatTime(msg.timestamp) : '';
  return (
    <Box key={`h-${idx}`} flexDirection="row" gap={1} alignItems="center">
      <Text bold color={conf.color}>{conf.icon}</Text>
      {conf.label && <Text bold color={conf.color === 'gray' ? 'gray' : 'white'}>{conf.label}</Text>}
      {showTime && time && <Text color="gray" dimColor>· {time}</Text>}
    </Box>
  );
}

function renderMessageContent(msg: ChatMessage, idx: number, opts: TurnOptions): React.ReactElement[] {
  if (msg.role === 'tool') {
    const preview = msg.content.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    const maxW = Math.max(20, opts.maxWidth - 12);
    const text = preview.length > maxW ? `${preview.slice(0, maxW - 3)}...` : preview;
    return [<Box key={`tr-${idx}`} paddingLeft={2}><Text color="cyan" dimColor>↳ {text}</Text></Box>];
  }
  const nodes = msg.role === 'user'
    ? msg.content.split('\n').flatMap((l, li) => wrapTextLine(l, opts.maxWidth).map((wl, wli) => <Text key={`${li}-${wli}`}>{wl || ' '}</Text>))
    : parseMarkdownBlocks(msg.content, opts.theme, opts.maxWidth);
  return nodes.map((n, bi) => <Box key={`c-${idx}-${bi}`} paddingLeft={2}>{n}</Box>);
}

export function renderSingleTurn(msg: ChatMessage, mi: number, opts: TurnOptions): React.ReactElement[] {
  const items: React.ReactElement[] = [];
  if (mi > 0) items.push(<Box key={`gap-${mi}`}><Text>{' '}</Text></Box>);
  items.push(renderMessageHeader(msg, mi));

  if (msg.thinking) {
    const tok = Math.ceil(msg.thinking.length / 4);
    items.push(
      <Box key={`t-${mi}`} paddingLeft={2}>
        <Thinking
          tokenCount={tok}
          defaultExpanded={opts.expandThinking}
          focus={false}
          theme={opts.theme}
        >
          {msg.thinking}
        </Thinking>
      </Box>
    );
  }

  msg.tool_calls?.forEach((tc: any, tci: number) => {
    items.push(
      <Box key={`tc-${mi}-${tci}`} paddingLeft={2}>
        <ToolCall
          name={tc.function?.name || 'tool'}
          args={tc.function?.arguments}
          status="success"
          interactive={false}
          compact={true}
          theme={opts.theme}
        />
      </Box>
    );
  });

  items.push(...renderMessageContent(msg, mi, opts));
  return items;
}

export function renderStreamingRows(s: StreamState, opts: TurnOptions): React.ReactElement[] {
  const completed = s.phase === 'executing-tools' ? ['thinking'] : s.phase === 'responding' ? ['thinking', 'executing-tools'] : [];
  const stepper = <Box key="st-step" paddingLeft={2}><Stepper steps={STEPS} currentStep={s.phase} completedSteps={completed} orientation="horizontal" theme={opts.theme} /></Box>;

  if (s.phase === 'thinking') {
    const tok = s.thinking.length > 0 ? Math.ceil(s.thinking.length / 4) : undefined;
    return [stepper, <Box key="st-think" paddingLeft={2}><Thinking isStreaming={true} tokenCount={tok} theme={opts.theme}>{s.thinking || ' '}</Thinking></Box>];
  }
  if (s.phase === 'executing-tools') {
    return [stepper, <Box key="st-tool" flexDirection="row" gap={1} alignItems="center" paddingLeft={2}><Spinner type="dots" /><Text color="cyan"> Executing MCP tool call...</Text></Box>];
  }
  if (s.phase === 'responding') {
    const head = <Box key="st-head" flexDirection="row" gap={1} alignItems="center"><Text bold color="green">✦</Text><Text color="green" dimColor>streaming</Text><Spinner type="dots" /></Box>;
    return [stepper, head, ...parseMarkdownBlocks(`${s.content}█`, opts.theme, opts.maxWidth).map((n, bi) => <Box key={`sb-${bi}`} paddingLeft={2}>{n}</Box>)];
  }
  return [];
}

function renderTurnDetails(msg: ChatMessage, theme: any, innerWidth: number): React.ReactElement[] {
  const elements: React.ReactElement[] = [];
  if (msg.thinking) {
    const tok = Math.ceil(msg.thinking.length / 4);
    elements.push(
      <Box key="th" marginBottom={1}>
        <Thinking tokenCount={tok} defaultExpanded={true} focus={false} theme={theme}>
          {msg.thinking}
        </Thinking>
      </Box>
    );
  }
  if (msg.tool_calls?.length) {
    msg.tool_calls.forEach((tc: any, tci: number) => {
      elements.push(
        <Box key={`tc-${tci}`} marginBottom={1}>
          <ToolCall
            name={tc.function?.name || 'tool'}
            args={tc.function?.arguments}
            status="success"
            defaultExpanded={true}
            interactive={false}
            theme={theme}
          />
        </Box>
      );
    });
  }
  elements.push(...parseMarkdownBlocks(msg.content, theme, innerWidth - 2));
  return elements;
}

export function parseTextToolCalls(text: string): Array<{ function: { name: string; arguments: any } }> {
  const calls: Array<{ function: { name: string; arguments: any } }> = [];
  const fnRe = /<function\s+name="([^"]+)">([\s\S]*?)<\/function>/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    const args: Record<string, any> = {};
    const paramRe = /<param\s+name="([^"]+)">([\s\S]*?)<\/param>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(m[2]!)) !== null) {
      args[pm[1]!] = pm[2]!.trim();
    }
    calls.push({ function: { name: m[1]!, arguments: args } });
  }
  const tcRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  while ((m = tcRe.exec(text)) !== null) {
    try {
      const p = JSON.parse(m[1]!.trim());
      if (p.name) calls.push({ function: { name: p.name, arguments: p.arguments || {} } });
    } catch {}
  }
  return calls;
}

interface AccordionItemProps {
  msg: ChatMessage;
  absIdx: number;
  isSelected: boolean;
  isOpen: boolean;
  theme: any;
  innerWidth: number;
  contentHeight: number;
}

function renderAccordionItem(p: AccordionItemProps): React.ReactElement {
  const time = p.msg.timestamp ? formatTime(p.msg.timestamp) : '';
  const toolName = p.msg.tool_calls?.[0]?.function?.name;
  const rawPreview = p.msg.content.replace(/\n/g, ' ').trim() || (toolName ? `Tool: ${toolName}` : '');
  const preview = rawPreview.slice(0, 45);
  const tokens = p.msg.tokens ?? Math.ceil(p.msg.content.length / 4);

  return (
    <Box key={`turn-${p.absIdx}`} flexDirection="column">
      <Box flexDirection="row" gap={1} alignItems="center" backgroundColor={p.isSelected ? (p.theme?.colors?.selection ?? 'blue') : undefined}>
        <Text bold color={p.isSelected ? 'cyan' : 'gray'}>{p.isOpen ? '▾' : '▸'}</Text>
        {renderMessageHeader(p.msg, p.absIdx, false)}
        <Text bold={p.isSelected} color={p.isSelected ? 'white' : 'gray'}>{preview}{rawPreview.length > 45 ? '…' : ''}</Text>
        <Text color="gray" dimColor>({tokens} tok{time ? ` • ${time}` : ''})</Text>
      </Box>
      {p.isOpen && (
        <Box flexDirection="column" paddingLeft={2} maxHeight={p.contentHeight}>
          <ScrollArea height={Math.max(2, p.contentHeight - 1)} width="100%" focus={false} theme={p.theme} scrollbar={true}>
            {renderTurnDetails(p.msg, p.theme, p.innerWidth)}
          </ScrollArea>
        </Box>
      )}
    </Box>
  );
}

export const ChatAccordion: React.FC<ChatAccordionProps> = ({ messages, height, width, focus = true, theme }) => {
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, messages.length - 1));
  const [openKey, setOpenKey] = useState<number | null>(() => Math.max(0, messages.length - 1));

  useInput((input, key) => {
    if (!focus || messages.length === 0) return;
    if (key.upArrow || input === 'k') setSelectedIndex((p) => Math.max(0, p - 1));
    else if (key.downArrow || input === 'j') setSelectedIndex((p) => Math.min(messages.length - 1, p + 1));
    else if (key.return || input === ' ') setOpenKey((p) => (p === selectedIndex ? null : selectedIndex));
    else if (input === 'g') setSelectedIndex(0);
    else if (input === 'G') setSelectedIndex(messages.length - 1);
  }, { isActive: focus });

  if (messages.length === 0) {
    return <Box height={height} alignItems="center" justifyContent="center"><Text color="gray" dimColor>No conversation history to display.</Text></Box>;
  }

  const maxVisible = Math.max(1, height - 1);
  const startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), messages.length - maxVisible));
  const visibleMessages = messages.slice(startIdx, startIdx + maxVisible);
  const innerWidth = Math.max(20, width - 4);
  const contentHeight = Math.max(3, height - visibleMessages.length - 1);

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={theme?.colors?.primary ?? 'cyan'}>▾ Accordion Navigator [{selectedIndex + 1}/{messages.length}]</Text>
        <Text color="gray" dimColor>↑/↓ or j/k: Select • Enter/Space: Fold • Ctrl+A: Stream</Text>
      </Box>
      {visibleMessages.map((msg, relIdx) => renderAccordionItem({
        msg, absIdx: startIdx + relIdx, isSelected: (startIdx + relIdx) === selectedIndex,
        isOpen: (startIdx + relIdx) === openKey, theme, innerWidth, contentHeight,
      }))}
    </Box>
  );
};
