#!/usr/bin/env bash
# Launch the agent-flows serve daemon under the project's pinned Node.
# The version and the refusal both live in scripts/use-pinned-node.sh.
set -euo pipefail
# Capture the launch directory before cd changes it; the server uses this as the
# working directory for pipeline steps so they run against the operator's project.
AGENT_FLOWS_PROJECT_DIR="${AGENT_FLOWS_PROJECT_DIR:-$PWD}"
export AGENT_FLOWS_PROJECT_DIR
cd "$(dirname "$0")/.."
# shellcheck source=scripts/use-pinned-node.sh
. "$(dirname "$0")/use-pinned-node.sh"
# Only pass --port when PORT was actually set: the flag outranks
# AGENT_FLOWS_PORT (spec 038 FR-012), so forcing it here would make
# `AGENT_FLOWS_PORT=7413 pnpm serve` silently listen on 7411 instead. With
# neither set, server.ts already defaults to 7411.
if [ -n "${PORT:-}" ]; then
  exec ./node_modules/.bin/tsx src/serve/server.ts --port "$PORT" "$@"
fi
exec ./node_modules/.bin/tsx src/serve/server.ts "$@"
