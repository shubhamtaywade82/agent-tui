import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listTreeTool, readFilesTool, resolveReadable } from '../src/toolbox/files.js';

const REFUSED = /outside the workspace/;

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'confine-'));
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(workspace, 'notes.txt'), 'inside');
  writeFileSync(join(outside, 'secret.txt'), 'outside-secret');
  symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
  const previousCwd = process.cwd();
  const previousExtra = process.env.AGENT_FS_EXTRA_DIRS;
  process.chdir(workspace);
  delete process.env.AGENT_FS_EXTRA_DIRS;
  return {
    outside,
    cleanup() {
      process.chdir(previousCwd);
      if (previousExtra === undefined) delete process.env.AGENT_FS_EXTRA_DIRS;
      else process.env.AGENT_FS_EXTRA_DIRS = previousExtra;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('read_files reads files inside the workspace', async () => {
  const env = setup();
  try {
    const out = await readFilesTool.execute({ paths: ['notes.txt'] }, {} as never);
    assert.match(String(out), /inside/);
  } finally { env.cleanup(); }
});

test('read_files refuses ../ traversal and absolute paths outside the workspace', async () => {
  const env = setup();
  try {
    const out = String(await readFilesTool.execute({ paths: ['../outside/secret.txt', join(env.outside, 'secret.txt')] }, {} as never));
    assert.match(out, REFUSED);
    assert.doesNotMatch(out, /outside-secret/);
  } finally { env.cleanup(); }
});

test('read_files refuses a symlink inside the workspace that points outside it', async () => {
  const env = setup();
  try {
    const out = String(await readFilesTool.execute({ paths: ['link.txt'] }, {} as never));
    assert.match(out, REFUSED);
    assert.doesNotMatch(out, /outside-secret/);
    assert.equal(resolveReadable('link.txt'), null);
  } finally { env.cleanup(); }
});

test('AGENT_FS_EXTRA_DIRS opens exactly the listed directory for reading', async () => {
  const env = setup();
  try {
    process.env.AGENT_FS_EXTRA_DIRS = env.outside;
    const out = String(await readFilesTool.execute({ paths: ['link.txt'] }, {} as never));
    assert.match(out, /outside-secret/);
  } finally { env.cleanup(); }
});

test('list_tree is confined the same way', async () => {
  const env = setup();
  try {
    const out = String(await listTreeTool.execute({ path: '..' }, {} as never));
    assert.match(out, REFUSED);
    const inside = String(await listTreeTool.execute({ path: '.' }, {} as never));
    assert.match(inside, /notes\.txt/);
  } finally { env.cleanup(); }
});
