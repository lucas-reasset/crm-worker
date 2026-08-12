#!/usr/bin/env bash
# PreToolUse hook for Write|Edit|MultiEdit — enforces test-first (SW-013).
#
# Blocks a write to src/**/*.ts when the mirror test of SW-005 does not exist yet. It covers
# CREATION and EDITION alike: TDD is not "the new file eventually gets a test", it is "the test
# exists and is red before the code exists". Editing a file that has no test is the same act as
# creating one — you are writing production code that no failing test asked for.
#
# It is the adopted sibling of the crm-backend hook (BE-077), minus the migration one: this repo has
# no migration, because the schema it writes into is born in crm-backend/modelo/ (BE-014). Copying
# that second hook would post a guard at a door that does not exist.
#
# The judgement is NOT reimplemented here. This script only extracts the path from the tool payload
# and delegates to scripts/check-espelho.mjs --arquivo, which is the same module `npm run
# espelho:check` runs. One rule, two callers — a bash copy of the exclusion list would drift from
# the .mjs one within a week.
#
# Exit codes:
#   0 — allow (not a src/ TypeScript file, or the mirror test exists, or the file is exempt)
#   2 — block; stderr goes back to Claude with the fix
#
# Docs: https://docs.claude.com/en/docs/claude-code/hooks

set -euo pipefail

INPUT_JSON="$(cat)"
export INPUT_JSON

# jq when available, python3 as the stock-macOS fallback. Same extraction shape the crm-backend
# hooks use, so the two stay diffable.
extract() {
  if command -v jq >/dev/null 2>&1; then
    jq -r "$1 // empty" <<<"$INPUT_JSON"
  else
    python3 -c '
import json, sys, os
data = json.loads(os.environ["INPUT_JSON"])
val = data
for part in sys.argv[1].lstrip(".").split("."):
    val = val.get(part, "") if isinstance(val, dict) else ""
print(val if isinstance(val, str) else "")
' "$1"
  fi
}

FILE_PATH="$(extract '.tool_input.file_path')"

# Only TypeScript under a save-worker/src/. Everything else — tests/, scripts/, helm/, the other
# repos of the workspace (each with its own gate) — is none of this hook's business, and exits
# before paying for node.
case "$FILE_PATH" in
  */save-worker/src/*.ts) ;;
  *) exit 0 ;;
esac

# Locate the repo from FILE_PATH, not from $0 or the cwd: this repo lives inside an umbrella
# workspace, so the session's cwd may be reasset-group/ and not save-worker/.
WORKER_ROOT="${FILE_PATH%%/src/*}"
GATE="$WORKER_ROOT/scripts/check-espelho.mjs"

# The gate must be reachable to judge. If it is not, say so instead of failing open on the one rule
# this hook exists to enforce.
if [ ! -f "$GATE" ]; then
  printf 'hook-precheck-tdd: gate não encontrado em %s.\n' "$GATE" >&2
  printf 'Não dá para verificar o espelho (SW-013) — confira o layout do repo.\n' >&2
  exit 2
fi

# `if`, não `node … || exit 2`: com set -e, uma lista que falha derruba o script — e um hook que
# morre falha ABERTO, deixando passar exatamente o que ele existe para barrar. O stderr do gate já é
# a mensagem para quem escreve; a tradução aqui é só do código de saída (1 → 2).
if node "$GATE" --arquivo "$FILE_PATH" >/dev/null; then
  exit 0
fi

exit 2
