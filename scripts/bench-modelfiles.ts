/**
 * MiniCPM5 Modelfile variant benchmark — live Ollama tests.
 *
 * Runs each installed variant against a fixed set of prompts and records
 * timing, token usage, output quality, and failure modes. Requires a
 * running Ollama server with the variants already built via seed-models.sh.
 *
 * Usage:
 *   npx tsx scripts/bench-modelfiles.ts
 *   BENCH_MODELS="minicpm5-reasoning,minicpm5-low-repetition" npx tsx scripts/bench-modelfiles.ts
 *   BENCH_REPEATS=3 npx tsx scripts/bench-modelfiles.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Ollama } from 'ollama';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const REPEATS = Number(process.env.BENCH_REPEATS ?? '1');
const TIMEOUT_MS = 120_000;

// All variants the seed script creates
const ALL_MODELS = [
  'openbmb/minicpm5-2b',
  'minicpm5-router', 'minicpm5-toolagent', 'minicpm5-analyst', 'minicpm5-summarizer',
  'minicpm5-reasoning', 'minicpm5-fast-router', 'minicpm5-tool-agent',
  'minicpm5-tool-search', 'minicpm5-coding-agent', 'minicpm5-long-context',
  'minicpm5-recovery', 'minicpm5-structured-output', 'minicpm5-low-repetition',
  'minicpm5-cloud-escalation',
];

interface TestResult {
  model: string;
  test: string;
  pass: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  output: string;
  error?: string;
}

interface BenchReport {
  timestamp: string;
  ollamaHost: string;
  repeats: number;
  results: TestResult[];
}

const client = new Ollama({ host: OLLAMA_HOST });

// ── Test definitions ────────────────────────────────────────────

async function testBasicInference(model: string): Promise<TestResult> {
  const started = Date.now();
  try {
    const r = await client.chat({
      model,
      messages: [{ role: 'user', content: 'What are three benefits of TypeScript over JavaScript? Be concise.' }],
      stream: false,
    });
    const content = r.message?.content ?? '';
    return {
      model, test: 'basic-inference', pass: content.length > 20,
      latencyMs: Date.now() - started,
      promptTokens: r.prompt_eval_count ?? 0,
      completionTokens: r.eval_count ?? 0,
      output: content.slice(0, 500),
    };
  } catch (e) {
    return fail(model, 'basic-inference', started, e);
  }
}

async function testRouterJson(model: string): Promise<TestResult> {
  const started = Date.now();
  try {
    const r = await client.chat({
      model,
      messages: [{ role: 'user', content: 'Check the CI/CD pipeline status for the payments microservice.' }],
      format: 'json',
      stream: false,
    });
    const content = r.message?.content ?? '';
    let parsed = false;
    let intentOk = false;
    try {
      const obj = JSON.parse(content);
      parsed = true;
      const validIntents = ['DATA_EXTRACTION', 'CODE_REVIEW', 'TOOL_EXECUTION', 'LOG_SUMMARIZATION', 'GENERAL_QUERY'];
      intentOk = typeof obj.intent === 'string' && validIntents.includes(obj.intent);
    } catch { /* not JSON */ }
    return {
      model, test: 'router-json',
      pass: parsed && intentOk,
      latencyMs: Date.now() - started,
      promptTokens: r.prompt_eval_count ?? 0,
      completionTokens: r.eval_count ?? 0,
      output: content.slice(0, 300),
    };
  } catch (e) {
    return fail(model, 'router-json', started, e);
  }
}

async function testToolCallJson(model: string): Promise<TestResult> {
  const started = Date.now();
  const prompt = `Available tools:
- get_pipeline_status: Check CI/CD pipeline status. Parameters: {"service": "string (required)"}
- send_email: Send an email. Parameters: {"to": "string", "subject": "string", "body": "string"}

User request: Check the pipeline status for checkout-service.

Output ONLY: {"tool": "<name>", "arguments": {...}}`;
  try {
    const r = await client.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      format: 'json',
      stream: false,
    });
    const content = r.message?.content ?? '';
    let pass = false;
    try {
      const obj = JSON.parse(content);
      pass = obj.tool === 'get_pipeline_status' && typeof obj.arguments?.service === 'string';
    } catch { /* not JSON */ }
    return {
      model, test: 'tool-call-json', pass,
      latencyMs: Date.now() - started,
      promptTokens: r.prompt_eval_count ?? 0,
      completionTokens: r.eval_count ?? 0,
      output: content.slice(0, 300),
    };
  } catch (e) {
    return fail(model, 'tool-call-json', started, e);
  }
}

async function testRepetitionResistance(model: string): Promise<TestResult> {
  const started = Date.now();
  try {
    const r = await client.chat({
      model,
      messages: [{ role: 'user', content: 'List exactly 10 distinct debugging techniques for Node.js applications. Number them 1-10. Each must be unique.' }],
      stream: false,
    });
    const content = r.message?.content ?? '';
    // Count unique numbered items
    const lines = content.split('\n').filter(l => /^\d+[\.\)]\s/.test(l.trim()));
    const uniqueTexts = new Set(lines.map(l => l.replace(/^\d+[\.\)]\s*/, '').trim().toLowerCase()));
    const pass = uniqueTexts.size >= 7; // Allow some tolerance
    return {
      model, test: 'repetition-resistance', pass,
      latencyMs: Date.now() - started,
      promptTokens: r.prompt_eval_count ?? 0,
      completionTokens: r.eval_count ?? 0,
      output: `unique_items=${uniqueTexts.size} total_lines=${lines.length}\n${content.slice(0, 400)}`,
    };
  } catch (e) {
    return fail(model, 'repetition-resistance', started, e);
  }
}

async function testCodingSmoke(model: string): Promise<TestResult> {
  const started = Date.now();
  try {
    const r = await client.chat({
      model,
      messages: [{ role: 'user', content: 'Write a TypeScript function `clamp(value: number, min: number, max: number): number` that constrains a value to the [min, max] range. Include edge case handling.' }],
      stream: false,
    });
    const content = r.message?.content ?? '';
    const hasFunction = /function\s+clamp|const\s+clamp|clamp\s*=/.test(content);
    const hasMinMax = /Math\.min|Math\.max|<\s*min|>\s*max|<=|>=/.test(content);
    return {
      model, test: 'coding-smoke', pass: hasFunction && hasMinMax,
      latencyMs: Date.now() - started,
      promptTokens: r.prompt_eval_count ?? 0,
      completionTokens: r.eval_count ?? 0,
      output: content.slice(0, 500),
    };
  } catch (e) {
    return fail(model, 'coding-smoke', started, e);
  }
}

async function testNeedleRetrieval(model: string): Promise<TestResult> {
  const started = Date.now();
  // Build a haystack of 60 fake records with a needle buried at position 37
  const records = Array.from({ length: 60 }, (_, i) => {
    if (i === 37) return `Record #${i}: NEEDLE_VALUE=quantum_entanglement_key_42`;
    return `Record #${i}: status=active, metric=${Math.floor(Math.random() * 100)}`;
  });
  const prompt = `Find the record that contains NEEDLE_VALUE and return its value.\n\n${records.join('\n')}`;
  try {
    const r = await client.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });
    const content = r.message?.content ?? '';
    const pass = content.includes('quantum_entanglement_key_42');
    return {
      model, test: 'needle-retrieval', pass,
      latencyMs: Date.now() - started,
      promptTokens: r.prompt_eval_count ?? 0,
      completionTokens: r.eval_count ?? 0,
      output: content.slice(0, 300),
    };
  } catch (e) {
    return fail(model, 'needle-retrieval', started, e);
  }
}

function fail(model: string, test: string, started: number, e: unknown): TestResult {
  return {
    model, test, pass: false,
    latencyMs: Date.now() - started,
    promptTokens: 0, completionTokens: 0,
    output: '', error: String(e),
  };
}

// ── Runner ──────────────────────────────────────────────────────

const ALL_TESTS = [
  testBasicInference, testRouterJson, testToolCallJson,
  testRepetitionResistance, testCodingSmoke, testNeedleRetrieval,
];

async function discoverModels(): Promise<string[]> {
  const explicit = process.env.BENCH_MODELS;
  if (explicit) return explicit.split(',').map(s => s.trim()).filter(Boolean);

  const installed = await client.list();
  const available = new Set(installed.models.map(m => m.name.replace(/:latest$/, '')));
  return ALL_MODELS.filter(m => available.has(m));
}

async function main() {
  console.log(`\n🔬 MiniCPM5 Modelfile Benchmark`);
  console.log(`   Ollama: ${OLLAMA_HOST}`);
  console.log(`   Repeats: ${REPEATS}\n`);

  const models = await discoverModels();
  if (models.length === 0) {
    console.error('No models found. Run: bash supervisor/scripts/seed-models.sh');
    process.exit(1);
  }
  console.log(`   Models: ${models.join(', ')}\n`);

  const results: TestResult[] = [];

  for (const model of models) {
    console.log(`\n── ${model} ──`);
    for (const testFn of ALL_TESTS) {
      for (let rep = 0; rep < REPEATS; rep++) {
        const r = await testFn(model);
        results.push(r);
        const icon = r.pass ? '✅' : '❌';
        const repLabel = REPEATS > 1 ? ` [${rep + 1}/${REPEATS}]` : '';
        console.log(`  ${icon} ${r.test}${repLabel}  ${r.latencyMs}ms  ${r.promptTokens}+${r.completionTokens} tok`);
        if (r.error) console.log(`     ⚠ ${r.error}`);
      }
    }
  }

  // Write report
  const report: BenchReport = {
    timestamp: new Date().toISOString(),
    ollamaHost: OLLAMA_HOST,
    repeats: REPEATS,
    results,
  };
  mkdirSync('results', { recursive: true });
  const filename = `results/bench-${Date.now()}.json`;
  writeFileSync(filename, JSON.stringify(report, null, 2));
  console.log(`\n📊 Report written to ${filename}`);

  // Summary table
  console.log('\n── Summary ──');
  const byModel = new Map<string, TestResult[]>();
  for (const r of results) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  console.log(padRight('Model', 30) + padRight('Pass', 8) + padRight('Fail', 8) + padRight('Avg ms', 10) + 'Avg tok');
  for (const [model, rs] of byModel) {
    const passed = rs.filter(r => r.pass).length;
    const failed = rs.length - passed;
    const avgMs = Math.round(rs.reduce((s, r) => s + r.latencyMs, 0) / rs.length);
    const avgTok = Math.round(rs.reduce((s, r) => s + r.completionTokens, 0) / rs.length);
    console.log(padRight(model, 30) + padRight(String(passed), 8) + padRight(String(failed), 8) + padRight(String(avgMs), 10) + String(avgTok));
  }
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

main().catch(e => { console.error(e); process.exit(1); });
