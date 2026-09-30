import { mkdirSync } from 'node:fs';
import { ProjectRuntime, type Task } from '@nemesis-oss/agentic-runtime/project';
import type { SlashCommandInfo, CommandContext } from './tools.js';

let runtime: ProjectRuntime | null = null;
let activeTaskId: string | undefined;

export function getTaskRuntime(): ProjectRuntime {
  if (!runtime) {
    mkdirSync('.agent', { recursive: true });
    runtime = new ProjectRuntime('.agent/tasks.db');
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
      const id = resolveTaskId(tail.split(/\s+/)[0] ?? '');
      if (!id) return (ctx.showToast('No active task. Usage: /tasks verify <id> [note]', 'error', 3000), true);
      rt.complete(id, { note: tail });
      ctx.showToast(`Task ${id} verified`, 'info', 2500);
      return true;
    }

    case 'fail': {
      const [maybeId, ...reasonParts] = tail.split(/\s+/);
      const id = rt.getTask(maybeId ?? '') ? maybeId : activeTaskId;
      const reason = rt.getTask(maybeId ?? '') ? reasonParts.join(' ') : tail;
      if (!id) return (ctx.showToast('No active task. Usage: /tasks fail <id> <reason>', 'error', 3000), true);
      const updated = rt.fail(id, reason || 'unspecified failure');
      ctx.showToast(`Task ${id} → ${updated.status}`, updated.status === 'blocked' ? 'error' : 'warning', 3000);
      return true;
    }

    case 'cancel': {
      const id = resolveTaskId(tail);
      if (!id) return (ctx.showToast('Usage: /tasks cancel <id>', 'error', 3000), true);
      rt.cancel(id);
      ctx.showToast(`Task ${id} cancelled`, 'info', 2500);
      return true;
    }

    default:
      ctx.showToast(`Unknown /tasks subcommand: ${sub}`, 'error', 3000);
      return true;
  }
}
