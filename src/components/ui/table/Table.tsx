import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { borderStyles, darkTheme } from '../_core.js';
import type { BorderStyle, InkUITheme } from '../_core.js';

export interface TableColumn<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Key into each data row */
  key: keyof T & string;
  /** Column header text */
  header: string;
  /** Text alignment — defaults to left */
  align?: 'left' | 'right' | 'center';
  /** Fixed column width override (inner content width, excluding padding) */
  width?: number;
}

export interface TableProps<T extends Record<string, unknown> = Record<string, unknown>> {
  columns: TableColumn<T>[];
  data: T[];
  /** Border style key from @inkui-cli/core tokens */
  borderStyle?: BorderStyle;
  /** Theme override — defaults to darkTheme */
  theme?: InkUITheme;
}

export interface RenderTableLinesOptions {
  borderStyle?: BorderStyle;
  theme?: InkUITheme;
  maxWidth?: number;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const ELLIPSIS = '…';

function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, maxWidth - 1) + ELLIPSIS;
}

function pad(text: string, width: number, align: 'left' | 'right' | 'center'): string {
  if (align === 'right') return text.padStart(width);
  if (align === 'center') {
    const total = width - text.length;
    const left = Math.floor(total / 2);
    return ' '.repeat(left) + text + ' '.repeat(total - left);
  }
  return text.padEnd(width);
}

function cellStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

// ─── column width calculation ─────────────────────────────────────────────────

function resolveWidths<T extends Record<string, unknown>>(
  columns: TableColumn<T>[],
  data: T[],
  termWidth: number,
): number[] {
  const natural = columns.map((col) => {
    if (col.width !== undefined) return col.width;
    const maxCell = data.reduce((max, row) => Math.max(max, cellStr(row[col.key]).length), 0);
    return Math.max(col.header.length, maxCell);
  });

  const overhead = 1 + columns.length * 3;
  const totalNatural = natural.reduce((s, w) => s + w, 0) + overhead;
  if (totalNatural <= termWidth) return natural;

  const fixedTotal = columns.reduce((s, col, i) => col.width !== undefined ? s + natural[i]! : s, 0);
  const available = Math.max(termWidth - overhead - fixedTotal, columns.length * 3);
  const flexCount = columns.filter((c) => c.width === undefined).length;
  const flexBudget = Math.floor(available / Math.max(flexCount, 1));

  return columns.map((col, i) =>
    col.width !== undefined ? natural[i]! : Math.max(3, Math.min(natural[i]!, flexBudget)),
  );
}

// ─── border line builders ─────────────────────────────────────────────────────

interface BorderParts {
  left: string;
  fill: string;
  join: string;
  right: string;
}

function buildBorderLine(parts: BorderParts, widths: number[]): string {
  return parts.left + widths.map((w) => parts.fill.repeat(w + 2)).join(parts.join) + parts.right;
}

function buildTableBorderLines(b: typeof borderStyles[BorderStyle], widths: number[]) {
  return {
    topLine: buildBorderLine({ left: b.topLeft, fill: b.top, join: b.topT, right: b.topRight }, widths),
    midLine: buildBorderLine({ left: b.leftT, fill: b.top, join: b.cross, right: b.rightT }, widths),
    botLine: buildBorderLine({ left: b.bottomLeft, fill: b.top, join: b.bottomT, right: b.bottomRight }, widths),
  };
}

// ─── row renderer ─────────────────────────────────────────────────────────────

interface RowProps {
  cells: string[];
  widths: number[];
  aligns: ('left' | 'right' | 'center')[];
  borderChar: string;
  borderColor: string;
  textColor: string;
  bold?: boolean;
}

const Row: React.FC<RowProps> = ({
  cells,
  widths,
  aligns,
  borderChar,
  borderColor,
  textColor,
  bold = false,
}) => (
  <Box>
    {cells.map((cell, i) => (
      <Box key={i}>
        <Text color={borderColor}>{borderChar}</Text>
        <Text> </Text>
        <Text color={textColor} bold={bold}>
          {pad(truncate(cell, widths[i]!), widths[i]!, aligns[i]!)}
        </Text>
        <Text> </Text>
      </Box>
    ))}
    <Text color={borderColor}>{borderChar}</Text>
  </Box>
);

// ─── line renderer (for scroll-safe flattening) ──────────────────────────────

export function renderTableLines<T extends Record<string, unknown> = Record<string, unknown>>(
  columns: TableColumn<T>[],
  data: T[],
  options: RenderTableLinesOptions = {},
): React.ReactElement[] {
  const { borderStyle = 'single', theme = darkTheme, maxWidth = 80 } = options;
  const b = borderStyles[borderStyle];
  const widths = resolveWidths(columns, data, maxWidth);
  const aligns = columns.map((c) => c.align ?? 'left');
  const { topLine, midLine, botLine } = buildTableBorderLines(b, widths);

  const headerCells = columns.map((c) => c.header);
  const { border: borderColor, text: textColor, primary } = theme.colors;

  return [
    <Text key="tbl-top" color={borderColor}>{topLine}</Text>,
    <Row key="tbl-hdr" cells={headerCells} widths={widths} aligns={aligns} borderChar={b.left} borderColor={borderColor} textColor={primary} bold />,
    <Text key="tbl-mid" color={borderColor}>{midLine}</Text>,
    ...data.map((row, ri) => (
      <Row key={`tbl-row-${ri}`} cells={columns.map((c) => cellStr(row[c.key]))} widths={widths} aligns={aligns} borderChar={b.left} borderColor={borderColor} textColor={textColor} />
    )),
    <Text key="tbl-bot" color={borderColor}>{botLine}</Text>,
  ];
}

// ─── public component ─────────────────────────────────────────────────────────

export function Table<T extends Record<string, unknown> = Record<string, unknown>>({
  columns,
  data,
  borderStyle = 'single',
  theme = darkTheme,
}: TableProps<T>) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  return (
    <Box flexDirection="column">
      {renderTableLines(columns, data, { borderStyle, theme, maxWidth: termWidth })}
    </Box>
  );
}
