#!/usr/bin/env bash
# Launch the yoke MCP (Binding B) server under Node 22 regardless of the ambient
# node. better-sqlite3 is built for Node 22 (NODE_MODULE_VERSION 127); the host's
# default node is 20, which fails on an ABI mismatch. Force 22 here.
set -euo pipefail
cd "$(dirname "$0")/.."
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null 2>&1 || true
exec ./node_modules/.bin/tsx src/bindings/mastra/server.ts "$@"
