import { useEffect } from 'react';
import { useStdout } from 'ink';

declare const process: any;

export interface UseAlternateScreenOptions {
  active?: boolean;
  hideCursor?: boolean;
  clearScreen?: boolean;
}

// VT100 / Xterm alternate screen & cursor escape codes
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

export function useAlternateScreen(options: UseAlternateScreenOptions = {}): void {
  const { active = true, hideCursor = false, clearScreen = true } = options;
  const { stdout } = useStdout();

  useEffect(() => {
    if (!active || !stdout) return;

    let initSequence = ENTER_ALT_SCREEN;
    if (clearScreen) initSequence += CLEAR_SCREEN;
    if (hideCursor) initSequence += HIDE_CURSOR;
    stdout.write(initSequence);

    const restore = () => {
      try {
        let exitSequence = EXIT_ALT_SCREEN;
        if (hideCursor) exitSequence = SHOW_CURSOR + exitSequence;
        stdout.write(exitSequence);
      } catch { /* ignore stream-closed errors on process exit */ }
    };

    process.once('exit', restore);
    return () => {
      process.removeListener('exit', restore);
      restore();
    };
  }, [active, hideCursor, clearScreen, stdout]);
}
