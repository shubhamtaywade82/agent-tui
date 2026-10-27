/**
 * TaskOrchestrator — Phase 5 follow-up: code context injection.
 *
 * Verifies that when a CodeIndexer is wired AND `repoPath` is supplied,
 * RETRIEVE/ANALYZE/CODE_CHANGE/TEST tasks get relevant file snippets
 * injected into the objective the Supervisor engine receives.
 *
 * The test creates a real temp directory with .ts files, runs a
 * RETRIEVE task through the orchestrator with `repoPath` set, and
 * asserts the analyst's prompt contains the indexed file content.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeIndexer } from '../../../src/supervisor/code/indexer.js';
import { Supervisor } from '../../../src/supervisor/engine.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import type { DomainEvent } from '../../../src/supervisor/state/events.js';
import type { AgentState } from '../../../src/supervisor/state/models.js';
import type { StateStore } from '../../../src/supervisor/state/store.js';
import { TaskLedger } from '../../../src/supervisor/tasks/ledger.js';
import { TaskOrchestrator } from '../../../src/supervisor/tasks/orchestrator.js';
import { InMemoryTaskStore } from '../../../src/supervisor/tasks/store.js';

class InMemoryStore implements StateStore {
  private runs = new Map<string, AgentState>();
  private events = new Map<string, DomainEvent[]>();
  async init() {}
  async saveRun(state: AgentState) {
    this.runs.set(state.runId, state);
  }
  async getRun(id: string) {
    return this.runs.get(id) ?? null;
  }
  async listRuns() {
    return [...this.runs.values()];
  }
  async appendEvent(e: DomainEvent) {
    const list = this.events.get(e.runId) ?? [];
    list.push(e);
    this.events.set(e.runId, list);
  }
  async listEvents(id: string) {
    return this.events.get(id) ?? [];
  }
  async close() {}
}

function makeSupervisor(backend: MockBackend) {
  return new Supervisor({ backend, store: new InMemoryStore() });
}

let base: string;
let repo: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'code-context-test-'));
  repo = join(base, 'repo');
  mkdirSync(repo);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('TaskOrchestrator — code context injection', () => {
  it('injects relevant file snippets into a RETRIEVE task when repoPath is supplied', async () => {
    // Create a repo with a file whose symbols match the task objective.
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'src', 'auth.ts'),
      'export function authenticate(token: string): boolean {\n  return token.length > 0;\n}\n',
    );

    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'The authenticate function validates tokens.');

    const supervisor = makeSupervisor(backend);
    const taskStore = new InMemoryTaskStore();
    const ledger = new TaskLedger(taskStore);
    const codeIndexer = new CodeIndexer();
    const orchestrator = new TaskOrchestrator(
      ledger,
      supervisor,
      taskStore,
      undefined,
      codeIndexer,
    );

    const goal = await ledger.createGoal({
      title: 'Understand auth',
      objective: 'Understand how authentication works in this codebase.',
    });
    await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'RETRIEVE',
      title: 'Find auth code',
      objective: 'Find and explain the authenticate function.',
    });

    await orchestrator.advance(goal.goalId, { repoPath: repo });

    // The analyst's prompt (second mock call) must contain the indexed
    // file content — the code context was injected into the objective.
    const analystCall = backend.observedCalls().find((c) => c.model === 'minicpm5-analyst');
    expect(analystCall).toBeDefined();
    expect(analystCall?.prompt).toContain('authenticate');
    expect(analystCall?.prompt).toContain('auth.ts');
    expect(analystCall?.prompt).toContain('Relevant code');
  });

  it('does NOT inject code context when no repoPath is supplied', async () => {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'auth.ts'), 'export function authenticate() {}\n');

    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'No code context needed.');

    const supervisor = makeSupervisor(backend);
    const taskStore = new InMemoryTaskStore();
    const ledger = new TaskLedger(taskStore);
    const codeIndexer = new CodeIndexer();
    const orchestrator = new TaskOrchestrator(
      ledger,
      supervisor,
      taskStore,
      undefined,
      codeIndexer,
    );

    const goal = await ledger.createGoal({
      title: 'No repo',
      objective: 'A goal without a repo path.',
    });
    await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'ANALYZE',
      title: 'Analyse',
      objective: 'Analyse something.',
    });

    await orchestrator.advance(goal.goalId);

    const analystCall = backend.observedCalls().find((c) => c.model === 'minicpm5-analyst');
    expect(analystCall?.prompt).not.toContain('Relevant code');
  });

  it('does NOT inject code context for SUMMARIZE tasks (wrong type)', async () => {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'auth.ts'), 'export function authenticate() {}\n');

    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'Summary done.');

    const supervisor = makeSupervisor(backend);
    const taskStore = new InMemoryTaskStore();
    const ledger = new TaskLedger(taskStore);
    const codeIndexer = new CodeIndexer();
    const orchestrator = new TaskOrchestrator(
      ledger,
      supervisor,
      taskStore,
      undefined,
      codeIndexer,
    );

    const goal = await ledger.createGoal({
      title: 'Summary',
      objective: 'Summarise the work.',
    });
    await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'SUMMARIZE',
      title: 'Summarise',
      objective: 'Summarise the results.',
    });

    await orchestrator.advance(goal.goalId, { repoPath: repo });

    const analystCall = backend.observedCalls().find((c) => c.model === 'minicpm5-analyst');
    // SUMMARIZE tasks don't get code context injected.
    expect(analystCall?.prompt).not.toContain('Relevant code');
  });

  it('proceeds without code context when the indexer finds no supported files', async () => {
    // Repo with only unsupported file types.
    writeFileSync(join(repo, 'README.md'), '# hello\n');
    writeFileSync(join(repo, 'config.json'), '{}');

    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'No code found.');

    const supervisor = makeSupervisor(backend);
    const taskStore = new InMemoryTaskStore();
    const ledger = new TaskLedger(taskStore);
    const codeIndexer = new CodeIndexer();
    const orchestrator = new TaskOrchestrator(
      ledger,
      supervisor,
      taskStore,
      undefined,
      codeIndexer,
    );

    const goal = await ledger.createGoal({
      title: 'Empty repo',
      objective: 'Find code in an empty repo.',
    });
    await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'RETRIEVE',
      title: 'Find code',
      objective: 'Find the authenticate function.',
    });

    await orchestrator.advance(goal.goalId, { repoPath: repo });

    const analystCall = backend.observedCalls().find((c) => c.model === 'minicpm5-analyst');
    expect(analystCall?.prompt).not.toContain('Relevant code');
  });
});
