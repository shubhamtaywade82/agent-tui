import { useWindowSize } from '@nemesis-oss/termina-core';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export function useTerminalSize(): TerminalSize {
  return useWindowSize();
}

