import { useCallback } from 'react';
import { useStdout } from 'ink';

export interface ClipboardResult {
  copy: (text: string) => boolean;
}

export function useClipboard(): ClipboardResult {
  const { stdout } = useStdout();

  // OSC 52 works universally: local terminals, remote SSH, tmux (with set-clipboard on)
  const copy = useCallback((text: string): boolean => {
    if (!stdout || !text) return false;

    const buf = (globalThis as any).Buffer as typeof Buffer | undefined;
    const base64 = buf ? buf.from(text, 'utf-8').toString('base64') : btoa(encodeURIComponent(text));
    const osc52 = `\x1b]52;c;${base64}\x07`;

    try {
      stdout.write(osc52);
      return true;
    } catch {
      return false;
    }
  }, [stdout]);

  return { copy };
}
