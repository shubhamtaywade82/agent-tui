import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderUiTool, handleGenUiCommand, GENUI_TEMPLATES } from '../src/toolbox/genui.js';
import { parseMarkdownBlocks } from '../src/components/ui/markdown/index.js';

test('renderUiTool validates correct openui-lang code and wraps in markdown block', async () => {
  const validCode = [
    'root = Container("column", 1, "round", [header, status])',
    'header = Text("Test Header", "cyan", true, false)',
    'status = Badge("Ready", "success")',
  ].join('\n');

  const result = await renderUiTool.execute({ code: validCode }, {} as never);
  assert.match(result, /^```openui-lang\nroot = Container/);
});

test('renderUiTool catches syntax errors and returns descriptive guidance', async () => {
  const invalidCode = 'root = NonExistentComponent(123)';
  const result = await renderUiTool.execute({ code: invalidCode }, {} as never);
  assert.match(result, /GenUI Syntax Error:/);
});

test('handleGenUiCommand dispatches template cards and validates templates', () => {
  let addedCard = '';
  let toastMsg = '';

  const mockCtx: any = {
    addSystemCard: (msg: string) => { addedCard = msg; },
    showToast: (msg: string) => { toastMsg = msg; },
  };

  const ok = handleGenUiCommand('dashboard', mockCtx);
  assert.equal(ok, true);
  assert.match(addedCard, /```openui-lang/);
  assert.match(toastMsg, /Loaded GenUI template: dashboard/);

  handleGenUiCommand('nonexistent', mockCtx);
  assert.match(toastMsg, /Unknown template "nonexistent"/);
});

test('parseMarkdownBlocks converts openui-lang codeblocks into interactive GenUIRenderer', () => {
  const markdownWithGenUI = [
    'Here is the requested dashboard:',
    '```openui-lang',
    'root = Text("Live GenUI Component", "green", true, false)',
    '```',
  ].join('\n');

  const blocks = parseMarkdownBlocks(markdownWithGenUI);
  assert.equal(blocks.length, 2);
  // Second block is the rendered GenUI container
  assert.equal(typeof blocks[1], 'object');
});

test('parseMarkdownBlocks falls back to standard code block when openui-lang has invalid syntax', () => {
  const markdownWithInvalid = [
    'Broken codeblock:',
    '```openui-lang',
    'invalid broken statement without equals',
    '```',
  ].join('\n');

  const blocks = parseMarkdownBlocks(markdownWithInvalid);
  assert.ok(blocks.length >= 2);
});

test('renderUiTool validates extended Termina components (Gauge, Sparkline, DiffView, TokenCounter, Divider, Confirm)', async () => {
  const extendedCode = [
    'root = Container("column", 1, "round", [g, s, d, tok, c])',
    'g = Gauge(75, "CPU Load")',
    's = Sparkline([10, 20, 30, 45, 60])',
    'd = Divider("System Status")',
    'tok = TokenCounter(1200, 4096, "tokens")',
    'c = Confirm("Deploy to Cluster", "deployApp", "cancelDeploy")',
  ].join('\n');

  const result = await renderUiTool.execute({ code: extendedCode }, {} as never);
  assert.match(result, /^```openui-lang\nroot = Container/);
});

test('createUniversalActionDispatcher routes actions and payloads to handler', async () => {
  const { createUniversalActionDispatcher } = await import('../src/toolbox/genui.js');
  let dispatchedName = '';
  let dispatchedPayload: Record<string, unknown> = {};

  const dispatcher = createUniversalActionDispatcher((name, payload) => {
    dispatchedName = name;
    dispatchedPayload = payload;
  });

  assert.ok(dispatcher);
  assert.equal(dispatcher.has('anyAction'), true);
  await dispatcher.dispatch('deployCluster', { env: 'production', region: 'us-east-1' });

  assert.equal(dispatchedName, 'deployCluster');
  assert.equal(dispatchedPayload['env'], 'production');
  assert.equal(dispatchedPayload['region'], 'us-east-1');
});
