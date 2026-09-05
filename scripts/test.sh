#!/usr/bin/env bash
# Run the full test suite under Node 22 regardless of the ambient node.
# better-sqlite3 is built for Node 22 (NODE_MODULE_VERSION 127); the harness's
# default node is 20, which fails with an ABI mismatch. Force 22 here.
set -euo pipefail
cd "$(dirname "$0")/.."
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null 2>&1 || true
if [ $# -gt 0 ]; then
  exec ./node_modules/.bin/tsx --test "$@"
else
  # shellcheck disable=SC2046
  exec ./node_modules/.bin/tsx --test $(find src -name '*.test.ts' | sort)
fi
