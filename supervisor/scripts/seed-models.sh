#!/usr/bin/env bash
# Seed all MiniCPM5 sub-agent models into the local Ollama daemon.
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
# Original 4 variants + 10 new benchmark variants
VARIANTS=(
  router toolagent analyst summarizer
  reasoning fast-router tool-agent tool-search
  coding-agent long-context recovery structured-output
  low-repetition cloud-escalation
)

for variant in "${VARIANTS[@]}"; do
  model_name="minicpm5-${variant}"
  if ollama show "${model_name}" > /dev/null 2>&1; then
    echo "✓ ${model_name} already exists — skipping"
  else
    modelfile="${MODELFILES_DIR}/${variant}.Modelfile"
    if [[ ! -f "${modelfile}" ]]; then
      echo "✗ ${modelfile} not found — skipping"
      continue
    fi
    echo "→ Creating ${model_name} from ${modelfile}"
    ollama create "${model_name}" -f "${modelfile}"
    echo "✓ Created ${model_name}"
  fi
done

echo
echo "All MiniCPM5 sub-agent models are ready."
ollama list
