#!/usr/bin/env bash
# scripts/boot-smoke.sh — headless boot smoke test for the agent-tui TUI.
# Runs the app under a pseudo-TTY (via `script`), captures raw output, and
# asserts the critical terminal-control sequences are emitted:
#   \x1b[?1049h            alternate screen entered (fullscreen)
#   \x1b[?1000h/1002h/1006h mouse tracking enabled (clicks/wheel)
#   header text             the frame actually painted
set -u
cd "$(dirname "$0")/.."

OUT=/tmp/agent-tui-boot.log
# OLLAMA_HOST points at a dead port so listModels fails fast (connection
# refused) and the full chat frame renders without a live Ollama server.
# Interaction test: at t=4s inject an SGR click (press+release) at column 35,
# row 1 — the "System" tab pill — and verify the System view mounts.
# At t=6s send Ctrl+C for a clean exit.
( sleep 4; printf '\x1b[<0;35;1M\x1b[<0;35;1m'; sleep 2; printf '\x03' ) | \
  OLLAMA_HOST=http://127.0.0.1:9 TERM=xterm-256color timeout 12 \
  script -qec "sh -c 'stty cols 120 rows 40 2>/dev/null; npm start'" "$OUT" >/dev/null 2>&1
EC=$?

echo "exit_code=$EC"
echo "--- control sequence checks ---"
python3 - "$OUT" <<'PY'
import sys, re
raw = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace')
checks = {
    'alt-screen-enter  (\\x1b[?1049h)': '\x1b[?1049h' in raw,
    'alt-screen-exit   (\\x1b[?1049l)': '\x1b[?1049l' in raw,
    'mouse-click-en    (?1000h)': '\x1b[?1000h' in raw,
    'mouse-drag-en     (?1002h)': '\x1b[?1002h' in raw,
    'mouse-sgr-en      (?1006h)': '\x1b[?1006h' in raw,
    'mouse-disable     (?1000l)': '\x1b[?1000l' in raw,
    'header painted    (Agentic TUI)': 'Agentic TUI' in raw,
    'tab click worked  (System view)': 'Ollama Node:' in raw,
    'wheel/scroll      (jump pill or hints)': 'Jump to latest' in raw or 'PgUp/PgDn Scroll' in raw,
}
failed = 0
for name, ok in checks.items():
    print(('  PASS  ' if ok else '  FAIL  ') + name)
    failed += 0 if ok else 1
# Show a small sample of the painted frame for eyeballing
plain = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', raw)
plain = re.sub(r'\x1b[>=][0-9]*', '', plain)
lines = [l for l in plain.splitlines() if l.strip()][:14]
print('--- first painted rows ---')
for l in lines:
    print('   |', l[:110])
sys.exit(1 if failed else 0)
PY
SMOKE=$?
echo "--- result: $([ $SMOKE -eq 0 ] && echo SMOKE_PASS || echo SMOKE_FAIL) ---"
exit $SMOKE
