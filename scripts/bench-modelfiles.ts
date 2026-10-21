import { writeFileSync, mkdirSync } from 'node:fs';
import { Ollama } from 'ollama';

export type TestStatus = 'PASS' | 'ASSERTION_FAIL' | 'INVALID_OUTPUT' | 'TIMEOUT' | 'TRANSPORT_ERROR';

export interface TestResult {
  model: string;
  test: string;
  status: TestStatus;
  latencyMs: number;
  tokensPerSec: number;
  promptTokens: number;
  completionTokens: number;
  loadDurationMs: number;
  output: string;
  error?: string;
}

interface TestDef {
  name: string;
  numPredict: number;
  timeoutMs: number;
  formatJson?: boolean;
  think?: boolean;
  getPrompt: () => string;
  evaluate: (content: string) => { status: TestStatus; detail?: string };
}

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const REPEATS = Number(process.env.BENCH_REPEATS ?? '1');

const ALL_MODELS = [
  'openbmb/minicpm5-2b', 'minicpm5-router', 'minicpm5-toolagent', 'minicpm5-analyst',
  'minicpm5-summarizer', 'minicpm5-reasoning', 'minicpm5-fast-router', 'minicpm5-tool-agent',
  'minicpm5-tool-search', 'minicpm5-coding-agent', 'minicpm5-long-context', 'minicpm5-recovery',
  'minicpm5-structured-output', 'minicpm5-low-repetition', 'minicpm5-cloud-escalation',
];

const TESTS: TestDef[] = [
  {
    name: 'basic-inference',
    numPredict: 256,
    timeoutMs: 30_000,
    getPrompt: () => 'What are three benefits of TypeScript over JavaScript? Be concise.',
    evaluate: (c) => ({ status: c.trim().length > 20 ? 'PASS' : 'ASSERTION_FAIL' }),
  },
  {
    name: 'router-json',
    numPredict: 128,
    timeoutMs: 15_000,
    formatJson: true,
    think: false,
    getPrompt: () =>
      'Classify user intent into: DATA_EXTRACTION, CODE_REVIEW, TOOL_EXECUTION, LOG_SUMMARIZATION, GENERAL_QUERY.\n' +
      'Query: Check the CI/CD pipeline status for the payments microservice.\n' +
      'Output JSON only: {"intent": "<CATEGORY>"}',
    evaluate: (c) => {
      try {
        const obj = JSON.parse(c);
        return { status: obj.intent === 'TOOL_EXECUTION' ? 'PASS' : 'ASSERTION_FAIL', detail: obj.intent };
      } catch {
        return { status: 'INVALID_OUTPUT' };
      }
    },
  },
  {
    name: 'tool-call-json',
    numPredict: 128,
    timeoutMs: 20_000,
    formatJson: true,
    think: false,
    getPrompt: () =>
      'Available tools:\n- get_pipeline_status: Check pipeline. Parameters: {"service": "string"}\n' +
      '- send_email: Send email. Parameters: {"to": "string"}\n' +
      'Request: Check pipeline status for checkout-service.\n' +
      'Output JSON only: {"tool": "<name>", "arguments": {...}}',
    evaluate: (c) => {
      try {
        const obj = JSON.parse(c);
        const ok = obj.tool === 'get_pipeline_status' && typeof obj.arguments?.service === 'string';
        return { status: ok ? 'PASS' : 'ASSERTION_FAIL' };
      } catch {
        return { status: 'INVALID_OUTPUT' };
      }
    },
  },
  {
    name: 'repetition-resistance',
    numPredict: 768,
    timeoutMs: 45_000,
    getPrompt: () => 'List exactly 10 distinct debugging techniques for Node.js applications. Number them 1-10. Each must be unique.',
    evaluate: (c) => {
      // Matches markdown headers (### 1.), bullets (- 1., - **1.**), or standard numbered lines (1.)
      const re = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:[-*]\s*)?(?:\*\*)?(\d{1,2})[\.\)]\s*(?:\*\*)?\s*([^\n]+)/g;
      const items: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(c)) !== null) {
        const text = m[2]?.replace(/[*_`]/g, '').trim().toLowerCase() ?? '';
        if (text.length > 3) items.push(text);
      }
      const unique = new Set(items);
      const pass = items.length >= 7 && (unique.size / items.length) >= 0.8;
      return { status: pass ? 'PASS' : 'ASSERTION_FAIL', detail: `items=${items.length} unique=${unique.size}` };
    },
  },
  {
    name: 'coding-smoke',
    numPredict: 512,
    timeoutMs: 35_000,
    getPrompt: () => 'Write a TypeScript function clamp(value: number, min: number, max: number): number that constrains a value to the [min, max] range. Include edge case handling.',
    evaluate: (c) => {
      const hasDef = /function\s+clamp|const\s+clamp|clamp\s*=/.test(c);
      const hasRange = /Math\.(min|max)|<=\s*min|>=\s*max|<\s*min|>\s*max/.test(c);
      return { status: hasDef && hasRange ? 'PASS' : 'ASSERTION_FAIL' };
    },
  },
  {
    name: 'needle-retrieval',
    numPredict: 128,
    timeoutMs: 25_000,
    think: false,
    getPrompt: () => {
      const rows = Array.from({ length: 60 }, (_, i) =>
        i === 37 ? `Record #${i}: NEEDLE_VALUE=quantum_entanglement_key_42` : `Record #${i}: status=active, metric=${i * 7}`
      );
      return `Find the record with NEEDLE_VALUE and return its value.\n\n${rows.join('\n')}`;
    },
    evaluate: (c) => ({
      status: c.includes('quantum_entanglement_key_42') ? 'PASS' : 'ASSERTION_FAIL',
    }),
  },
];

async function invokeWithBudget(
  client: Ollama,
  model: string,
  prompt: string,
  opts: { formatJson?: boolean; numPredict: number; timeoutMs: number; think?: boolean },
) {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.abort();
      reject(new Error(`TIMEOUT after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  });

  const chatPromise = client.chat({
    model,
    messages: [{ role: 'user', content: prompt }],
    format: opts.formatJson ? 'json' : undefined,
    options: { num_predict: opts.numPredict },
    think: opts.think ?? false,
    stream: false,
  });

  try {
    return await Promise.race([chatPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

async function runTest(client: Ollama, model: string, test: TestDef): Promise<TestResult> {
  const started = Date.now();
  try {
    const r = await invokeWithBudget(client, model, test.getPrompt(), {
      formatJson: test.formatJson,
      numPredict: test.numPredict,
      timeoutMs: test.timeoutMs,
      think: test.think,
    });
    const evalDurSec = (r.eval_duration ?? 0) / 1e9;
    const tokensPerSec = evalDurSec > 0 ? Math.round((r.eval_count ?? 0) / evalDurSec) : 0;
    const evalRes = test.evaluate((r.message?.content ?? '').trim());

    return {
      model,
      test: test.name,
      status: evalRes.status,
      latencyMs: Date.now() - started,
      tokensPerSec,
      promptTokens: r.prompt_eval_count ?? 0,
      completionTokens: r.eval_count ?? 0,
      loadDurationMs: Math.round((r.load_duration ?? 0) / 1e6),
      output: (r.message?.content ?? '').trim().slice(0, 300),
    };
  } catch (err: unknown) {
    return handleTestError(model, test.name, started, err);
  }
}

function handleTestError(model: string, testName: string, started: number, err: unknown): TestResult {
  const msg = String(err);
  const isTimeout = msg.includes('TIMEOUT');
  const isTransport = msg.includes('fetch failed') || msg.includes('ECONNREFUSED');
  const status: TestStatus = isTimeout ? 'TIMEOUT' : isTransport ? 'TRANSPORT_ERROR' : 'ASSERTION_FAIL';

  return {
    model,
    test: testName,
    status,
    latencyMs: Date.now() - started,
    tokensPerSec: 0,
    promptTokens: 0,
    completionTokens: 0,
    loadDurationMs: 0,
    output: '',
    error: msg,
  };
}

function calcPercentiles(values: number[]): { median: number; p95: number } {
  if (values.length === 0) return { median: 0, p95: 0 };
  const s = [...values].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)]!, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! };
}

async function warmUpModel(client: Ollama, model: string): Promise<void> {
  try {
    await client.chat({
      model,
      messages: [{ role: 'user', content: 'warmup ping' }],
      options: { num_predict: 2 },
    });
  } catch {
    // Non-fatal warmup failure
  }
}

async function discoverModels(client: Ollama): Promise<string[]> {
  const explicit = process.env.BENCH_MODELS;
  if (explicit) return explicit.split(',').map((s) => s.trim()).filter(Boolean);
  const installed = await client.list();
  const available = new Set(installed.models.map((m) => m.name.replace(/:latest$/, '')));
  return ALL_MODELS.filter((m) => available.has(m));
}

function printSummary(results: TestResult[]): void {
  const byModel = new Map<string, TestResult[]>();
  for (const r of results) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }

  console.log('\n── Performance Summary ──');
  console.log('Model'.padEnd(28) + 'Pass'.padEnd(8) + 'Fail'.padEnd(8) + 'Med ms'.padEnd(10) + 'P95 ms'.padEnd(10) + 'Tok/s');
  for (const [model, rs] of byModel) {
    const passed = rs.filter((r) => r.status === 'PASS').length;
    const failed = rs.length - passed;
    const latencies = rs.map((r) => r.latencyMs);
    const { median, p95 } = calcPercentiles(latencies);
    const speeds = rs.filter((r) => r.tokensPerSec > 0).map((r) => r.tokensPerSec);
    const avgSpeed = speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : 0;
    console.log(
      `${model.padEnd(28)}${String(passed).padEnd(8)}${String(failed).padEnd(8)}` +
      `${String(median).padEnd(10)}${String(p95).padEnd(10)}${avgSpeed}`
    );
  }
}

async function main() {
  const client = new Ollama({ host: OLLAMA_HOST });
  const models = await discoverModels(client);
  if (models.length === 0) {
    console.error('No models found. Run: bash supervisor/scripts/seed-models.sh');
    process.exit(1);
  }

  console.log(`\n🔬 MiniCPM5 Modelfile Benchmark (Ollama: ${OLLAMA_HOST}, Repeats: ${REPEATS})`);
  const results: TestResult[] = [];

  for (const model of models) {
    console.log(`\n── Warming up: ${model} ──`);
    await warmUpModel(client, model);

    for (const test of TESTS) {
      for (let rep = 0; rep < REPEATS; rep++) {
        const r = await runTest(client, model, test);
        results.push(r);
        const icon = r.status === 'PASS' ? '✅' : '❌';
        console.log(`  ${icon} ${r.test} [${r.status}] ${r.latencyMs}ms (${r.tokensPerSec} tok/s)`);
      }
    }
  }

  mkdirSync('results', { recursive: true });
  const filename = `results/bench-${Date.now()}.json`;
  writeFileSync(filename, JSON.stringify({ timestamp: new Date().toISOString(), ollamaHost: OLLAMA_HOST, repeats: REPEATS, results }, null, 2));
  console.log(`\n📊 Report written to ${filename}`);
  printSummary(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
