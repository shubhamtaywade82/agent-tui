import { useEffect, useRef } from 'react';
import { useStdin, useStdout } from 'ink';

declare const process: any;

export type MouseButton = 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down' | 'none';
export type MouseAction = 'down' | 'up' | 'drag' | 'wheel';

export interface MouseEvent {
  type: MouseAction;
  button: MouseButton;
  x: number; // 1-indexed terminal column
  y: number; // 1-indexed terminal row
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UseMouseOptions {
  active?: boolean;
  onMouseDown?: (e: MouseEvent) => void;
  onMouseUp?: (e: MouseEvent) => void;
  onMouseDrag?: (e: MouseEvent) => void;
  onWheelUp?: (e: MouseEvent) => void;
  onWheelDown?: (e: MouseEvent) => void;
  onEvent?: (e: MouseEvent) => void;
}

// DEC private modes: 1000 = click, 1002 = drag/cell motion, 1006 = SGR extended coordinates
const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';

export function isPointInside(x: number, y: number, box: BoundingBox): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

function resolveButtonAndAction(baseCode: number, isRelease: boolean): { button: MouseButton; type: MouseAction } {
  if (baseCode === 64) return { button: 'wheel-up', type: 'wheel' };
  if (baseCode === 65) return { button: 'wheel-down', type: 'wheel' };

  if ((baseCode & 32) !== 0) {
    const btn = baseCode - 32;
    const button: MouseButton = btn === 0 ? 'left' : btn === 1 ? 'middle' : btn === 2 ? 'right' : 'none';
    return { button, type: 'drag' };
  }

  const button: MouseButton = baseCode === 0 ? 'left' : baseCode === 1 ? 'middle' : baseCode === 2 ? 'right' : 'none';
  return { button, type: isRelease ? 'up' : 'down' };
}

export function parseSgrMouseEvent(chunk: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  // Regex created per-call to avoid shared lastIndex state across invocations
  const sgrRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let match: RegExpExecArray | null;

  while ((match = sgrRegex.exec(chunk)) !== null) {
    const code = parseInt(match[1]!, 10);
    const x = parseInt(match[2]!, 10);
    const y = parseInt(match[3]!, 10);
    const isRelease = match[4] === 'm';

    const shift = (code & 4) !== 0;
    const meta = (code & 8) !== 0;
    const ctrl = (code & 16) !== 0;

    // Mask modifier bits (4 = shift, 8 = meta, 16 = ctrl)
    const baseCode = code & ~28;
    const { button, type } = resolveButtonAndAction(baseCode, isRelease);

    events.push({ type, button, x, y, shift, meta, ctrl });
  }

  return events;
}

function dispatchMouseEvent(event: MouseEvent, options: UseMouseOptions): void {
  options.onEvent?.(event);

  if (event.type === 'down') options.onMouseDown?.(event);
  else if (event.type === 'up') options.onMouseUp?.(event);
  else if (event.type === 'drag') options.onMouseDrag?.(event);
  else if (event.type === 'wheel') {
    if (event.button === 'wheel-up') options.onWheelUp?.(event);
    else if (event.button === 'wheel-down') options.onWheelDown?.(event);
  }
}

export function useMouse(options: UseMouseOptions = {}): void {
  const { active = true } = options;
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();

  // Ref keeps the latest callbacks without re-running the effect on every render.
  // Without this, the data listener would call the first render's stale closures
  // (which captured maxOffset=0 / scrollOffset=0) and scroll would be broken.
  const optionsRef = useRef<UseMouseOptions>(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active || !stdout || !stdin) return;

    setRawMode?.(true);
    stdout.write(ENABLE_MOUSE);

    const onData = (data: unknown) => {
      const chunk = typeof data === 'string' ? data : String(data);
      const events = parseSgrMouseEvent(chunk);
      // Always read from ref so we use the latest callbacks, not a stale closure
      events.forEach((ev) => dispatchMouseEvent(ev, optionsRef.current));
    };

    stdin.on('data', onData);

    const restoreTerminal = () => {
      try { stdout.write(DISABLE_MOUSE); } catch { /* ignore stream-closed errors */ }
    };

    process.once('exit', restoreTerminal);

    return () => {
      stdin.off('data', onData);
      process.removeListener('exit', restoreTerminal);
      restoreTerminal();
    };
  }, [active, stdin, stdout, setRawMode]);
}

/** Convenience wrapper: fires onScroll(-1) for wheel-up, (+1) for wheel-down. */
export function useMouseScroll(onScroll: (delta: number, e: MouseEvent) => void, active = true): void {
  useMouse({
    active,
    onWheelUp: (e) => onScroll(-1, e),
    onWheelDown: (e) => onScroll(1, e),
  });
}

