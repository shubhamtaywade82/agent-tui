/**
 * src/components/ui/mouse/mouseTrackingShim.tsx
 *
 * Upstream bug compensation for @nemesis-oss/termina-core 0.1.0.
 *
 * The framework exports:
 *   mouseTrackingEnable  = '\x1b\x1b\x1b'                       (corrupted)
 *   mouseTrackingDisable = '\x1b[?1006l\x1b[?1002l\x1b[?1000l'  (correct)
 *
 * `mouseTrackingEnable` should be the DEC private mode turn-on sequence
 * (`?1000h ?1002h ?1006h` — click reporting, drag reporting, SGR extended
 * coordinates), but the shipped constant is three bare ESC bytes, which no
 * terminal interprets. `MouseRouter` is mounted by `render(..., {mouse:
 * true})` and calls `setMouseTracking(true)`, which writes the corrupted
 * sequence — so tracking never actually turns on and no mouse report ever
 * reaches the hit-tested `Box onClick / onWheel` handlers.
 *
 * This shim writes the correct sequence once at app mount and the matching
 * disable sequence on unmount/exit. It is idempotent relative to the
 * framework's own (broken) writes: enabling twice is harmless, and both
 * disable paths write the same bytes.
 *
 * When termina-core fixes the constant upstream, this shim can be deleted
 * without touching any call site (it is only mounted in `App.tsx`).
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
