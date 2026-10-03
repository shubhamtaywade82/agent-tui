import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { defineTool } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';
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
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === 'string' && typeof t.title === 'string' && typeof t.objective === 'string' &&
    typeof t.status === 'string' && TASK_STATUSES.has(t.status as TaskStatus) &&
    typeof t.attempts === 'number' && typeof t.maxAttempts === 'number' &&
    Array.isArray(t.targetFiles) && Array.isArray(t.acceptanceCriteria) &&
    Array.isArray(t.verificationCommands) && Array.isArray(t.dependencies)
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
      ...input, status: 'pending', attempts: 0, maxAttempts: 3,
      targetFiles: [], acceptanceCriteria: [], verificationCommands: [], dependencies: [],
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

export function buildTaskPrompt(task: Task): string {
  const section = (label: string, items: string[]) => (items.length ? `${label}:\n${items.map((i) => `- ${i}`).join('\n')}\n` : '');
  return [
    'You are implementing exactly one bounded engineering task. Implement the smallest coherent change.',
    `Task: ${task.title}`,
    `Objective: ${task.objective}`,
    section('Target files', task.targetFiles),
    section('Acceptance criteria', task.acceptanceCriteria),
    section('Suggested verification commands', task.verificationCommands),
    `Execute the required shell commands and file changes. When you finish this task, call complete_task(id="${task.id}") to record its completion.`,
  ].filter(Boolean).join('\n');
}

export const createTaskTool = defineTool({
  name: 'create_task',
  description: 'Create a task/todo in the plan with an id, title, and objective. Call this for multi-step goals to break them into tracked tasks.',
  schema: z.object({
    id: z.string().describe('Unique kebab-case task identifier (e.g. "init-app", "setup-models")'),
    title: z.string().describe('Short task title'),
    objective: z.string().describe('Detailed objective and expected outcome'),
    dependencies: z.array(z.string()).optional().describe('IDs of prerequisite tasks'),
  }),
  execute: async ({ id, title, objective, dependencies }) => {
    const rt = getTaskRuntime();
    try {
      rt.addTask({ id, title, objective });
      if (dependencies?.length) {
        const task = rt.getTask(id);
        if (task) task.dependencies = dependencies;
      }
      return `Task "${id}" added to plan.`;
    } catch (err: any) {
      return `Error creating task: ${err.message}`;
    }
  },
});

export const completeTaskTool = defineTool({
  name: 'complete_task',
  description: 'Mark a task in the plan as completed with an optional summary note of what was done.',
  schema: z.object({
    id: z.string().describe('Task ID to mark complete'),
    note: z.string().optional().describe('Summary note of what was implemented or verified'),
  }),
  execute: async ({ id, note }) => {
    const rt = getTaskRuntime();
    try {
      const task = rt.getTask(id);
      if (!task) return `Task "${id}" not found.`;
      if (task.status === 'pending') rt.start(id);
      rt.complete(id, { note });
      const next = rt.nextReady();
      return `Task "${id}" marked completed.${next ? ` Next ready task is "${next.id}": ${next.title}` : ' All planned tasks are now complete!'}`;
    } catch (err: any) {
      return `Error completing task: ${err.message}`;
    }
  },
});

export const listTasksTool = defineTool({
  name: 'list_tasks',
  description: 'List all planned tasks/todos and their statuses (pending, in_progress, completed, blocked).',
  schema: z.object({}),
  execute: async () => {
    const rt = getTaskRuntime();
    const tasks = rt.listTasks();
    if (!tasks.length) return 'No tasks in plan yet.';
    return tasks.map((t) => `• [${t.status}] ${t.id}: ${t.title}${t.note ? ` — ${t.note}` : ''}`).join('\n');
  },
});

export const taskTools = [createTaskTool, completeTaskTool, listTasksTool];

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
      if (!parsed) return (ctx.showToast('Usage: /tasks add <id> :: <title> :: <objective>', 'error', 4000), true);
      rt.addTask(parsed);
      ctx.showToast(`Task added: ${parsed.id}`, 'info', 2500);
      return true;
    }
    case 'next': {
      const next = rt.nextReady();
      ctx.addSystemCard(next ? `Next ready task: ${next.id} — ${next.title}` : 'No task is ready.');
      return true;
    }
    case 'run': {
      const next = rt.nextReady();
      if (!next) return (ctx.showToast('No ready task to run', 'warning', 3000), true);
      rt.start(next.id);
      activeTaskId = next.id;
      ctx.addSystemCard(`Starting task ${next.id}: ${next.title}\nRun /tasks verify or /tasks fail after review.`);
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
