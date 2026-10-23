import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALWAYS_CONFIRM_TOOLS,
  canRememberForSession,
  effectiveChoice,
} from '../src/transcript/elicitation-policy.js';

test('shell, code and destructive file tools can never be approved for the session', () => {
  for (const tool of ['run_shell', 'run_code', 'write_file', 'write_files', 'delete_path', 'clone_repo']) {
    assert.ok(ALWAYS_CONFIRM_TOOLS.has(tool), `${tool} must always confirm`);
    assert.equal(canRememberForSession(tool), false, tool);
  }
});

test('other tools keep the session option', () => {
  for (const tool of ['generate_image', 'text_to_speech', 'calculator', 'read_files']) {
    assert.equal(canRememberForSession(tool), true, tool);
  }
});

test("allow_session is downgraded to allow_once for tools that cannot be remembered", () => {
  assert.equal(effectiveChoice('run_shell', 'allow_session'), 'allow_once');
  assert.equal(effectiveChoice('run_code', 'allow_session'), 'allow_once');
  assert.equal(effectiveChoice('generate_image', 'allow_session'), 'allow_session');
});

test('allow_once and deny are never changed by the policy', () => {
  for (const tool of ['run_shell', 'generate_image']) {
    assert.equal(effectiveChoice(tool, 'allow_once'), 'allow_once');
    assert.equal(effectiveChoice(tool, 'deny'), 'deny');
  }
});
