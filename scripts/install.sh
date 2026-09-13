#!/usr/bin/env bash
# Run the workflow installer under Node 22 regardless of the ambient node.
# better-sqlite3 is built for Node 22 (NODE_MODULE_VERSION 127); the harness's
# default node is 20, which fails with an ABI mismatch. Force 22 here.
set -euo pipefail
# Capture the launch directory before cd changes it; the installer writes canon
# into this directory and reports the matching state dir (spec 032 FR-013).
AGENT_FLOWS_PROJECT_DIR="${AGENT_FLOWS_PROJECT_DIR:-$PWD}"
export AGENT_FLOWS_PROJECT_DIR
cd "$(dirname "$0")/.."
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null 2>&1 || true
exec ./node_modules/.bin/tsx src/install/run.ts "$@"
