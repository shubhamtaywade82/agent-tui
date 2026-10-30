# System One Co-Hosted Agent Harness

A deterministic 3-stage agent harness built on [`@nemesis-oss/ollama-sdk`](https://www.npmjs.com/package/@nemesis-oss/ollama-sdk). Co-hosts a small (<4B) **System 1** controller alongside a **System 2** reasoner, with System 1 routing, System 2 tool execution, and System 1 post-generation verification.

## Architecture

```
  User Prompt
      │
      ▼
┌─────────────────────────────────────────┐
│  STAGE 1 — System 1 Routing             │
│  client.decision.route()                 │
│  Confidence gate: ≥ 0.65                 │
│  Routes to: market_data | backtest |     │
│              direct_reply                │
└──────────┬──────────────────┬───────────┘
           │                  │
     gate fails /        gate passes +
     direct_reply        specialist route
           │                  │
           ▼                  ▼
┌──────────────────┐  ┌─────────────────────────────┐
│  Direct LLM      │  │  STAGE 2 — System 2 Agent   │
│  reply (chatText)│  │  Agent.run() with scoped     │
│  Bypass tools    │  │  ToolRegistry                │
│  Bypass verify   │  │  Multi-turn tool loop        │
└────────┬─────────┘  └──────────────┬──────────────┘
         │                           │
         ▼                           ▼
    Return answer           ┌────────────────────────┐
                          │  STAGE 3 — System 1     │
                          │  Verification           │
                          │  client.decision.verify()│
                          │  Gate: P ≥ 0.85          │
                          └──────────┬───────────────┘
                                     │
                               pass? │ fail?
                                ┌────┴────┐
                                ▼         ▼
                          Return answer  Throw
                                        VerificationGateError
```

## Quick Start

```bash
# 1. Pull models (pick any <4B for S1; S2 can be any size)
ollama pull tev1:0.8b
ollama pull qwen3:8b

# 2. Set env (optional — defaults work for local Ollama)
export SYSTEM_ONE_MODEL=tev1:0.8b
export SYSTEM_TWO_MODEL=qwen3:8b

# 3. Use the harness
```

```typescript
import {
  createHarnessClient,
  loadHarnessConfigFromEnv,
  createDomainRegistries,
  CoHostedAgentHarness,
} from './src/system-one-harness/index.js';

const config = loadHarnessConfigFromEnv();
const client = createHarnessClient(config);
const registries = createDomainRegistries();
const harness = new CoHostedAgentHarness(client, config, registries);

await harness.verifyCoHosting();   // confirm both models in VRAM
const result = await harness.runTurn('Fetch BTCUSDT 1m klines and summarize the trend.');
console.log(result.answer);
console.log(`Route: ${result.route}, verified: ${result.verified} (P=${result.verifyProbability})`);
```

## Model Catalog

### System 1 (<4B controller)

The harness auto-picks the first locally-available model from this catalog:

| Model | Params | Notes |
|---|---|---|
| `tev1:0.8b` | 0.8B | Designed for the `/v1/systemone` decision workload |
| `qwen2.5:1.5b` | 1.5B | Small, widely available, decent instruction following |
| `llama3.2:1b` | 1B | Very small, fast cold-start |
| `gemma2:2b` | 2B | Good quality at small size |
| `phi3.5:3.8b` | 3.8B | Stronger reasoning, closer to the 4B ceiling |

Pin a specific model: `SYSTEM_ONE_MODEL=qwen2.5:1.5b`

### System 2 (reasoner)

The harness accepts both large reasoners and small ones:

| Model | Params | Notes |
|---|---|---|
| `qwen3:8b` | 8B | Default — strong reasoning + tool calling |
| `deepseek-coder:6.7b` | 6.7B | Code-specialized |
| `glm-4.7:cloud` | cloud | Hosted (requires `OLLAMA_API_KEY`) |
| `tev1:4b` | 4B | Small-GPU fallback |
| `qwen2.5:3b` | 3B | Small-GPU fallback |
| `llama3.2:3b` | 3B | Small-GPU fallback |

Pin a specific model: `SYSTEM_TWO_MODEL=deepseek-coder:6.7b`

## Configuration

All fields are env-overridable via `loadHarnessConfigFromEnv()`:

| Env Var | Default | Description |
|---|---|---|
| `SYSTEM_ONE_MODEL` | auto-pick | Pin S1, skip catalog |
| `SYSTEM_TWO_MODEL` | auto-pick | Pin S2, skip catalog |
| `SYSTEM_ONE_CATALOG` | (see above) | Comma-separated S1 candidates |
| `SYSTEM_TWO_CATALOG` | (see above) | Comma-separated S2 candidates |
| `OLLAMA_HOST` | `http://localhost:11434` | Base URL |
| `OLLAMA_API_KEY` | — | Cloud API key (for `:cloud` models) |
| `OLLAMA_ENDPOINTS` | — | Comma-separated HA endpoints |
| `MIN_ROUTE_CONFIDENCE` | `0.65` | Below this → bypass to direct_reply |
| `MIN_VERIFY_PROBABILITY` | `0.85` | Below this → throw VerificationGateError |
| `KEEP_ALIVE` | `-1` | Seconds; `-1` = indefinite (pin in VRAM) |
| `CONTEXT_WINDOW` | `4096` | Token cap |
| `TEMPERATURE` | `0.2` | S2 sampling temperature |
| `MAX_ITERATIONS` | `10` | Agent loop cap |
| `MAX_TOOL_CALLS` | `20` | Total tool calls per run |

## Multi-Axis Tool Gate

Before executing a sensitive tool, evaluate alignment, injection risk, and blast radius in a single batched `/v1/systemone` call:

```typescript
import { evaluateToolCallGate } from './src/system-one-harness/index.js';

const result = await evaluateToolCallGate(
  client, 'tev1:0.8b',
  'Fetch BTCUSDT klines',
  'fetch_binance_klines',
  { symbol: 'BTCUSDT', interval: '1m', limit: 10 },
);
if (result.approved) {
  // proceed
} else if (result.requireHumanApproval) {
  // ask operator
} else {
  // reject — low alignment or injection detected
}
```

Thresholds (all overridable via `ToolGateOptions`):

| Threshold | Default | Effect |
|---|---|---|
| `injectionAbortThreshold` | `0.30` | Above this → hard abort (throws) |
| `alignmentRejectThreshold` | `0.80` | Below this → reject |
| `riskCeiling` | `1.5` | At or above → require human approval |

## MCP Bridge

Connect a remote MCP server and bridge its tools into a local `ToolRegistry`:

```typescript
import { attachMcpServer, rankToolsForPrompt } from './src/system-one-harness/index.js';

const registry = new ToolRegistry();
const { connection, bridge } = await attachMcpServer(registry, 'http://localhost:8080/mcp');

// Optionally triage which tools are relevant before running the Agent
const ranked = await rankToolsForPrompt(client, 'tev1:0.8b', 'fetch klines', registry.definitions());
console.log(ranked.map(r => `${r.tool.function.name}: ${r.score}`));

// Use the registry with an Agent, or hand it to CoHostedAgentHarness
await bridge.refresh(registry);   // pick up newly-published tools
await connection.close();
```

## Running Tests

```bash
# Unit tests (mock Ollama server — no GPU needed)
npx vitest run test/system-one-harness/unit/

# Integration tests (requires `ollama serve` + real models)
OLLAMA_INTEGRATION=1 ollama pull tev1:0.8b
OLLAMA_INTEGRATION=1 ollama pull qwen3:8b
OLLAMA_INTEGRATION=1 npx vitest run test/system-one-harness/integration/
```

## Further Reading

- [ADR 0001 — System One Decision Primitives](./adr/0001-system-one-decision-primitives.md)
- [Runbook](./runbook.md)
- [`@nemesis-oss/ollama-sdk` docs](https://github.com/shubhamtaywade82/ollama-sdk)
- [Ollama Decision capability](https://docs.ollama.com)
