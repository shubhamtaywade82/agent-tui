import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initLogger, log } from '../src/logger.js';
import { loadUserConfig, saveUserConfig } from '../src/tools.js';

function inTempWorkspace(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    run(dir);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('saveUserConfig merges the patch into the existing file and reports success', () => {
  inTempWorkspace((dir) => {
    writeFileSync(join(dir, '.config.json'), JSON.stringify({ model: 'a', inputStyle: 'box' }));
    assert.equal(saveUserConfig({ inputStyle: 'line' }), true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.config.json'), 'utf8')), { model: 'a', inputStyle: 'line' });
  });
});

test('saveUserConfig refuses to overwrite a corrupt config file and reports failure', () => {
  inTempWorkspace((dir) => {
    const corrupt = '{ "model": "keep-me", ';
    writeFileSync(join(dir, '.config.json'), corrupt);
    assert.equal(saveUserConfig({ model: 'new' }), false);
    assert.equal(readFileSync(join(dir, '.config.json'), 'utf8'), corrupt, 'the corrupt file must be left as it was');
  });
});

test('saveUserConfig reports failure when the config path cannot be written', () => {
  inTempWorkspace((dir) => {
    mkdirSync(join(dir, '.config.json'));
    assert.equal(saveUserConfig({ model: 'x' }), false);
  });
});

test('loadUserConfig returns an empty config for a corrupt file instead of throwing', () => {
  inTempWorkspace((dir) => {
    writeFileSync(join(dir, '.config.json'), 'not json');
    assert.deepEqual(loadUserConfig(), {});
  });
});

test('the logger reports its first write failure once, not on every entry', () => {
  inTempWorkspace((dir) => {
    // A directory cannot be appended to, so every write fails.
    const unwritable = join(dir, 'log-as-dir');
    mkdirSync(unwritable);
    initLogger('debug', unwritable);

    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      log.warn('first');
      log.warn('second');
      log.warn('third');
    } finally {
      process.stderr.write = originalWrite;
    }
    const reports = captured.filter((c) => c.includes('[logger] cannot write'));
    assert.equal(reports.length, 1, 'the failure should be reported exactly once');
  });
});
