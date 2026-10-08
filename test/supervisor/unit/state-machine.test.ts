/**
 * State machine — §1, §9. Verifies that legal transitions succeed and
 * illegal ones throw `IllegalTransitionError`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../../src/supervisor/state/events.js';
import { IllegalTransitionError, StateMachine } from '../../../src/supervisor/state/machine.js';
import { newAgentState } from '../../../src/supervisor/state/models.js';

describe('StateMachine', () => {
  let bus: EventBus;
  let machine: StateMachine;

  beforeEach(() => {
    bus = new EventBus();
    machine = new StateMachine(bus);
  });

  it('allows CREATED → PLANNING', async () => {
    const state = newAgentState('test');
    await machine.transition(state, 'PLANNING', 'route');
    expect(state.status).toBe('PLANNING');
  });

  it('forbids CREATED → COMPLETED', async () => {
    const state = newAgentState('test');
    await expect(machine.transition(state, 'COMPLETED')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  it('forbids COMPLETED → anything', async () => {
    const state = newAgentState('test');
    state.status = 'COMPLETED';
    await expect(machine.transition(state, 'PLANNING')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await expect(machine.transition(state, 'FAILED')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  it('emits a state_transitioned event on every legal move', async () => {
    const state = newAgentState('test');
    const seen: string[] = [];
    bus.subscribe((e) => {
      if (e.type === 'state_transitioned') seen.push(`${e.payload.from}->${e.payload.to}`);
    });
    await machine.transition(state, 'PLANNING', 'route');
    await machine.transition(state, 'RETRIEVING', 'gather-evidence');
    expect(seen).toEqual(['CREATED->PLANNING', 'PLANNING->RETRIEVING']);
  });

  it('reachableFrom returns the full legal successor list', () => {
    expect(machine.reachableFrom('CREATED').sort()).toEqual(['CANCELLED', 'FAILED', 'PLANNING']);
    expect(machine.reachableFrom('COMPLETED')).toEqual([]);
  });

  it('is a no-op when from === to', async () => {
    const state = newAgentState('test');
    state.status = 'PLANNING';
    const after = await machine.transition(state, 'PLANNING');
    expect(after.status).toBe('PLANNING');
  });
});
