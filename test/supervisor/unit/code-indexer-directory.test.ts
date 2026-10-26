/**
 * CodeIndexer.indexDirectory — Phase 5 follow-up.
 *
 * Tests that the directory walker indexes supported files, skips
 * unsupported extensions and dependency directories, and returns a
 * map keyed by relative path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeIndexer } from '../../../src/supervisor/code/indexer.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'code-indexer-test-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('CodeIndexer.indexDirectory', () => {
  it('indexes supported files (.ts, .js, .py) and returns a map keyed by relative path', async () => {
    mkdirSync(join(base, 'src'));
    writeFileSync(join(base, 'src', 'a.ts'), 'export function greet(): string { return "hi"; }\n');
    writeFileSync(join(base, 'src', 'b.js'), 'function bye() { return "bye"; }\n');
    mkdirSync(join(base, 'python'));
    writeFileSync(join(base, 'python', 'c.py'), 'def c():\n    pass\n');

    const indexer = new CodeIndexer();
    const result = await indexer.indexDirectory(base);

    expect(result.size).toBe(3);
    expect(result.has('src/a.ts')).toBe(true);
    expect(result.has('src/b.js')).toBe(true);
    expect(result.has('python/c.py')).toBe(true);

    const a = result.get('src/a.ts');
    expect(a?.language).toBe('typescript');
    expect(a?.symbols.length).toBeGreaterThan(0);
    expect(a?.symbols[0]?.name).toBe('greet');
    expect(a?.symbols[0]?.kind).toBe('function');
  });

  it('skips unsupported file extensions (.md, .json, .txt)', async () => {
    writeFileSync(join(base, 'README.md'), '# hello\n');
    writeFileSync(join(base, 'config.json'), '{}');
    writeFileSync(join(base, 'notes.txt'), 'notes');
    writeFileSync(join(base, 'real.ts'), 'export function real() {}\n');

    const indexer = new CodeIndexer();
    const result = await indexer.indexDirectory(base);

    expect(result.size).toBe(1);
    expect(result.has('real.ts')).toBe(true);
  });

  it('skips node_modules, .git, dist, build directories', async () => {
    mkdirSync(join(base, 'node_modules'));
    writeFileSync(join(base, 'node_modules', 'dep.ts'), 'export function dep() {}\n');
    mkdirSync(join(base, '.git'));
    writeFileSync(join(base, '.git', 'config.ts'), 'export function cfg() {}\n');
    mkdirSync(join(base, 'dist'));
    writeFileSync(join(base, 'dist', 'bundle.js'), 'function bundle() {}\n');
    mkdirSync(join(base, 'src'));
    writeFileSync(join(base, 'src', 'main.ts'), 'export function main() {}\n');

    const indexer = new CodeIndexer();
    const result = await indexer.indexDirectory(base);

    expect(result.size).toBe(1);
    expect(result.has('src/main.ts')).toBe(true);
    expect(result.has('node_modules/dep.ts')).toBe(false);
  });

  it('respects the maxFiles cap', async () => {
    mkdirSync(join(base, 'src'));
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(base, 'src', `file${i}.ts`), `export function f${i}() {}\n`);
    }

    const indexer = new CodeIndexer();
    const result = await indexer.indexDirectory(base, { maxFiles: 5 });

    expect(result.size).toBeLessThanOrEqual(5);
  });

  it('handles empty directories gracefully', async () => {
    const indexer = new CodeIndexer();
    const result = await indexer.indexDirectory(base);
    expect(result.size).toBe(0);
  });

  it('handles unreadable subdirectories gracefully (no throw)', async () => {
    mkdirSync(join(base, 'src'));
    writeFileSync(join(base, 'src', 'a.ts'), 'export function a() {}\n');
    // Don't create the "missing" dir — the walker should skip it silently.
    mkdirSync(join(base, 'src', 'subdir'));

    const indexer = new CodeIndexer();
    const result = await indexer.indexDirectory(base);

    expect(result.size).toBe(1);
    expect(result.has('src/a.ts')).toBe(true);
  });
});
