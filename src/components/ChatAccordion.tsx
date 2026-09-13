import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Badge } from './ui/badge/index.js';
import { Spinner } from './ui/spinner/index.js';
import { Stepper, type Step } from './ui/stepper/index.js';
import { JSONViewer } from './ui/json-viewer/index.js';
import { parseMarkdownBlocks, wrapTextLine } from './ui/markdown/index.js';
import { ScrollArea } from './ui/scroll-area/index.js';
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

export function renderMessageHeader(msg: ChatMessage, idx: number): React.ReactElement {
  const v = msg.role === 'user' ? 'info' : msg.role === 'tool' ? 'warning' : msg.role === 'system' ? 'default' : 'success';
  const l = msg.role === 'user' ? 'You' : msg.role === 'tool' ? 'Tool' : msg.role === 'system' ? 'System' : 'AI';
  const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
  return <Box key={`h-${idx}`} flexDirection="row" gap={1} alignItems="center"><Badge variant={v}>{l}</Badge>{time && <Text color="gray" dimColor>{time}</Text>}</Box>;
}

function renderMessageContent(msg: ChatMessage, idx: number, opts: TurnOptions): React.ReactElement[] {
  if (msg.role === 'tool') {
    return [<Box key={`tr-${idx}`} paddingLeft={2}><Text color="cyan" dimColor>Result: {msg.content.slice(0, 100)}{msg.content.length > 100 ? '...' : ''}</Text></Box>];
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
    if (!opts.expandThinking) {
      items.push(<Box key={`t-${mi}`} paddingLeft={2}><Text color="yellow" dimColor>▸ 💭 Reasoning ({tok} tok) [t]</Text></Box>);
    } else {
      items.push(<Box key={`t-${mi}`} paddingLeft={2}><Text color="yellow">▾ 💭 Reasoning ({tok} tok):</Text></Box>);
      wrapTextLine(msg.thinking, opts.maxWidth - 4).forEach((tl, tli) => {
        items.push(<Box key={`tl-${mi}-${tli}`} paddingLeft={4}><Text color="gray" dimColor>│ {tl}</Text></Box>);
      });
    }
  }

  msg.tool_calls?.forEach((tc: any, tci: number) => {
    const args = JSON.stringify(tc.function?.arguments || {});
    const trunc = args.length > opts.maxWidth - 16 ? args.slice(0, opts.maxWidth - 19) + '...' : args;
    items.push(<Box key={`tc-${mi}-${tci}`} paddingLeft={2} flexDirection="row" gap={1}><Badge variant="warning">Tool</Badge><Text color="yellow">▸ {tc.function?.name || 'tool'}</Text><Text color="gray" dimColor>({trunc})</Text></Box>);
  });

  items.push(...renderMessageContent(msg, mi, opts));
  return items;
}

export function renderStreamingRows(s: StreamState, opts: TurnOptions): React.ReactElement[] {
  const completed = s.phase === 'executing-tools' ? ['thinking'] : s.phase === 'responding' ? ['thinking', 'executing-tools'] : [];
  const stepper = <Box key="st-step" paddingLeft={2}><Stepper steps={STEPS} currentStep={s.phase} completedSteps={completed} orientation="horizontal" theme={opts.theme} /></Box>;

  if (s.phase === 'thinking') {
    return [stepper, <Box key="st-think" flexDirection="row" gap={1} alignItems="center" paddingLeft={2}><Spinner type="dots" /><Text color="yellow"> {s.model} thinking...</Text>{s.thinking.length > 0 && <Text color="gray" dimColor>({Math.ceil(s.thinking.length / 4)} tok)</Text>}</Box>];
  }
  if (s.phase === 'executing-tools') {
    return [stepper, <Box key="st-tool" flexDirection="row" gap={1} alignItems="center" paddingLeft={2}><Spinner type="dots" /><Text color="cyan"> Executing MCP tool call...</Text></Box>];
  }
  if (s.phase === 'responding') {
    const head = <Box key="st-head" flexDirection="row" gap={1} alignItems="center"><Badge variant="success">AI</Badge><Text color="green" dimColor>streaming</Text><Spinner type="dots" /></Box>;
    return [stepper, head, ...parseMarkdownBlocks(`${s.content}█`, opts.theme, opts.maxWidth).map((n, bi) => <Box key={`sb-${bi}`} paddingLeft={2}>{n}</Box>)];
  }
  return [];
}

function renderTurnDetails(msg: ChatMessage, theme: any, innerWidth: number): React.ReactElement[] {
  const elements: React.ReactElement[] = [];
  if (msg.thinking) {
    elements.push(<Box key="th-hdr" flexDirection="row" gap={1}><Text bold color="yellow">💭 Reasoning ({Math.ceil(msg.thinking.length / 4)} tok):</Text></Box>);
    wrapTextLine(msg.thinking, innerWidth - 4).forEach((line, li) => {
      elements.push(<Box key={`th-${li}`} paddingLeft={1}><Text color="gray" dimColor>│ {line}</Text></Box>);
    });
    elements.push(<Box key="th-gap"><Text>{' '}</Text></Box>);
  }
  if (msg.tool_calls?.length) {
    msg.tool_calls.forEach((tc: any, tci: number) => {
      elements.push(
        <Box key={`tc-${tci}`} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}><Badge variant="warning">Tool Call</Badge><Text bold color="yellow">{tc.function?.name}</Text></Box>
          <JSONViewer data={tc.function?.arguments || {}} theme={theme} focus={false} maxHeight={6} />
        </Box>
      );
    });
  }
  elements.push(...parseMarkdownBlocks(msg.content, theme, innerWidth - 2));
  return elements;
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
  const time = p.msg.timestamp ? new Date(p.msg.timestamp).toLocaleTimeString() : '';
  const preview = p.msg.content.replace(/\n/g, ' ').slice(0, 45);
  const tokens = p.msg.tokens ?? Math.ceil(p.msg.content.length / 4);

  return (
    <Box key={`turn-${p.absIdx}`} flexDirection="column">
      <Box flexDirection="row" gap={1} alignItems="center" backgroundColor={p.isSelected ? (p.theme?.colors?.selection ?? 'blue') : undefined}>
        <Text bold color={p.isSelected ? 'cyan' : 'gray'}>{p.isOpen ? '▾' : '▸'}</Text>
        {renderMessageHeader(p.msg, p.absIdx)}
        <Text bold={p.isSelected} color={p.isSelected ? 'white' : 'gray'}>{preview}{p.msg.content.length > 45 ? '…' : ''}</Text>
        <Text color="gray" dimColor>({tokens} tok{time ? ` • ${time}` : ''})</Text>
      </Box>
      {p.isOpen && (
        <Box flexDirection="column" paddingLeft={2} borderStyle="single" borderColor={p.theme?.colors?.border ?? 'gray'} maxHeight={p.contentHeight}>
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
