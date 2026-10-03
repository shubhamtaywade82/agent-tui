import React from 'react';
import { Box, Text } from 'ink';
import { renderTableLines } from '../table/index.js';
import { borderStyles, darkTheme } from '../_core.js';
import type { InkUITheme } from '../_core.js';
import { tokenizeLine, resolveLanguage } from '../code-block/index.js';
import type { Language } from '../code-block/index.js';

export interface MarkdownProps {
  content: string;
  width?: number;
  highlightCode?: boolean;
  maxHeight?: number;
  theme?: InkUITheme;
}

interface InlineToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'strikethrough';
  text: string;
  url?: string;
}

function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const regex = /(\*\*(.*?)\*\*|~~(.*?)~~|\*(.*?)\*|`([^`]+)`|\[(.*?)\]\((.*?)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: line.slice(lastIndex, match.index) });
    }
    if (match[2] !== undefined) tokens.push({ type: 'bold', text: match[2] });
    else if (match[3] !== undefined) tokens.push({ type: 'strikethrough', text: match[3] });
    else if (match[4] !== undefined) tokens.push({ type: 'italic', text: match[4] });
    else if (match[5] !== undefined) tokens.push({ type: 'code', text: match[5] });
    else if (match[6] !== undefined) tokens.push({ type: 'link', text: match[6], url: match[7] });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < line.length) {
    tokens.push({ type: 'text', text: line.slice(lastIndex) });
  }
  return tokens;
}

function renderInline(tokens: InlineToken[], theme: InkUITheme): React.ReactElement {
  return (
    <>
      {tokens.map((tok, i) => {
        if (tok.type === 'bold') return <Text key={i} bold>{tok.text}</Text>;
        if (tok.type === 'italic') return <Text key={i} italic>{tok.text}</Text>;
        if (tok.type === 'strikethrough') return <Text key={i} strikethrough>{tok.text}</Text>;
        if (tok.type === 'code') return <Text key={i} color={theme.colors.info} inverse>{tok.text}</Text>;
        if (tok.type === 'link') {
          return (
            <Text key={i}>
              <Text underline color={theme.colors.primary}>{tok.text}</Text>
              <Text color={theme.colors.muted} dimColor>{` (${tok.url})`}</Text>
            </Text>
          );
        }
        return <Text key={i}>{tok.text}</Text>;
      })}
    </>
  );
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  const parts = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return parts.length >= 2 && parts.every((p) => /^[\s:]*-+[\s:]*$/.test(p.trim()));
}

function parseTableAlign(sep: string): 'left' | 'right' | 'center' {
  const s = sep.trim();
  if (s.startsWith(':') && s.endsWith(':')) return 'center';
  if (s.endsWith(':')) return 'right';
  return 'left';
}

interface BlockResult {
  elements: React.ReactElement[];
  nextIdx: number;
}

function renderHighlightedCode(
  line: string,
  lang: Language,
  innerWidth: number,
  theme: InkUITheme,
): React.ReactElement {
  const truncated = line.length > innerWidth ? line.slice(0, innerWidth - 1) + '…' : line;
  const padLen = Math.max(0, innerWidth - truncated.length);
  const tokens = tokenizeLine(truncated, lang);
  return (
    <Text>
      {tokens.map((tok, ti) => {
        const color = tok.color ? ((theme.colors as any)[tok.color] ?? tok.color) : theme.colors.text;
        return <Text key={ti} color={color}>{tok.text}</Text>;
      })}
      {padLen > 0 && <Text>{' '.repeat(padLen)}</Text>}
    </Text>
  );
}

function renderCodeBlockLines(
  codeLines: string[],
  lang: string,
  theme: InkUITheme,
  maxWidth: number,
): React.ReactElement[] {
  const b = borderStyles.rounded;
  const numWidth = String(codeLines.length).length;
  const gutterWidth = numWidth + 3;
  const innerWidth = Math.max(10, maxWidth - 4 - gutterWidth);
  const language = resolveLanguage(lang);
  const title = lang ? ` ${lang} ` : '';
  const topFill = b.top.repeat(Math.max(0, innerWidth + gutterWidth + 2 - title.length));
  const botFill = b.top.repeat(innerWidth + gutterWidth + 2);

  const lines: React.ReactElement[] = [
    <Text key="code-top" color={theme.colors.border}>{`${b.topLeft}${title}${topFill}${b.topRight}`}</Text>,
  ];

  codeLines.forEach((cl, ci) => {
    const num = String(ci + 1).padStart(numWidth, ' ');
    lines.push(
      <Box key={`code-${ci}`} flexDirection="row">
        <Text color={theme.colors.border}>{`${b.left} `}</Text>
        <Text color={theme.colors.muted}>{num} │ </Text>
        {renderHighlightedCode(cl, language, innerWidth, theme)}
        <Text color={theme.colors.border}>{` ${b.right}`}</Text>
      </Box>
    );
  });

  lines.push(
    <Text key="code-bot" color={theme.colors.border}>{`${b.bottomLeft}${botFill}${b.bottomRight}`}</Text>
  );

  return lines;
}

function parseCodeBlock(
  lines: string[],
  startIdx: number,
  theme: InkUITheme,
  maxWidth: number,
): BlockResult {
  const lang = lines[startIdx]!.replace(/^`+/, '').trim();
  const codeLines: string[] = [];
  let i = startIdx + 1;
  while (i < lines.length && !lines[i]!.startsWith('```')) {
    codeLines.push(lines[i]!);
    i++;
  }
  const elements = renderCodeBlockLines(codeLines, lang, theme, maxWidth);
  return { elements, nextIdx: i < lines.length ? i + 1 : i };
}

function parseTableBlock(
  lines: string[],
  startIdx: number,
  theme: InkUITheme,
  maxWidth: number,
): BlockResult {
  const headers = lines[startIdx]!.replace(/^\|/, '').replace(/\|$/, '').split('|').map((h) => h.trim());
  const aligns = lines[startIdx + 1]!.replace(/^\|/, '').replace(/\|$/, '').split('|').map(parseTableAlign);
  const columns = headers.map((header, ci) => ({
    key: `col_${ci}`,
    header,
    align: aligns[ci] || 'left',
  }));

  const data: Record<string, string>[] = [];
  let i = startIdx + 2;
  while (i < lines.length && lines[i]!.trim().length > 0 && lines[i]!.includes('|')) {
    const cells = lines[i]!.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const row: Record<string, string> = {};
    columns.forEach((col, ci) => { row[col.key] = cells[ci] ?? ''; });
    data.push(row);
    i++;
  }

  const elements = renderTableLines(columns, data, { borderStyle: 'rounded', theme, maxWidth });
  return { elements, nextIdx: i };
}

interface LineFormatOptions {
  theme: InkUITheme;
  maxWidth: number;
}

function renderListLines(text: string, i: number, pfx: string, opts: LineFormatOptions) {
  const innerW = Math.max(10, opts.maxWidth - pfx.length);
  const indent = ' '.repeat(pfx.length);
  return wrapTextLine(text, innerW).map((w, wi) => (
    <Box key={`${i}-${wi}`} flexDirection="row">
      <Text color={opts.theme.colors.primary}>{wi === 0 ? pfx : indent}</Text>
      <Text>{renderInline(parseInline(w), opts.theme)}</Text>
    </Box>
  ));
}

function renderQuoteLines(text: string, i: number, opts: LineFormatOptions) {
  const innerW = Math.max(10, opts.maxWidth - 2);
  return wrapTextLine(text, innerW).map((w, wi) => (
    <Box key={`${i}-${wi}`} flexDirection="row">
      <Text color={opts.theme.colors.muted}>{'│ '}</Text>
      <Text italic color={opts.theme.colors.muted}>{renderInline(parseInline(w), opts.theme)}</Text>
    </Box>
  ));
}

function renderHeadingLines(text: string, i: number, color: string, opts: LineFormatOptions) {
  return wrapTextLine(text, opts.maxWidth).map((w, wi) => (
    <Text key={`${i}-${wi}`} bold color={color}>{renderInline(parseInline(w), opts.theme)}</Text>
  ));
}

function renderLineItem(line: string, i: number, opts: LineFormatOptions): React.ReactElement[] {
  if (/^---+$/.test(line.trim())) return [<Text key={i} color={opts.theme.colors.border}>{'─'.repeat(Math.max(10, opts.maxWidth))}</Text>];
  if (line.trim() === '') return [<Text key={i}>{' '}</Text>];
  if (line.startsWith('# ')) return renderHeadingLines(line.slice(2), i, opts.theme.colors.primary, opts);
  if (line.startsWith('## ')) return renderHeadingLines(line.slice(3), i, opts.theme.colors.secondary, opts);
  if (line.startsWith('### ')) return renderHeadingLines(line.slice(4), i, opts.theme.colors.text, opts);
  if (line.startsWith('> ')) return renderQuoteLines(line.slice(2), i, opts);
  if (line.startsWith('- ') || line.startsWith('* ')) return renderListLines(line.slice(2), i, '  • ', opts);
  const ol = line.match(/^(\d+)\.\s(.*)/);
  if (ol) return renderListLines(ol[2]!, i, `  ${ol[1]}. `, opts);
  return wrapTextLine(line, opts.maxWidth).map((w, wi) => <Text key={`${i}-${wi}`}>{renderInline(parseInline(w), opts.theme)}</Text>);
}

export function wrapTextLine(line: string, maxWidth: number): string[] {
  if (line.length <= maxWidth || maxWidth <= 0) return [line];
  const result: string[] = [];
  let remaining = line;
  while (remaining.length > maxWidth) {
    let breakIdx = remaining.lastIndexOf(' ', maxWidth);
    if (breakIdx <= 0) breakIdx = maxWidth;
    result.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx).trimStart();
  }
  if (remaining.length > 0) result.push(remaining);
  return result;
}

export function parseMarkdownBlocks(
  content: string,
  theme: InkUITheme = darkTheme,
  maxWidth: number = 80,
): React.ReactElement[] {
  const lines = content.split('\n');
  const elements: React.ReactElement[] = [];
  const opts: LineFormatOptions = { theme, maxWidth };
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.startsWith('```')) {
      const block = parseCodeBlock(lines, i, theme, maxWidth);
      elements.push(...block.elements);
      i = block.nextIdx;
      continue;
    }
    if (lines[i]!.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const block = parseTableBlock(lines, i, theme, maxWidth);
      elements.push(...block.elements);
      i = block.nextIdx;
      continue;
    }
    elements.push(...renderLineItem(lines[i]!, i, opts));
    i++;
  }

  return elements;
}

export const Markdown: React.FC<MarkdownProps> = ({
  content,
  theme = darkTheme,
}) => {
  return <Box flexDirection="column">{parseMarkdownBlocks(content, theme)}</Box>;
};
