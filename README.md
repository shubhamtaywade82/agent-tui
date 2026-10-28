# Agentic TUI

A multi-mode AI agent for personal use — an interactive **terminal UI**, a fully scriptable **headless CLI**, and an **HTTP API server**, all powered by a unified multi-provider LLM layer (Ollama, OpenAI-compatible endpoints including Z.ai GLM, Anthropic) with MCP tools, RAG, and multimodal capabilities.

## What it does

Built on `@nemesis-oss/ollama-sdk` + the official `openai` SDK + Ink (React for terminals), this project gives you a single agent that can:

- **Reason & iterate** — think → call tools → observe → respond, across up to 12 iterations per run.
- **Talk to any LLM** — Ollama (local), OpenAI (GPT-4o), any OpenAI-compatible endpoint such as Z.ai (GLM-4.6), or Anthropic (Claude). Swap with one env var.
- **Use 45+ tools** — filesystem, git, web search, code execution, embeddings/RAG, image generation, vision, TTS/ASR, and MCP servers (memory, time, fetch, sequential-thinking, Binance).
- **Run three ways** — interactive TUI (`npm start`), headless CLI (`agent-tui run "..."`), or HTTP API (`agent-tui serve`).
- **Persist conversations** — sessions saved as JSON, resumable, exportable to Markdown.
- **Stay secure** — secrets live in `.env` (git-ignored); the GitHub token is injected at runtime and never persisted.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure secrets (copy template, fill in keys)
cp .env.example .env
#   edit .env — set AGENT_PROVIDER, OLLAMA_MODEL, and any API keys you have

# 3. (optional) Bootstrap the engineering skills pack — 93 curated skill guidelines
npx tsx src/index.ts bootstrap
#   Skills are auto-detected after bootstrap; no SKILLS_PATH env needed.

# 4. Launch the interactive TUI (default)
npm start

# 4. Or use the headless CLI
npx tsx src/index.ts run "Explain the architecture of this project"
npx tsx src/index.ts doctor        # check provider/tool health
npx tsx src/index.ts tools list    # list all 45+ tools
npx tsx src/index.ts serve 8787    # start the HTTP API server
```

## Three Operating Modes

### 1. Interactive TUI (`npm start` / `npm run tui`)
React + Ink terminal interface with streaming chat, thinking traces, tool-call inspection, model switching, slash commands, and a system status tab.

### 2. Headless CLI (`npx tsx src/index.ts <command>`)
For scripting, piping, batch processing, and automation:

```bash
# One-shot prompt (streamed to stdout)
agent-tui run "summarize this codebase"

# Pipe input
cat error.log | agent-tui run "diagnose this error" --json

# Interactive REPL
agent-tui repl -p ollama -m qwen3:8b

# Batch (one prompt per line)
agent-tui batch questions.txt --json > answers.json

# Session management
agent-tui sessions list
agent-tui sessions show s-xyz123

# Introspection
agent-tui tools list
agent-tui models
agent-tui doctor
```

**Flags:** `-p/--provider`, `-m/--model`, `--max-iter`, `--no-stream`, `--no-tools`, `--no-thinking`, `-s/--session`, `--save`, `--json`, `-q/--quiet`, `--auto` / `--yolo`

### Unattended mode (`--auto` / `--yolo`)

In the **TUI**, the agent normally pauses after a plan step or turn limit and asks **[Y] continue** or **[N] pause**. With auto mode enabled, it chains continuations automatically until:

- every task in `.agent/tasks.json` is completed or cancelled, or
- the current run finishes with no pending work, or
- the safety cap (`AGENT_AUTO_MAX_CHAINS`, default 50) is hit — then it falls back to the manual prompt.

```bash
npm start -- --auto
# or
AGENT_AUTO=1 npm start
npx tsx src/index.ts --auto    # launches TUI with auto mode
```

Headless `run` / `repl` with `--auto` sets `AGENT_AUTO` and bumps the default iteration budget unless you pass `--max-iter`.

### 3. HTTP API Server (`agent-tui serve [port]`)
Exposes the agent as REST + SSE for other apps:

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Provider/tool/MCP status |
| `/models` | GET | List available models |
| `/tools` | GET | List all registered tools |
| `/sessions` | GET | List saved sessions |
| `/sessions/:id` | GET | Fetch a session |
| `/chat` | POST | One-shot chat (JSON in, JSON out) |
| `/chat/stream` | POST | SSE streaming chat (token-by-token) |
| `/embed` | POST | Embed text into vectors |

Every request needs `Authorization: Bearer <token>`. The server binds to `127.0.0.1` by default. Set `AGENT_API_TOKEN` (at least 16 characters) to choose the token. If you leave it unset, a token is generated for each run and printed once to the terminal. To listen on another interface, set `AGENT_API_HOST` and also `AGENT_API_TOKEN`; the server refuses to start otherwise. Requests are operator requests: tools run without the TUI's approval prompt, so set `AGENT_TOOLS` to a narrower list on any deployment beyond your own machine.

```bash
curl -X POST localhost:8787/chat \
  -H "authorization: Bearer $AGENT_API_TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"what tools are available?"}'
```

## Multi-Provider LLM

Switch providers by setting `AGENT_PROVIDER` in `.env`:

| Provider | Env vars needed | Default model |
|---|---|---|
| `ollama` | `OLLAMA_HOST` (local), optional `OLLAMA_API_KEY` (cloud) | `qwen3:8b` |
| `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-20241022` |

**Z.ai (GLM) and other OpenAI-compatible endpoints:** use the `openai` provider with a different base URL. Z.ai’s chat endpoint is at the OpenAI-compatible route (`/chat/completions` under `https://api.z.ai/api/paas/v4`), so no vendor SDK is needed:

```bash
AGENT_PROVIDER=openai
OPENAI_API_KEY=your-zai-key
OPENAI_BASE_URL=https://api.z.ai/api/paas/v4
OPENAI_MODEL=glm-4.6
```

The base URL includes the API version path. A bare origin such as `https://api.openai.com` gets `/v1` appended. A base without a version segment, such as `https://gw.example/llm`, gets `/v1` appended after it. A query string such as `?api-version=...` is sent with every request. Credentials in the URL are rejected, so put the key in `OPENAI_API_KEY`.

**Migrating from the old `zai` provider:** `AGENT_PROVIDER=zai`, `ZAI_API_KEY`, `ZAI_BASE_URL`, and `ZAI_MODEL` were removed. Use `AGENT_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` as shown above. Starting with `AGENT_PROVIDER=zai` fails with these instructions. The image, speech, and transcription tools now call the OpenAI media API (configured with `OPENAI_MEDIA_*`). `read_web_page` is now `web_fetch`. `search_images` was removed because no standard API in this stack provides it.

**Media tools key:** `generate_image`, `analyze_image`, `text_to_speech`, `transcribe_audio`, and `edit_image` use `OPENAI_MEDIA_API_KEY` with `OPENAI_MEDIA_BASE_URL` (default `https://api.openai.com/v1`). They reuse `OPENAI_API_KEY` only when both chat and media use `api.openai.com`, so a Z.ai key in `OPENAI_API_KEY` is never sent to OpenAI. With Z.ai chat, set `OPENAI_MEDIA_API_KEY` to an OpenAI key to keep the media tools.

**Ollama local + cloud:** set `OLLAMA_API_KEY` (from [ollama.com](https://ollama.com)) and optionally `OLLAMA_CLOUD_URL=https://ollama.com`. The client registers **local** (`OLLAMA_HOST`) and **cloud** endpoints with failover (`local-first` or `cloud-first` via `AGENT_OLLAMA_ROUTING`). Pin cloud-only models with `OLLAMA_CLOUD_MODELS`. With `AGENT_OLLAMA_ROUTING=auto` and `OLLAMA_CLOUD_MODEL`, the agent escalates on **heavy prompts**, **mid-run** (after `AGENT_OLLAMA_ESCALATE_AFTER_TOOLS` / `AGENT_OLLAMA_ESCALATE_AFTER_ITER` tool rounds), or **loop-guard** repeats. Optional `OLLAMA_ROUTER_MODEL` + `AGENT_OLLAMA_ROUTER=hybrid` uses a tiny classifier for borderline tasks.

All providers implement a unified interface: `chat()`, `chatStream()`, `generate()`, `embed()`, `listModels()`. The agent loop and tools are provider-agnostic.

## Tool Suite (45+ tools)

### Local tools (20)
- **Calculator** — safe expression evaluator (+, -, *, /, %, **, sqrt, sin, cos, log)
- **Code execution** — `run_code` (JS/TS sandbox), `run_shell` (shell commands with deny-list)
- **Filesystem** — `read_files`, `write_file`, `list_tree`, `clone_repo`, `delete_path`
- **RAG / embeddings** — `index_document`, `semantic_search`, `list_vector_stores` (local vector store, no external DB)
- **Media (OpenAI API)** — `generate_image`, `analyze_image` (vision), `text_to_speech`, `transcribe_audio` (ASR), `edit_image`
- **Web (Ollama Cloud, needs `OLLAMA_API_KEY`)** — `web_search`, `web_fetch`
- **Skills** — `list_skills`, `read_skill` (ruby-agent-skills pack — 93 skills covering Ruby, Rails, TypeScript, React, OOP, Clean Code, testing, refactoring, architecture). Auto-detected from `.agent/skills/` after `agent-tui bootstrap`; agent loads relevant skills proactively before coding tasks.

### MCP servers (auto-discovered)
- Knowledge Graph Memory, Local Filesystem, Time & Timezones, Web Fetcher, Git Repository, Sequential Thinking, Binance Spot/Futures SDK

Control which tools load via `AGENT_TOOLS` and `AGENT_MCP` in `.env` (e.g. `AGENT_TOOLS=calculator,web_search,run_code` or `all`).

## Session Persistence

Conversations auto-save (when `--save` or `AUTOSAVE_SESSION=1`) to `.agent/sessions/`. Resume any session:

```bash
agent-tui run "continue our work" -s s-abc123
agent-tui sessions list
agent-tui sessions export s-abc123   # → Markdown transcript
```

## Security

- **`.env` is git-ignored** — copy `.env.example` and fill in your keys.
- **GitHub token** stays in `github-token.txt` (git-ignored) and is injected at runtime; never written to config files or logs (redacted in all log output).
- **Shell/code tools** have a deny-list blocking destructive commands (`rm -rf /`, `mkfs`, etc.).
- **`delete_path`** refuses to operate outside the working directory.

## Configuration

All behaviour is controlled via environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `AGENT_PROVIDER` | `ollama` | Active LLM provider |
| `AGENT_MAX_ITERATIONS` | `12` | Max reasoning iterations per run |
| `AGENT_CONTEXT_BUDGET` | `12000` | Token budget for context windowing |
| `AGENT_TEMPERATURE` | `0.7` | Sampling temperature |
| `AGENT_THINKING` | `true` | Enable reasoning traces |
| `AGENT_TOOLS` | `all` | Comma-separated tool names or `all` |
| `AGENT_MCP` | `all` | `all` / `none` / comma-separated MCP ids |
| `AGENT_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`/`silent` |
| `AGENT_LOG_FILE` | `.agent/logs/agent.log` | Structured JSON log file |

## Architecture

```
src/
├── index.ts           # Unified dispatcher (TUI / CLI / server)
├── index.tsx          # TUI entry (React + Ink)
├── cli.ts             # Headless CLI (run, repl, batch, sessions, tools, serve)
├── server.ts          # HTTP API server (REST + SSE)
├── agent.ts           # Core reasoning loop (think → tools → respond)
├── providers.ts       # Multi-provider LLM abstraction
├── config.ts          # Secure .env config & credential loading
├── session.ts         # Conversation persistence
├── logger.ts          # Structured logging & run metrics
├── tools.ts           # Original tools + MCP server management
├── toolbox/           # New tool suite
│   ├── index.ts       # Registry aggregator (local + MCP)
│   ├── media.ts       # OpenAI image gen/edit, vision, TTS, ASR
│   ├── media-ops.ts   # OpenAI media API calls (official SDK)
│   ├── web.ts         # Ollama Cloud web search and fetch
│   ├── code.ts        # Code execution & shell sandbox
│   ├── embeddings.ts  # RAG: index_document, semantic_search
│   └── files.ts       # Enhanced file ops & repo cloning
├── components/        # Ink UI components
├── hooks/             # useOllama, useAgent
├── utils/             # Context budgeting, truncation
└── theme.ts           # Dark/light themes
```

## Scripts

| Command | Description |
|---|---|
| `npm start` | Launch the interactive TUI |
| `npm run cli` | Run the headless CLI dispatcher |
| `npm run serve` | Start the HTTP API server (port 8787) |
| `npm run doctor` | Diagnose provider/tool/MCP health |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the unit suites: tasks, context guard, Ollama routing, OpenAI provider, media tools, web tools |
| `npm run build` | Compile TypeScript to `dist/` |

## Agentic Supervisor (orchestration layer)

A second entry point in this repo: a deterministic orchestration layer that
wraps **any LLM** — local MiniCPM5 / Llama / Qwen via Ollama or vLLM, or
hosted OpenAI GPT-4o / Anthropic Claude / Google Gemini — with a state
machine, durable goal→task chains, retrieval, memory, sandboxed execution,
per-task model selection, streaming, and cost budgets. Served on `:7480`
with OpenAPI docs at `/docs`.

**Local Ollama (default):**

```bash
npm install
bash supervisor/scripts/seed-models.sh              # create the MiniCPM5 sub-agent models (local only)
npm run supervisor:migrate                          # schema (needs Postgres + pgvector)
npm run supervisor:serve                            # API + OpenAPI docs at /docs
```

**Cloud (OpenAI / Anthropic / Gemini / any OpenAI-compatible endpoint) — no
local models, no seed script:**

```bash
bash supervisor/scripts/bootstrap-cloud.sh openai sk-...   # writes .env.supervisor.cloud
cat .env.supervisor.cloud >> .env
npm run supervisor:migrate
npm run supervisor:serve
```

> `DATABASE_URL` defaults to `localhost:5432`. If your Postgres isn't that one, or
> it has no `pgvector`, set it first (a line in `.env` is enough) — otherwise
> `migrate` fails with `extension "vector" is not available` while `serve` boots
> in a degraded "retriever init failed" state.

### Supervisor from the main CLI

The supervisor is also wired into the main `agent-tui` entry point:

```bash
agent-tui supervisor serve                 # start the supervisor (same as npm run supervisor:serve)
agent-tui supervisor health                # liveness + retrieval mode + cost caps
agent-tui supervisor runs list             # recent runs
agent-tui supervisor runs show <id>        # one run with final response + errors
agent-tui supervisor runs events <id>       # the run's event-sourcing trail
agent-tui supervisor goals list             # goal chains
agent-tui supervisor goals show <id>        # one goal's task chain
```

### Supervisor in the TUI

The TUI's fourth tab (**⚡ Supervisor**, key `4` or `Ctrl+T` to cycle) polls
the running supervisor's health, recent runs, and goal chains every 5s. When
the supervisor is down the tab shows a start hint instead of erroring — the
rest of the TUI is unaffected.

Full instructions, prerequisites, provider selection and troubleshooting:
[docs/supervisor/usage.md](docs/supervisor/usage.md).

## License

ISC
