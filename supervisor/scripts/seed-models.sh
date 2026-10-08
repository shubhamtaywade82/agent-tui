#!/usr/bin/env bash
# Seed the four MiniCPM5 sub-agent models into the local Ollama daemon.
# Idempotent: skips models that already exist.
#
# Existence checks use `ollama show` rather than `ollama list | grep -q`,
# because `set -o pipefail` + an early-exiting grep turns a match into a
# spurious 141 and re-pulls an already-present base model.
set -euo pipefail

OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
export OLLAMA_HOST
BASE_MODEL="${BASE_MODEL:-openbmb/minicpm5-2b}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELFILES_DIR="${SCRIPT_DIR}/../modelfiles"

echo "→ Using OLLAMA_HOST=${OLLAMA_HOST}"
echo "→ Modelfiles in ${MODELFILES_DIR}"

# 1. Make sure the base model is present locally
if ! ollama show "${BASE_MODEL}" > /dev/null 2>&1; then
  echo "→ Pulling ${BASE_MODEL} (this can take a few minutes the first time)…"
  ollama pull "${BASE_MODEL}"
fi

# 2. Create each specialised model from its Modelfile
for modelfile in router toolagent analyst summarizer; do
  model_name="minicpm5-${modelfile}"
  if ollama show "${model_name}" > /dev/null 2>&1; then
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
