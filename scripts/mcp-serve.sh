#!/usr/bin/env bash
# Launch the agent-flows MCP (Binding B) server under the project's pinned Node. better-sqlite3 is built for the pinned Node major (see engines.node); the host's
# default node may be another major, which fails on an ABI mismatch. Force the pin here.
set -euo pipefail
# Capture the launch directory before cd changes it; the server uses this as the
# working directory for pipeline steps so they run against the operator's project.
AGENT_FLOWS_PROJECT_DIR="${AGENT_FLOWS_PROJECT_DIR:-$PWD}"
export AGENT_FLOWS_PROJECT_DIR
cd "$(dirname "$0")/.."
# shellcheck source=scripts/use-pinned-node.sh
. "$(dirname "$0")/use-pinned-node.sh"
exec ./node_modules/.bin/tsx src/bindings/mastra/server.ts "$@"
