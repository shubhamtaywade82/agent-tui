/**
 * src/components/ui/mouse/mouseTrackingShim.tsx
 *
 * Originally a workaround for @nemesis-oss/termina-core 0.1.0, which shipped
 * a corrupted `mouseTrackingEnable` constant (three bare ESC bytes that no
 * terminal interprets, instead of the DEC private mode SET sequence).
 *
 * As of @nemesis-oss/termina-core 0.2.0, the upstream constant is FIXED —
 * it now correctly writes `ESC[?1000h ESC[?1002h ESC[?1006h` (click
 * reporting + drag reporting + SGR extended coordinates). The framework's
 * own `setMouseTracking(true)` call (triggered by `render(..., {mouse:
 * true})` + any mounted `useMouse` hook) now writes the correct bytes.
 *
 * This shim is now REDUNDANT — it writes the same sequence the framework
 * already writes. It is kept as a safety net:
 *   - Idempotent: writing the enable sequence twice is harmless.
 *   - Defensive: if a future termina-core version regresses the constant,
 *     the shim still ensures mouse tracking works.
 *   - Cheap: one stdout.write on mount, one on unmount.
 *
 * To remove: delete this file, remove the import + `useMouseTrackingShim()`
 * call in `App.tsx`, and remove `src/components/ui/mouse/index.ts`. No
 * other call site depends on it.
 */
import { useEffect } from 'react';
import { useStdout } from '@nemesis-oss/termina-core';

declare const process: any;

// DEC private modes: 1000 = click reporting, 1002 = drag/cell-motion reporting,
// 1006 = SGR extended coordinates (required for >223 column terminals).
const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';

export function useMouseTrackingShim(active = true): void {
  const { stdout } = useStdout();

  useEffect(() => {
    const tty = stdout as (typeof stdout & { isTTY?: boolean }) | undefined;
    if (!active || !tty || !tty.isTTY) return;

    tty.write(ENABLE_MOUSE);

    const restore = () => {
      try { stdout.write(DISABLE_MOUSE); } catch { /* stream already closed */ }
    };
    process.once('exit', restore);

    return () => {
      process.removeListener('exit', restore);
      restore();
    };
  }, [active, stdout]);
}
