#!/usr/bin/env bash
# Run the full test suite under the project's pinned Node.
# The version and the refusal both live in scripts/use-pinned-node.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/use-pinned-node.sh
. "$(dirname "$0")/use-pinned-node.sh"
if [ $# -gt 0 ]; then
  exec ./node_modules/.bin/tsx --test "$@"
else
  # shellcheck disable=SC2046
  exec ./node_modules/.bin/tsx --test $(find src -name '*.test.ts' | sort)
fi
