import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { SlashCommandInfo, CommandContext } from './tools.js';

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

interface Task {
  id: string;
  title: string;
  objective: string;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  targetFiles: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  dependencies: string[];
  note?: string;
  failureReason?: string;
}

const TASK_STATUSES = new Set<TaskStatus>(['pending', 'in_progress', 'completed', 'blocked', 'cancelled']);

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === 'string' &&
    typeof task.title === 'string' &&
    typeof task.objective === 'string' &&
    typeof task.status === 'string' &&
    TASK_STATUSES.has(task.status as TaskStatus) &&
    typeof task.attempts === 'number' &&
    typeof task.maxAttempts === 'number' &&
    Array.isArray(task.targetFiles) &&
    task.targetFiles.every((item) => typeof item === 'string') &&
    Array.isArray(task.acceptanceCriteria) &&
    task.acceptanceCriteria.every((item) => typeof item === 'string') &&
    Array.isArray(task.verificationCommands) &&
    task.verificationCommands.every((item) => typeof item === 'string') &&
    Array.isArray(task.dependencies) &&
    task.dependencies.every((item) => typeof item === 'string') &&
    (task.note === undefined || typeof task.note === 'string') &&
    (task.failureReason === undefined || typeof task.failureReason === 'string')
  );
}

class TaskRuntime {
  private readonly filePath: string;
  private tasks: Task[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.tasks = this.load();
  }

  listTasks(): Task[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  getTask(id: string): Task | undefined {
    const task = this.tasks.find((item) => item.id === id);
    return task ? { ...task } : undefined;
  }

  nextReady(): Task | undefined {
    const completed = new Set(this.tasks.filter((task) => task.status === 'completed').map((task) => task.id));
    const task = this.tasks.find(
      (item) => item.status === 'pending' && item.dependencies.every((dependency) => completed.has(dependency)),
    );
    return task ? { ...task } : undefined;
  }

  addTask(input: Pick<Task, 'id' | 'title' | 'objective'>): void {
    if (this.tasks.some((task) => task.id === input.id)) {
      throw new Error(`Task already exists: ${input.id}`);
    }
    this.tasks.push({
      ...input,
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      targetFiles: [],
      acceptanceCriteria: [],
      verificationCommands: [],
      dependencies: [],
    });
    this.save();
  }

  start(id: string): void {
    const task = this.requireTask(id);
    if (task.status !== 'pending') throw new Error(`Task cannot be started from status "${task.status}"`);
    task.status = 'in_progress';
    task.attempts += 1;
    this.save();
  }

  complete(id: string, options: { note?: string } = {}): void {
    const task = this.requireTask(id);
    if (task.status !== 'in_progress') throw new Error(`Task cannot be completed from status "${task.status}"`);
    task.status = 'completed';
    task.note = options.note;
    delete task.failureReason;
    this.save();
  }

  fail(id: string, reason: string): Task {
    const task = this.requireTask(id);
    if (task.status !== 'in_progress') throw new Error(`Task cannot fail from status "${task.status}"`);
    task.failureReason = reason;
    task.status = task.attempts >= task.maxAttempts ? 'blocked' : 'pending';
    this.save();
    return { ...task };
  }

  cancel(id: string): void {
    const task = this.requireTask(id);
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new Error(`Task cannot be cancelled from status "${task.status}"`);
    }
    task.status = 'cancelled';
    this.save();
  }

  private requireTask(id: string): Task {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  private load(): Task[] {
    if (!existsSync(this.filePath)) return [];
    const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isTask)) {
      throw new Error(`Invalid task store: expected an array of valid tasks in ${this.filePath}`);
    }
    return parsed;
  }

  private save(): void {
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.tasks, null, 2), 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}

let runtime: TaskRuntime | null = null;
let activeTaskId: string | undefined;

export function getTaskRuntime(): TaskRuntime {
  if (!runtime) {
    mkdirSync('.agent', { recursive: true });
    runtime = new TaskRuntime('.agent/tasks.json');
  }
  return runtime;
}

function buildTaskPrompt(task: Task): string {
  const section = (label: string, items: string[]) => (items.length ? `${label}:\n${items.map((i) => `- ${i}`).join('\n')}\n` : '');
  return [
    'You are implementing exactly one bounded engineering task. Implement the smallest coherent change.',
    `Task: ${task.title}`,
    `Objective: ${task.objective}`,
    section('Target files', task.targetFiles),
    section('Acceptance criteria', task.acceptanceCriteria),
    section('Suggested verification commands (propose, do not assume they passed)', task.verificationCommands),
    'Use the available filesystem/git MCP tools to inspect and edit. Do not claim the task is verified — a human confirms that with /tasks verify after checking your work.',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatTaskList(tasks: Task[]): string {
  if (!tasks.length) return 'No tasks yet. Add one with /tasks add <id> :: <title> :: <objective>';
  return tasks
    .map((t) => `• [${t.status}] ${t.id}: ${t.title}${t.attempts ? ` (attempt ${t.attempts}/${t.maxAttempts})` : ''}`)
    .join('\n');
}

function parseAdd(arg: string): { id: string; title: string; objective: string } | null {
  const [id, title, objective] = arg.split('::').map((s) => s.trim());
  return id && title && objective ? { id, title, objective } : null;
}

function resolveTaskId(arg: string): string | undefined {
  return arg || activeTaskId;
}

export const TASK_SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: '/tasks', args: '[list|add|next|run|verify|fail|cancel]', desc: 'Manage the long-running task graph' },
];

export function handleTasksCommand(arg: string, ctx: CommandContext & { runPrompt?: (text: string) => void }): boolean {
  const [sub, ...rest] = arg.split(/\s+/);
  const tail = rest.join(' ');
  const rt = getTaskRuntime();

  switch (sub) {
    case undefined:
    case 'list':
      ctx.addSystemCard(formatTaskList(rt.listTasks()));
      return true;

    case 'add': {
      const parsed = parseAdd(tail);
      if (!parsed) {
        ctx.showToast('Usage: /tasks add <id> :: <title> :: <objective>', 'error', 4000);
        return true;
      }
      rt.addTask(parsed);
      ctx.showToast(`Task added: ${parsed.id}`, 'info', 2500);
      return true;
    }

    case 'next': {
      const next = rt.nextReady();
      ctx.addSystemCard(next ? `Next ready task: ${next.id} — ${next.title}` : 'No task is ready (none pending with satisfied dependencies).');
      return true;
    }

    case 'run': {
      const next = rt.nextReady();
      if (!next) {
        ctx.showToast('No ready task to run', 'warning', 3000);
        return true;
      }
      rt.start(next.id);
      activeTaskId = next.id;
      ctx.addSystemCard(`Starting task ${next.id}: ${next.title}\nAfter reviewing the result, run /tasks verify or /tasks fail <reason>.`);
      void ctx.runPrompt?.(buildTaskPrompt(next));
      return true;
    }

    case 'verify': {
      const [requestedId = '', ...noteParts] = tail.split(/\s+/);
      const id = resolveTaskId(requestedId);
      if (!id) return (ctx.showToast('No active task. Usage: /tasks verify <id> [note]', 'error', 3000), true);
      rt.complete(id, { note: noteParts.join(' ') || undefined });
      if (activeTaskId === id) activeTaskId = undefined;
      ctx.showToast(`Task ${id} verified`, 'info', 2500);
      return true;
    }

    case 'fail': {
      const [maybeId, ...reasonParts] = tail.split(/\s+/);
      const id = rt.getTask(maybeId ?? '') ? maybeId : activeTaskId;
      const reason = rt.getTask(maybeId ?? '') ? reasonParts.join(' ') : tail;
      if (!id) return (ctx.showToast('No active task. Usage: /tasks fail <id> <reason>', 'error', 3000), true);
      const updated = rt.fail(id, reason || 'unspecified failure');
      if (activeTaskId === id) activeTaskId = undefined;
      ctx.showToast(`Task ${id} → ${updated.status}`, updated.status === 'blocked' ? 'error' : 'warning', 3000);
      return true;
    }

    case 'cancel': {
      const id = resolveTaskId(tail);
      if (!id) return (ctx.showToast('Usage: /tasks cancel <id>', 'error', 3000), true);
      rt.cancel(id);
      if (activeTaskId === id) activeTaskId = undefined;
      ctx.showToast(`Task ${id} cancelled`, 'info', 2500);
      return true;
    }

    default:
      ctx.showToast(`Unknown /tasks subcommand: ${sub}`, 'error', 3000);
      return true;
  }
}
