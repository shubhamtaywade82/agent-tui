/**
 * Session persistence — save, restore, and list conversations.
 *
 * Sessions are stored as JSON files under the configured sessions directory
 * (default `.agent/sessions/`). Each session holds the full message history,
 * metadata, and an optional title. Transcripts can also be exported to
 * Markdown for human reading.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, resolvePath } from './config.js';
import { log } from './logger.js';
import type { ChatMessage } from './providers.js';

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
  messageCount: number;
}

export interface Session extends SessionMeta {
  messages: ChatMessage[];
}

function sessionsDir(): string {
  const cfg = loadConfig();
  const dir = resolvePath(cfg.sessionsDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionPath(id: string): string {
  return resolve(sessionsDir(), `${id}.json`);
}

function genId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Save a conversation as a session. Creates a new one if id is omitted. */
export function saveSession(messages: ChatMessage[], opts?: { id?: string; title?: string; provider?: string; model?: string }): Session {
  const cfg = loadConfig();
  const id = opts?.id ?? genId();
  const existing = opts?.id ? loadSession(opts.id) : undefined;
  const now = Date.now();
  const session: Session = {
    id,
    title: opts?.title ?? existing?.title ?? deriveTitle(messages),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    provider: opts?.provider ?? cfg.provider.active,
    model: opts?.model ?? cfg.provider[cfg.provider.active].defaultModel,
    messageCount: messages.length,
    messages,
  };
  writeFileSync(sessionPath(id), JSON.stringify(session, null, 2), 'utf8');
  log.info('Session saved', { id, messages: messages.length, title: session.title.slice(0, 50) });
  return session;
}

/** Load a session by id. Returns null if not found. */
export function loadSession(id: string): Session | null {
  const file = sessionPath(id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Session;
  } catch (e: any) {
    log.warn('Session load failed', { id, error: e.message });
    return null;
  }
}

/** Rename / retitle a session. */
export function renameSession(id: string, title: string): boolean {
  const s = loadSession(id);
  if (!s) return false;
  s.title = title;
  s.updatedAt = Date.now();
  writeFileSync(sessionPath(id), JSON.stringify(s, null, 2), 'utf8');
  return true;
}

/** Delete a session. */
export function deleteSession(id: string): boolean {
  const file = sessionPath(id);
  if (!existsSync(file)) return false;
  try { renameSync(file, `${file}.deleted`); return true; } catch { return false; }
}

/** List all saved sessions (metadata only, newest first). */
export function listSessions(): SessionMeta[] {
  const dir = sessionsDir();
  const metas: SessionMeta[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.deleted')) continue;
    try {
      const s = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as Session;
      metas.push({
        id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
        provider: s.provider, model: s.model, messageCount: s.messageCount,
      });
    } catch {}
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Export a session to a Markdown transcript. */
export function exportSessionMarkdown(id: string, outPath?: string): string {
  const s = loadSession(id);
  if (!s) throw new Error(`Session ${id} not found`);
  const body = s.messages.map((m) => {
    const role = m.role.toUpperCase();
    const tc = m.tool_calls?.length ? `\n  [tool_calls: ${m.tool_calls.map((tc) => tc.function.name).join(', ')}]` : '';
    return `### ${role}${tc}\n\n${m.content}`;
  }).join('\n\n---\n\n');
  const md = `# Session: ${s.title}\n\n- ID: ${s.id}\n- Provider: ${s.provider} / ${s.model}\n- Created: ${new Date(s.createdAt).toLocaleString()}\n- Messages: ${s.messageCount}\n\n---\n\n${body}`;
  const target = outPath ?? resolvePath(`session-${s.id}.md`);
  writeFileSync(target, md, 'utf8');
  log.info('Session exported', { id, path: target });
  return target;
}

/** Append-only global conversation log (every user prompt + assistant reply). */
const LOG_FILE = '.agent/conversation.log';
export function appendToConversationLog(role: string, content: string): void {
  try {
    const dir = resolvePath(LOG_FILE);
    if (!existsSync(resolve(dir, '..'))) mkdirSync(resolve(dir, '..'), { recursive: true });
    appendFileSync(dir, `[${new Date().toISOString()}] ${role.toUpperCase()}: ${content.replace(/\n/g, ' ').slice(0, 500)}\n`, 'utf8');
  } catch {}
}

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'Untitled session';
  const text = firstUser.content.replace(/\n/g, ' ').trim();
  return text.length > 60 ? text.slice(0, 57) + '...' : text || 'Untitled session';
}
