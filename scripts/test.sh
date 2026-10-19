#!/usr/bin/env bash
# Run the full test suite under the project's pinned Node.
# The version and the refusal both live in scripts/use-pinned-node.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/use-pinned-node.sh
. "$(dirname "$0")/use-pinned-node.sh"
# A hung test fails (named) after ten minutes instead of holding the run forever. Node
# applies the limit to each test FILE's whole run, so it is a ceiling, not a per-test budget.
TEST_TIMEOUT_MS=600000
if [ $# -gt 0 ]; then
  exec ./node_modules/.bin/tsx --test --test-timeout="$TEST_TIMEOUT_MS" "$@"
else
  # shellcheck disable=SC2046
  exec ./node_modules/.bin/tsx --test --test-timeout="$TEST_TIMEOUT_MS" $(find src -name '*.test.ts' | sort)
fi
