import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOllamaEndpoints } from '../src/ollama-endpoints.js';
import {
  createOllamaRunRoutingState,
  maybeEscalateOllamaModel,
  resolveOllamaModelForTask,
} from '../src/ollama-routing.js';
import type { AgentConfig } from '../src/config.js';

test('buildOllamaEndpoints adds cloud when API key is set', () => {
  const eps = buildOllamaEndpoints({
    localHost: 'http://localhost:11434',
    cloudBaseUrl: 'https://ollama.com',
    apiKey: 'test-key',
    cloudModels: ['gpt-oss:120b'],
    localModels: [],
    routingMode: 'local-first',
  });
  assert.equal(eps.length, 2);
  assert.equal(eps[1]?.name, 'cloud');
  assert.deepEqual(eps[1]?.models, ['gpt-oss:120b']);
  assert.equal(eps[0]?.priority, 10);
  assert.equal(eps[1]?.priority, 5);
});

function mockOllamaCfg(overrides: Partial<AgentConfig['provider']['ollama']> = {}): AgentConfig {
  const ollama = {
    localHost: 'http://localhost:11434',
    cloudBaseUrl: 'https://ollama.com',
    apiKey: 'k',
    cloudModels: [] as string[],
    localModels: [] as string[],
    defaultModel: 'qwen3:8b',
    cloudDefaultModel: 'gpt-oss:120b',
    routingMode: 'auto' as const,
    autoEscalateScore: 0.35,
    routerModel: '',
    routerBackend: 'heuristic' as const,
    escalateAfterTools: 6,
    escalateAfterIterations: 3,
    endpoints: [],
    ...overrides,
  };
  return {
    provider: {
      active: 'ollama',
      ollama,
      openai: { baseUrl: '', defaultModel: '' },
      anthropic: { baseUrl: '', defaultModel: '' },
      zai: { baseUrl: '', defaultModel: '' },
    },
    maxIterations: 12,
    wallTimeMs: 120_000,
    contextBudget: 12000,
    numCtx: 32768,
    contextReserve: 4096,
    toolRepeatLimit: 2,
    temperature: 0.7,
    thinking: true,
    tools: 'all',
    mcp: 'all',
    logLevel: 'info',
    logFile: '',
    sessionsDir: '.agent/sessions',
  };
}

test('resolveOllamaModelForTask escalates heavy prompts in auto mode', () => {
  const cfg = mockOllamaCfg({ autoEscalateScore: 0.25 });
  const pick = resolveOllamaModelForTask(
    cfg,
    'Please refactor the entire codebase and migrate to a new architecture',
  );
  assert.equal(pick.model, 'gpt-oss:120b');
  assert.equal(pick.tier, 'cloud');
});

test('resolveOllamaModelForTask keeps local model for light prompts', () => {
  const cfg = mockOllamaCfg();
  const pick = resolveOllamaModelForTask(cfg, 'What is 2+2?');
  assert.equal(pick.model, 'qwen3:8b');
});

test('maybeEscalateOllamaModel upgrades after enough tool calls', () => {
  const cfg = mockOllamaCfg({ escalateAfterTools: 4, escalateAfterIterations: 99 });
  const state = createOllamaRunRoutingState();
  state.toolCalls = 5;
  const mid = maybeEscalateOllamaModel(cfg, state, 'qwen3:8b');
  assert.ok(mid);
  assert.equal(mid!.model, 'gpt-oss:120b');
  assert.match(mid!.reason, /mid-run escalate/);
});
