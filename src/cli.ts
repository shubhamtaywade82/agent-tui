/**
 * Headless CLI — full non-interactive agent interface for scripting, piping,
 * batch processing, and automation. Supports:
 *
 *   agent-tui run "prompt"            one-shot prompt, streamed to stdout
 *   echo "prompt" | agent-tui run     read prompt from stdin
 *   agent-tui run "prompt" --json     emit structured JSON result
 *   agent-tui run "prompt" --no-tools text-only, no tool calling
 *   agent-tui repl                     interactive REPL
 *   agent-tui batch prompts.txt        run each line as a separate prompt
 *   agent-tui sessions list             list saved sessions
 *   agent-tui sessions show <id>       print a session transcript
 *   agent-tui tools list               list all available tools
 *   agent-tui models                    list available models
 *
 * Flags: --provider/-p, --model/-m, --max-iter, --no-stream, --no-tools,
 *        --no-thinking, --session/-s, --save, --json, --quiet/-q
 */
import { runAgent, shutdownAgent, type AgentRunOptions } from './agent.js';
import { getProviderAsync } from './providers.js';
import { getToolRegistry } from './toolbox/index.js';
import { listSessions, loadSession, exportSessionMarkdown, saveSession } from './session.js';
import { loadConfig } from './config.js';
import { initLogger, log } from './logger.js';

const HELP = `
Agentic TUI — Headless CLI
==========================

USAGE:
  agent-tui <command> [options]

COMMANDS:
  run <prompt>          Run a one-shot prompt (streamed to stdout).
  repl                   Start an interactive REPL session.
  batch <file>           Run each line of a file as a separate prompt.
  sessions list          List all saved conversation sessions.
  sessions show <id>     Print a session transcript to stdout.
  sessions export <id>   Export a session to Markdown.
  tools list             List all available tools.
  tools describe <name>   Show a tool's parameter schema.
  models                 List available models from the active provider.
  doctor                 Diagnose provider/tool/MCP health.
  serve [port]           Start the HTTP API server (default 8787).

OPTIONS (apply to run/repl/batch):
  -p, --provider <name>   Provider: ollama | openai | anthropic | zai
  -m, --model <name>      Override the model
  -p, --max-iter <n>      Max reasoning iterations (default 12)
      --no-stream         Disable streaming (wait for full response)
      --no-tools          Disable tool calling (text only)
      --no-thinking       Disable thinking/reasoning traces
  -s, --session <id>      Continue an existing session
      --save              Auto-save the session
      --json              Emit structured JSON result (for run/batch)
  -q, --quiet             Suppress logging to stderr

EXAMPLES:
  agent-tui run "Explain the architecture of this project"
  cat error.log | agent-tui run "diagnose this error" --json
  agent-tui run "draw a cat" -p zai --json
  agent-tui batch questions.txt --json > answers.json
  agent-tui repl -p ollama -m qwen3:8b
  agent-tui sessions list
  agent-tui tools list
`;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: {
    provider?: string;
    model?: string;
    maxIter?: number;
    noStream?: boolean;
    noTools?: boolean;
    noThinking?: boolean;
    session?: string;
    save?: boolean;
    json?: boolean;
    quiet?: boolean;
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs['flags'] = {};
  const positional: string[] = [];
  const command = argv[0] ?? 'help';
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '-p': case '--provider': flags.provider = argv[++i]; break;
      case '-m': case '--model': flags.model = argv[++i]; break;
      case '--max-iter': flags.maxIter = Number(argv[++i]); break;
      case '--no-stream': flags.noStream = true; break;
      case '--no-tools': flags.noTools = true; break;
      case '--no-thinking': flags.noThinking = true; break;
      case '-s': case '--session': flags.session = argv[++i]; break;
      case '--save': flags.save = true; break;
      case '--json': flags.json = true; break;
      case '-q': case '--quiet': flags.quiet = true; break;
      default: positional.push(a);
    }
  }
  return { command, positional, flags };
}

function optsFromFlags(f: ParsedArgs['flags']): AgentRunOptions {
  return {
    provider: f.provider,
    model: f.model,
    maxIterations: f.maxIter,
    noStream: f.noStream,
    noTools: f.noTools,
    noThinking: f.noThinking,
    sessionId: f.session,
  };
}

/** Read all of stdin as a string. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function cmdRun(positional: string[], flags: ParsedArgs['flags']): Promise<number> {
  let prompt = positional.join(' ').trim();
  if (!prompt && !process.stdin.isTTY) prompt = await readStdin();
  if (!prompt) { console.error('Error: no prompt provided. Usage: agent-tui run "your prompt"'); return 1; }

  const opts = optsFromFlags(flags);
  const result = await runAgent(prompt, [], opts);

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      content: result.content,
      thinking: result.thinking,
      toolCalls: result.toolCalls.map((tc) => tc.function.name),
      iterations: result.iterations,
      metrics: result.metrics,
      sessionId: result.sessionId,
    }, null, 2) + '\n');
  } else {
    if (result.thinking && !flags.quiet) {
      process.stderr.write('\x1b[90m--- thinking ---\x1b[0m\n');
      process.stderr.write('\x1b[90m' + result.thinking + '\x1b[0m\n');
    }
    process.stdout.write(result.content + '\n');
  }
  return 0;
}

async function cmdBatch(positional: string[], flags: ParsedArgs['flags']): Promise<number> {
  const file = positional[0];
  if (!file) { console.error('Usage: agent-tui batch <file>'); return 1; }
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const results: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!flags.quiet) process.stderr.write(`[${i + 1}/${lines.length}] ${lines[i]!.slice(0, 60)}...\n`);
    const r = await runAgent(lines[i]!, [], optsFromFlags(flags));
    if (flags.json) {
      results.push({ prompt: lines[i], content: r.content, toolCalls: r.toolCalls.map((tc) => tc.function.name) });
    } else {
      process.stdout.write(`=== Prompt: ${lines[i]} ===\n${r.content}\n\n`);
    }
  }
  if (flags.json) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  return 0;
}

async function cmdRepl(flags: ParsedArgs['flags']): Promise<number> {
  const { createInterface } = await import('node:readline');
  const cfg = loadConfig();
  const provider = await getProviderAsync();
  process.stderr.write(`\x1b[36mAgentic TUI REPL\x1b[0m — provider=${provider.name} model=${flags.model ?? cfg.provider[cfg.provider.active].defaultModel}\n`);
  process.stderr.write(`Type /help for commands, /exit to quit.\n\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\x1b[32m❯ \x1b[0m' });
  let history: any[] = [];
  let sessionId = flags.session;

  return new Promise((resolve) => {
    rl.prompt();
    rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) { rl.prompt(); return; }
      if (input === '/exit' || input === '/quit') { rl.close(); resolve(0); return; }
      if (input === '/help') {
        process.stdout.write('Commands: /clear /sessions /tools /models /save /exit\n');
        rl.prompt(); return;
      }
      if (input === '/clear') { history = []; process.stderr.write('(history cleared)\n'); rl.prompt(); return; }
      if (input === '/sessions') { listSessions().forEach((s) => process.stdout.write(`  ${s.id}  ${s.title}  (${s.messageCount} msgs)\n`)); rl.prompt(); return; }
      if (input.startsWith('/session ')) { sessionId = input.slice(9).trim(); const s = loadSession(sessionId); if (s) { history = s.messages; process.stderr.write(`Loaded session ${sessionId}\n`); } rl.prompt(); return; }
      try {
        const result = await runAgent(input, history, { ...optsFromFlags(flags), sessionId, onToken: (d) => process.stdout.write(d) });
        history = result.messages;
        sessionId = result.sessionId;
        process.stdout.write('\n');
        if (flags.save && sessionId) saveSession(history, { id: sessionId });
      } catch (e: any) { process.stderr.write(`\x1b[31mError: ${e.message}\x1b[0m\n`); }
      rl.prompt();
    });
    rl.on('close', () => resolve(0));
  });
}

async function cmdSessions(positional: string[]): Promise<number> {
  const sub = positional[0] ?? 'list';
  if (sub === 'list') {
    const sessions = listSessions();
    if (!sessions.length) { console.log('No saved sessions.'); return 0; }
    console.log('Saved sessions:\n');
    for (const s of sessions) {
      console.log(`  ${s.id}  ${new Date(s.updatedAt).toLocaleString()}  [${s.provider}/${s.model}]  ${s.messageCount} msgs  "${s.title}"`);
    }
    return 0;
  }
  if (sub === 'show' || sub === 'export') {
    const id = positional[1];
    if (!id) { console.error('Usage: agent-tui sessions show <id>'); return 1; }
    if (sub === 'export') { const p = exportSessionMarkdown(id); console.log(`Exported to ${p}`); return 0; }
    const s = loadSession(id);
    if (!s) { console.error(`Session ${id} not found`); return 1; }
    for (const m of s.messages) {
      console.log(`\n--- ${m.role.toUpperCase()} ---`);
      if (m.thinking) console.log(`[thinking] ${m.thinking.slice(0, 200)}...`);
      if (m.tool_calls?.length) console.log(`[tool_calls: ${m.tool_calls.map((tc) => tc.function.name).join(', ')}]`);
      console.log(m.content);
    }
    return 0;
  }
  console.error(`Unknown sessions subcommand: ${sub}`);
  return 1;
}

async function cmdTools(positional: string[]): Promise<number> {
  const reg = await getToolRegistry();
  const defs = reg.definitions() as any[];
  if (positional[0] === 'describe') {
    const name = positional[1];
    const d = defs.find((d) => (d.function?.name ?? d.name) === name);
    if (!d) { console.error(`Tool ${name} not found`); return 1; }
    console.log(JSON.stringify(d, null, 2));
    return 0;
  }
  console.log(`Available tools (${defs.length}):\n`);
  for (const d of defs) {
    const fn = d.function ?? d;
    console.log(`  ${String(fn.name).padEnd(24)} ${String(fn.description ?? '').slice(0, 70)}`);
  }
  return 0;
}

async function cmdModels(): Promise<number> {
  const provider = await getProviderAsync();
  const models = await provider.listModels();
  console.log(`Models (${provider.name}):\n`);
  for (const m of models) console.log(`  ${m}`);
  return 0;
}

async function cmdDoctor(): Promise<number> {
  const cfg = loadConfig();
  console.log('=== Agent TUI Doctor ===\n');
  console.log(`Active provider: ${cfg.provider.active}`);
  console.log(`Default model:   ${cfg.provider[cfg.provider.active].defaultModel}`);
  console.log(`Context budget:   ${cfg.contextBudget} tokens`);
  console.log(`Max iterations:   ${cfg.maxIterations}`);
  console.log(`Thinking:         ${cfg.thinking}`);
  console.log(`Log level:        ${cfg.logLevel}\n`);

  try {
    const provider = await getProviderAsync(cfg);
    console.log(`✓ Provider "${provider.name}" initialized`);
    const models = await provider.listModels();
    console.log(`✓ ${models.length} models available: ${models.slice(0, 5).join(', ')}${models.length > 5 ? '...' : ''}`);
  } catch (e: any) { console.log(`✗ Provider failed: ${e.message}`); }

  try {
    const reg = await getToolRegistry(cfg);
    const count = reg.definitions().length;
    console.log(`✓ Tool registry: ${count} tools`);
  } catch (e: any) { console.log(`✗ Tool registry failed: ${e.message}`); }
  return 0;
}

/** Main CLI entry — returns exit code. */
export async function runCli(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  initLogger(flags.quiet ? 'error' : undefined);
  log.debug('CLI invoked', { command, positional, flags });

  let exit = 0;
  try {
    switch (command) {
      case 'run': exit = await cmdRun(positional, flags); break;
      case 'repl': exit = await cmdRepl(flags); break;
      case 'batch': exit = await cmdBatch(positional, flags); break;
      case 'sessions': exit = await cmdSessions(positional); break;
      case 'tools': exit = await cmdTools(positional); break;
      case 'models': exit = await cmdModels(); break;
      case 'doctor': exit = await cmdDoctor(); break;
      case 'serve': {
        const { startServer } = await import('./server.js');
        const port = Number(positional[0] ?? 8787);
        await startServer(port);
        return 0; // server runs until killed
      }
      case 'help': case '--help': case '-h': case '': console.log(HELP); break;
      default: console.error(`Unknown command: ${command}\n${HELP}`); exit = 1;
    }
  } catch (e: any) {
    console.error(`\x1b[31mError: ${e.message}\x1b[0m`);
    log.error('CLI error', { error: e.message, stack: e.stack });
    exit = 1;
  } finally {
    if (command !== 'repl' && command !== 'serve') {
      await shutdownAgent().catch(() => {});
    }
  }
  return exit;
}

// When invoked directly, parse process.argv and exit with the code.
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
