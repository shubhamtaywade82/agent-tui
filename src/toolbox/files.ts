/**
 * Enhanced file & system tools — extends the MCP filesystem server with
 * agent-friendly operations: recursive directory trees, file diffs,
 * multi-file reads, and GitHub repo access (clone, list, read).
 */
import { z } from 'zod';
import { defineTool } from '@nemesis-oss/ollama-sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { resolve, relative, join, basename, dirname, extname, isAbsolute, sep } from 'node:path';
import { loadConfig, loadGitHubToken, resolvePath } from '../config.js';
import { log } from '../logger.js';
import { runProcess, sandboxEnv } from './process.js';

const MAX_READ = 16_000;

function truncate(s: string, max = MAX_READ): string {
  return s.length <= max ? s : s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}

function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** True when `target` is `root` or lies beneath it. Both paths must already be real paths. */
function isWithin(root: string, target: string): boolean {
  const r = relative(root, target);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/**
 * Directories the read tools may use: the working directory plus any
 * AGENT_FS_EXTRA_DIRS entries (the same setting the MCP filesystem server reads).
 */
function readRoots(): string[] {
  const extra = (process.env.AGENT_FS_EXTRA_DIRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [process.cwd(), ...extra].map((d) => realpathOrSelf(resolve(d)));
}

/**
 * Resolve a path for reading. Symlinks are followed before the containment check,
 * so a link inside the workspace that points outside it is refused. Returns null
 * when the path is outside every readable root.
 */
export function resolveReadable(p: string): string | null {
  const real = realpathOrSelf(resolvePath(p));
  // Return the real path, not the lexical one: the caller reads the exact target that was checked.
  return readRoots().some((root) => isWithin(root, real)) ? real : null;
}

const OUTSIDE_WORKSPACE = 'Refused: outside the workspace. Set AGENT_FS_EXTRA_DIRS to allow another directory.';

/** Read one or more files and return their concatenated contents. */
export const readFilesTool = defineTool({
  name: 'read_files',
  description: 'Read one or more files from disk and return their contents with headers. Supports text files of any common type.',
  schema: z.object({
    paths: z.array(z.string()).min(1).max(10).describe('Array of file paths to read'),
  }),
  timeoutMs: 10_000,
  execute: async ({ paths }) => {
    const out: string[] = [];
    for (const p of paths) {
      const abs = resolveReadable(p);
      if (!abs) { out.push(`=== ${p} ===\n[${OUTSIDE_WORKSPACE}]`); continue; }
      if (!existsSync(abs)) { out.push(`=== ${p} ===\n[File not found: ${abs}]`); continue; }
      try {
        const stat = statSync(abs);
        if (stat.isDirectory()) { out.push(`=== ${p} ===\n[Directory — ${readdirSync(abs).slice(0, 50).join(', ')}]`); continue; }
        out.push(`=== ${p} (${stat.size} bytes) ===\n${truncate(readFileSync(abs, 'utf8'))}`);
      } catch (e: any) { out.push(`=== ${p} ===\n[Error: ${e.message}]`); }
    }
    return out.join('\n\n');
  },
});

/** Write content to a file (creates parent dirs). */
export const writeFileTool = defineTool({
  name: 'write_file',
  description: 'Write text content to a file, creating parent directories if needed. Overwrites existing content unless append=true.',
  schema: z.object({
    path: z.string().describe('File path to write'),
    content: z.string().describe('Text content to write'),
    append: z.boolean().optional().describe('Append instead of overwrite'),
  }),
  timeoutMs: 10_000,
  execute: async ({ path, content, append }) => {
    const abs = resolvePath(path);
    mkdirSync(dirname(abs), { recursive: true });
    if (append) appendFileSync(abs, content, 'utf8');
    else writeFileSync(abs, content, 'utf8');
    log.info('write_file', { path: abs, bytes: content.length, append: Boolean(append) });
    return `Wrote ${content.length} bytes to ${abs}`;
  },
});

/** List a directory tree up to a depth limit. */
export const listTreeTool = defineTool({
  name: 'list_tree',
  description: 'List a directory tree up to a given depth, showing files and folders. Useful for understanding project structure.',
  schema: z.object({
    path: z.string().optional().describe('Directory path (default cwd)'),
    maxDepth: z.number().int().min(1).max(5).optional().describe('Max recursion depth (default 2)'),
    maxEntries: z.number().int().min(10).max(500).optional().describe('Max entries to list (default 100)'),
  }),
  timeoutMs: 10_000,
  execute: async ({ path, maxDepth, maxEntries }) => {
    const root = path ? resolveReadable(path) : process.cwd();
    if (!root) return OUTSIDE_WORKSPACE;
    if (!existsSync(root)) return `Path not found: ${root}`;
    const depth = maxDepth ?? 2;
    const limit = maxEntries ?? 100;
    const lines: string[] = [];
    let count = 0;
    const walk = (dir: string, d: number, prefix: string) => {
      if (d > depth || count >= limit) return;
      let entries: string[];
      try { entries = readdirSync(dir).filter((e) => !e.startsWith('.') || e === '.env.example'); } catch { return; }
      entries.sort();
      for (const e of entries) {
        if (count >= limit) break;
        const full = join(dir, e);
        const rel = relative(root, full);
        try {
          const stat = statSync(full);
          const isDir = stat.isDirectory();
          lines.push(`${prefix}${isDir ? '▸' : '•'} ${e}${isDir ? '/' : ''}`);
          count++;
          if (isDir) walk(full, d + 1, prefix + '  ');
        } catch {}
      }
    };
    walk(root, 0, '');
    const header = `Tree of ${root} (depth=${depth}, ${count} entries):\n`;
    return header + (lines.length ? lines.join('\n') : '[empty]');
  },
});

/**
 * Build the `git clone` argv and environment. The token never goes into the URL
 * or argv. Git would record a token-bearing URL in the clone's `.git/config`,
 * and argv is visible to other local users through `ps`. It is sent as an HTTP
 * header scoped to github.com via GIT_CONFIG_* (git >= 2.31), which keeps it
 * out of both.
 */
export function buildCloneInvocation(
  repoUrl: string,
  dest: string,
  branch: string | undefined,
  token: string | undefined,
): { args: string[]; env: Record<string, string> } {
  const args = ['clone'];
  if (branch) args.push('-b', branch);
  args.push(repoUrl, dest);
  if (!token || !repoUrl.startsWith('https://github.com/')) return { args, env: {} };
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    args,
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    },
  };
}

/** Clone a GitHub repository using the secured token (if available). */
export const cloneRepoTool = defineTool({
  name: 'clone_repo',
  description: 'Clone a GitHub repository into a target directory. Uses the configured GITHUB_TOKEN for private repos. Returns the clone path.',
  schema: z.object({
    url: z.string().describe('GitHub repo URL or owner/repo shorthand'),
    targetDir: z.string().optional().describe('Where to clone (default repos/<name>)'),
    branch: z.string().optional().describe('Branch to checkout'),
  }),
  timeoutMs: 120_000,
  execute: async ({ url, targetDir, branch }) => {
    const cfg = loadConfig();
    const repoUrl = url.startsWith('http') ? url : `https://github.com/${url}.git`;
    const token = repoUrl.startsWith('https://github.com/') ? loadGitHubToken() : undefined;
    const name = basename(repoUrl).replace(/\.git$/, '');
    const dest = targetDir ? resolvePath(targetDir) : resolvePath(`${cfg.sessionsDir.replace(/\/sessions$/, '/repos')}/${name}`);
    if (existsSync(dest)) return `Target already exists: ${dest}. Remove it first or choose another path.`;
    mkdirSync(dirname(dest), { recursive: true });
    const invocation = buildCloneInvocation(repoUrl, dest, branch, token);
    const r = await runProcess('git', invocation.args, {
      timeoutMs: 100_000,
      maxBufferBytes: 4 * 1024 * 1024,
      env: sandboxEnv(invocation.env),
    });
    if (r.exitCode !== 0) {
      const reason = r.timedOut ? 'timed out' : (r.stderr.trim() || r.errorMessage || 'unknown error');
      return `Clone failed: ${reason}`;
    }
    log.info('clone_repo', { url: repoUrl, dest, authenticated: Boolean(token) });
    return `Cloned ${url} → ${dest}`;
  },
});

/** Delete a file or directory (with safety guards). */
export const deletePathTool = defineTool({
  name: 'delete_path',
  description: 'Delete a file or directory recursively. Refuses to delete the project root or paths outside the working directory.',
  schema: z.object({
    path: z.string().describe('Path to delete'),
  }),
  timeoutMs: 10_000,
  execute: async ({ path }) => {
    const abs = resolvePath(path);
    const cwd = process.cwd();
    const rel = relative(cwd, abs);
    if (rel.startsWith('..') || rel === '') return `Refused: cannot delete path outside working directory: ${abs}`;
    if (!existsSync(abs)) return `Path not found: ${abs}`;
    try {
      rmSync(abs, { recursive: true, force: true });
      log.info('delete_path', { path: abs });
      return `Deleted: ${abs}`;
    } catch (e: any) { return `Delete failed: ${e.message}`; }
  },
});

export const fileTools = [readFilesTool, writeFileTool, listTreeTool, cloneRepoTool, deletePathTool];
