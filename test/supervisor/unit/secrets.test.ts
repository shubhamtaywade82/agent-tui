import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretResolver } from '../../../src/supervisor/security/secrets.js';

describe('SecretResolver', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secrets-'));
    process.env.SUP_TEST_ENV_SECRET = 'from-env';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SUP_TEST_ENV_SECRET;
  });

  it('resolves the env backend from the named variable', () => {
    expect(new SecretResolver().resolve({ ref: 'SUP_TEST_ENV_SECRET', backend: 'env' })).toBe(
      'from-env',
    );
  });

  it('reads the file named by a file: reference, without the trailing newline', () => {
    const path = join(dir, 'db.key');
    writeFileSync(path, 'file-secret\n');
    expect(new SecretResolver().resolve({ ref: `file:${path}`, backend: 'file' })).toBe(
      'file-secret',
    );
  });

  it('does not read an environment variable named by the file path (the old bug)', () => {
    const path = join(dir, 'missing.key');
    process.env[path] = 'would-be-wrong';
    try {
      expect(() =>
        new SecretResolver().resolve({ ref: `file:${path}`, backend: 'file' }),
      ).toThrow();
    } finally {
      delete process.env[path];
    }
  });

  it('rejects a relative file path rather than resolving it against the working directory', () => {
    expect(() =>
      new SecretResolver().resolve({ ref: 'file:relative/secret', backend: 'file' }),
    ).toThrow(/absolute path/);
  });

  it('fails closed for the vault backend even when an env variable with the same name exists', () => {
    process.env.SUP_TEST_VAULT_NAME = 'env-value';
    try {
      const resolver = new SecretResolver();
      expect(() => resolver.resolve({ ref: 'SUP_TEST_VAULT_NAME', backend: 'vault' })).toThrow(
        /not implemented/,
      );
      expect(resolver.canResolve({ ref: 'SUP_TEST_VAULT_NAME', backend: 'vault' })).toBe(false);
    } finally {
      delete process.env.SUP_TEST_VAULT_NAME;
    }
  });

  it('reports a missing env secret rather than returning an empty string', () => {
    expect(() => new SecretResolver().resolve({ ref: 'SUP_TEST_NOT_SET', backend: 'env' })).toThrow(
      /not found/,
    );
  });
});
