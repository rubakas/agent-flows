#!/usr/bin/env bash
# Run the eval runner under the project's pinned Node.
# The version and the refusal both live in scripts/use-pinned-node.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/use-pinned-node.sh
. "$(dirname "$0")/use-pinned-node.sh"
exec ./node_modules/.bin/tsx src/evals/run.ts "$@"
