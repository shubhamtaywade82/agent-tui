import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deletePathTool } from '../src/toolbox/files.js';

function inWorkspace(run: (dir: string) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'delete-'));
  const dir = join(base, 'project');
  mkdirSync(dir);
  const previous = process.cwd();
  process.chdir(dir);
  return run(dir).finally(() => {
    process.chdir(previous);
    rmSync(base, { recursive: true, force: true });
  });
}

const del = (path: string) => deletePathTool.execute({ path }, {} as never) as Promise<string>;

test('deletes a file inside the project whose name begins with ..', () => inWorkspace(async (dir) => {
  writeFileSync(join(dir, '..cache'), 'x');
  const out = await del('..cache');
  assert.match(out, /^Deleted:/);
  assert.equal(existsSync(join(dir, '..cache')), false);
}));

test('refuses paths that climb out of the project', () => inWorkspace(async (dir) => {
  const sibling = join(dir, '..', 'sibling.txt');
  writeFileSync(sibling, 'keep');
  try {
    assert.match(await del('../sibling.txt'), /^Refused/);
    assert.match(await del('sub/../../sibling.txt'), /^Refused/);
    assert.equal(existsSync(sibling), true);
  } finally {
    rmSync(sibling, { force: true });
  }
}));

test('refuses to delete the project root itself', () => inWorkspace(async (dir) => {
  assert.match(await del('.'), /^Refused/);
  assert.equal(existsSync(dir), true);
}));

test('refuses an absolute path outside the project', () => inWorkspace(async () => {
  assert.match(await del('/etc/hostname-does-not-matter'), /^Refused/);
}));
