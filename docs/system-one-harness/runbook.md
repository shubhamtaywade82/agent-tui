# System One Harness — Runbook

## Boot

### Local (single GPU)

```bash
# 1. Pull models
ollama pull tev1:0.8b     # System 1 (~1 GB VRAM)
ollama pull qwen3:8b      # System 2 (~5 GB VRAM)

# 2. Verify co-hosting fits VRAM
ollama ps                  # both should show as loaded after first turn

# 3. Run
node --import tsx -e "
import { loadHarnessConfigFromEnv, createHarnessClient, createDomainRegistries, CoHostedAgentHarness } from './src/system-one-harness/index.js';
const config = loadHarnessConfigFromEnv();
const client = createHarnessClient(config);
const harness = new CoHostedAgentHarness(client, config, createDomainRegistries());
const result = await harness.runTurn('Fetch BTCUSDT 1m klines and summarize.');
console.log(result);
"
```

### Cloud (no local GPU)

```bash
export OLLAMA_HOST=https://ollama.com
export OLLAMA_API_KEY=sk-your-key
export SYSTEM_ONE_MODEL=tev1:0.8b
export SYSTEM_TWO_MODEL=glm-4.7:cloud
```

### HA Failover (multiple endpoints)

```bash
export OLLAMA_ENDPOINTS=http://gpu-1:11434,http://gpu-2:11434
# The SDK's EndpointRegistry round-robins on failure.
```

## Health Checks

| Check | How | Expected |
|---|---|---|
| Daemon version | `curl $OLLAMA_HOST/api/version` | `>= 0.35.0` for `/v1/systemone`; `>= 0.40.4` for `tev1:0.8b` |
| Both models loaded | `harness.verifyCoHosting()` | `systemOneLoaded: true, systemTwoLoaded: true` |
| System One works | `curl -X POST $OLLAMA_HOST/v1/systemone -d '{"model":"tev1:0.8b","state":"1+1=2","questions":{"q":{"type":"noul","instructions":"Is the state true?"}}}'` | `{"answers":{"q":{"type":"noul","noul":0.96...}}}` |

`state` is the content the decision model judges; `instructions` is the question about that state. Putting the question in `instructions` while `state` is a dummy value (for example `"state":"test"`) makes `tev1:0.8b` score the dummy value and return a misleading ~0.35.

## Troubleshooting

### `NoModelAvailableError`

```
NoModel available.
Catalog tried (in order): tev1:0.8b, qwen2.5:1.5b, llama3.2:1b, gemma2:2b, phi3.5:3.8b
Locally available: (none — is ollama running?)
```

**Fix**: `ollama pull tev1:0.8b` (or any catalog model). The error message lists the exact commands.

### `OllamaIncompatibleModelError: Operation systemOne requires Ollama >= 0.35.0`

The local daemon is too old for `/v1/systemone`. Upgrade:

```bash
# macOS
brew upgrade ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh
```

### `VerificationGateError`

```
System 1 Verification Gate rejected answer (P=0.420 < threshold 0.85)
```

System 1 judged System 2's answer as probably-wrong. Either:
- Lower the threshold: `MIN_VERIFY_PROBABILITY=0.70` (less safe)
- Improve System 2's prompt or model
- Inspect the rejected answer (it's on `error.rejectedAnswer`)

### `Security Gate Abort: prompt-injection probability 0.45`

The tool gate detected prompt injection in the tool arguments. The call was aborted before execution. Check:
- Is the user prompt or tool arguments containing suspicious payloads?
- Is the injection threshold too strict? Raise `injectionAbortThreshold` (default 0.30)

### Co-hosting OOM

If both models don't fit in VRAM:
- Use a smaller S2 model: `SYSTEM_TWO_MODEL=tev1:4b` (both <4B, fits 8 GB)
- Reduce context: `CONTEXT_WINDOW=2048`
- Unload between turns: `KEEP_ALIVE=0` (trades latency for VRAM)

## Cost Guardrails (cloud deployments)

The harness doesn't impose its own cost caps — use the supervisor's cost tracker (ADR 0012) if you need them. For cloud-only runs:

```bash
export SYSTEM_ONE_MODEL=tev1:0.8b      # cheap routing
export SYSTEM_TWO_MODEL=glm-4.7:cloud  # pay-per-token reasoning
# Monitor via: curl -H "Authorization: Bearer $OLLAMA_API_KEY" https://ollama.com/api/usage
```
