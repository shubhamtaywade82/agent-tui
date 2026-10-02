/**
 * Enhanced file & system tools — extends the MCP filesystem server with
 * agent-friendly operations: recursive directory trees, file diffs,
 * multi-file reads, and GitHub repo access (clone, list, read).
 */
import { z } from 'zod';
import { defineTool } from '@nemesis-oss/ollama-sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync, rmSync } from 'node:fs';
import { resolve, relative, join, basename, dirname, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, loadGitHubToken, resolvePath } from '../config.js';
import { log } from '../logger.js';

const MAX_READ = 16_000;

function truncate(s: string, max = MAX_READ): string {
  return s.length <= max ? s : s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}

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
      const abs = resolvePath(p);
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
    const root = path ? resolvePath(path) : process.cwd();
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
    let repoUrl = url.startsWith('http') ? url : `https://github.com/${url}.git`;
    const token = loadGitHubToken();
    if (token && repoUrl.startsWith('https://github.com/')) {
      repoUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);
    }
    const name = basename(repoUrl).replace(/\.git$/, '');
    const dest = targetDir ? resolvePath(targetDir) : resolvePath(`${cfg.sessionsDir.replace(/\/sessions$/, '/repos')}/${name}`);
    if (existsSync(dest)) return `Target already exists: ${dest}. Remove it first or choose another path.`;
    mkdirSync(dirname(dest), { recursive: true });
    const args = ['clone', repoUrl, dest];
    if (branch) args.splice(1, 0, '-b', branch);
    try {
      execFileSync('git', args, { timeout: 100_000, encoding: 'utf8', stdio: 'pipe' });
      log.info('clone_repo', { url: url.replace(token ?? '***', '***'), dest });
      // Avoid leaking the token-bearing URL in logs
      return `Cloned ${url} → ${dest}`;
    } catch (err: any) {
      return `Clone failed: ${err.message?.replace(/x-access-token:[^@]+@/g, '***@')}`;
    }
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
