/**
 * src/components/ui/hooks/useMouse.ts — mouse events via termina-core.
 *
 * The framework (@nemesis-oss/termina-core, an Ink 8 fork) parses SGR mouse
 * reports out of stdin before useInput ever sees them and re-publishes them on
 * an internal event emitter. Its `useMouse` hook subscribes to that emitter.
 * This file is a thin compatibility wrapper around it, keeping the legacy
 * local API (`useMouseScroll`, delta-based) used by older call sites.
 *
 * Legacy notes (kept for history):
 *   - The previous implementation attached a raw `stdin.on('data')` listener
 *     and wrote DEC private modes by hand. Mixing a push-mode 'data' listener
 *     with the framework's pull-mode `stdin.read()` loop is fragile, and the
 *     hand-written enable sequence duplicated the framework's own tracking
 *     management. Both are gone now.
 *   - termina-core 0.1.0 ships a corrupted `mouseTrackingEnable` constant
 *     (three bare ESC bytes, upstream bug). App-level compensation lives in
 *     `src/components/ui/mouse/mouseTrackingShim.tsx`.
 *
 * Rich click handling should prefer `Box` props directly (`onClick`,
 * `onMouseDown`, `onMouseUp`, `onWheel`) — the framework hit-tests them
 * against the real Yoga layout, including clipped scroll containers.
 */
import { useMouse as useFrameworkMouse } from '@nemesis-oss/termina-core';
import type { MouseEvent as FrameworkMouseEvent } from '@nemesis-oss/termina-core';

export type MouseButton = 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down' | 'none';
export type MouseAction = 'down' | 'up' | 'drag' | 'wheel';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MouseEvent {
  type: MouseAction;
  button: MouseButton;
  x: number; // 1-indexed terminal column
  y: number; // 1-indexed terminal row
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

/** Adapt the framework's parsed report to the legacy local shape. */
function adaptEvent(ev: FrameworkMouseEvent): MouseEvent {
  const type: MouseAction =
    ev.action === 'press' ? 'down'
    : ev.action === 'release' ? 'up'
    : ev.action === 'drag' ? 'drag'
    : ev.action === 'wheel' ? 'wheel'
    : 'down';
  const button: MouseButton =
    ev.button === 'wheelUp' ? 'wheel-up'
    : ev.button === 'wheelDown' ? 'wheel-down'
    : ev.button === 'left' || ev.button === 'middle' || ev.button === 'right'
      ? ev.button
      : 'none';
  return { type, button, x: ev.x, y: ev.y, shift: ev.shift, meta: ev.meta, ctrl: ev.ctrl };
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

export function useMouse(options: UseMouseOptions = {}): void {
  const { active = true } = options;
  // Ref keeps the latest callbacks without re-subscribing on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useFrameworkMouse(
    (ev) => {
      const event = adaptEvent(ev);
      const o = optionsRef.current;
      o.onEvent?.(event);
      if (event.type === 'down') o.onMouseDown?.(event);
      else if (event.type === 'up') o.onMouseUp?.(event);
      else if (event.type === 'drag') o.onMouseDrag?.(event);
      else if (event.type === 'wheel') {
        if (event.button === 'wheel-up') o.onWheelUp?.(event);
        else if (event.button === 'wheel-down') o.onWheelDown?.(event);
      }
    },
    { isActive: active },
  );
}

import { useRef } from 'react';

/** Convenience wrapper: fires onScroll(-1) for wheel-up, (+1) for wheel-down. */
export function useMouseScroll(onScroll: (delta: number, e: MouseEvent) => void, active = true): void {
  useMouse({
    active,
    onWheelUp: (e) => onScroll(-1, e),
    onWheelDown: (e) => onScroll(1, e),
  });
}

/**
 * Legacy hit-test helper retained for callers that predate the framework's
 * layout-based hit testing. Prefer `Box onClick` for new code.
 */
export function isPointInside(x: number, y: number, box: BoundingBox): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}
