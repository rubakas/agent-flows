#!/usr/bin/env bash
# Launch the agent-flows MCP (Binding B) server under the project's pinned Node. better-sqlite3 is built for Node 22 (NODE_MODULE_VERSION 127); the host's
# default node is 20, which fails on an ABI mismatch. Force 22 here.
set -euo pipefail
# Capture the launch directory before cd changes it; the server uses this as the
# working directory for pipeline steps so they run against the operator's project.
AGENT_FLOWS_PROJECT_DIR="${AGENT_FLOWS_PROJECT_DIR:-$PWD}"
export AGENT_FLOWS_PROJECT_DIR
cd "$(dirname "$0")/.."
# shellcheck source=scripts/use-pinned-node.sh
. "$(dirname "$0")/use-pinned-node.sh"
exec ./node_modules/.bin/tsx src/bindings/mastra/server.ts "$@"
