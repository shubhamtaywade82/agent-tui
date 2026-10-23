/**
 * Input history for the chat prompt: loaded at start, saved as the user types.
 * Stored one JSON string per line in .history, newest first, capped at 500 entries.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { log } from '../../logger.js';

export const HIST = '.history';
export const filterValidHistory = (items: string[]): string[] => {
  const result: string[] = []; const seen = new Set<string>();
  for (const item of items) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (s.length > 3 && !seen.has(s)) { seen.add(s); result.push(s); }
  }
  return result;
};
export const saveHistoryFile = (items: string[]): void => {
  try {
    writeFileSync(HIST, items.slice(0, 500).map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf-8');
  } catch (err) {
    log.warn('input history not saved', { file: HIST, error: (err as Error).message });
  }
};
export const loadHistory = (): string[] => {
  if (!existsSync(HIST)) return [];
  try { return filterValidHistory(readFileSync(HIST, 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } })); } catch { return []; }
};
