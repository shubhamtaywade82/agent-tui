#!/usr/bin/env bash
# Seed the four MiniCPM5 sub-agent models into the local Ollama daemon.
# Idempotent: skips models that already exist.
set -euo pipefail

OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELFILES_DIR="${SCRIPT_DIR}/../modelfiles"

echo "→ Using OLLAMA_HOST=${OLLAMA_HOST}"
echo "→ Modelfiles in ${MODELFILES_DIR}"

# 1. Make sure the base model is present locally
if ! ollama list 2>/dev/null | grep -q '^minicpm5:2b '; then
  echo "→ Pulling minicpm5:2b (this can take a few minutes the first time)…"
  ollama pull minicpm5:2b
fi

# 2. Create each specialised model from its Modelfile
for modelfile in router toolagent analyst summarizer; do
  model_name="minicpm5-${modelfile}"
  if ollama list 2>/dev/null | grep -q "^${model_name} "; then
    echo "✓ ${model_name} already exists — skipping"
  else
    echo "→ Creating ${model_name} from ${MODELFILES_DIR}/${modelfile}.Modelfile"
    ollama create "${model_name}" -f "${MODELFILES_DIR}/${modelfile}.Modelfile"
    echo "✓ Created ${model_name}"
  fi
done

echo
echo "All MiniCPM5 sub-agent models are ready."
ollama list
