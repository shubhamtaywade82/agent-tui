#!/usr/bin/env node
/**
 * Unified entry point — routes between three operating modes:
 *
 *   1. TUI  (default, no args) — interactive React/Ink terminal interface
 *   2. Headless CLI  — `run`, `repl`, `batch`, `sessions`, `tools`, `models`, `doctor`
 *   3. HTTP API server — `serve [port]`
 *
 * The dispatcher inspects process.argv[2]: if it matches a known CLI command,
 * the headless path runs; otherwise the TUI launches. This keeps the existing
 * `npm start` (TUI) behavior while adding `npx tsx src/index.ts run "..."` etc.
 */
import { runCli } from './cli.js';

const CLI_COMMANDS = new Set([
  'run', 'repl', 'batch', 'sessions', 'tools', 'models', 'doctor', 'serve', 'bootstrap',
  'help', '--help', '-h',
]);

async function main(): Promise<void> {
  const firstArg = process.argv[2];

  // Explicit TUI request, or no args at all (and stdin is a TTY) → launch the UI.
  if (!firstArg || firstArg === 'tui' || firstArg === '--tui') {
    if (!process.stdin.isTTY && !firstArg) {
      // stdin is piped but no command given → treat as `run` reading from stdin.
      const code = await runCli(['run']);
      process.exit(code);
    }
    // Defer to the TUI entry (src/index.tsx). We launch tsx on it directly.
    const { spawn } = await import('node:child_process');
    const child = spawn('npx', ['tsx', 'src/index.tsx', ...process.argv.slice(3)], {
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  if (CLI_COMMANDS.has(firstArg)) {
    const code = await runCli(process.argv.slice(2));
    process.exit(code);
    return;
  }

  // Unknown arg — if it looks like a prompt (a quoted string), treat as `run`.
  // Otherwise print help.
  if (firstArg && !firstArg.startsWith('-')) {
    const code = await runCli(['run', ...process.argv.slice(2)]);
    process.exit(code);
  } else {
    const code = await runCli(['help']);
    process.exit(code);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
