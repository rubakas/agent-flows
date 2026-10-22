#!/usr/bin/env bash
# FR-008: Self-assembling bootstrap — installs deps, builds, and runs preflight checks.
# Usage: ./bootstrap.sh [--dry-run]
set -euo pipefail
cd "$(dirname "$0")"

DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    *)         echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

step() { echo "==> $1"; }

run() {
  if [[ $DRY_RUN == 1 ]]; then
    echo "  + $*"
  else
    "$@"
  fi
}

# ── 1. Node: the pinned major, at or above the security floor ────────────────
# The check lives in one place (scripts/use-pinned-node.sh, which reads .nvmrc);
# sourcing it either leaves the right Node on PATH or exits with the reason.
step "Check Node.js (pinned in .nvmrc)"
# shellcheck source=scripts/use-pinned-node.sh
. scripts/use-pinned-node.sh

# ── 2. pnpm ───────────────────────────────────────────────────────────────────
step "Check pnpm"
if ! command -v pnpm &>/dev/null; then
  run corepack enable pnpm
  if [[ $DRY_RUN == 0 ]] && ! command -v pnpm &>/dev/null; then
    echo "ERROR: pnpm not found after corepack. Fallback: npm i -g pnpm@10.15.0" >&2
    exit 1
  fi
fi

# ── 3. Install dependencies ───────────────────────────────────────────────────
step "pnpm install --frozen-lockfile"
run pnpm install --frozen-lockfile

# ── 4. Check better-sqlite3 native ABI ───────────────────────────────────────
step "Check better-sqlite3 native ABI"
if [[ $DRY_RUN == 1 ]]; then
  echo "  [check] node -e \"require('better-sqlite3')(':memory:')\""
  echo "  [if fails] pnpm rebuild better-sqlite3"
else
  if ! node -e "require('better-sqlite3')(':memory:')" 2>/dev/null; then
    step "Rebuild better-sqlite3 (ABI mismatch)"
    pnpm rebuild better-sqlite3
  fi
fi

# ── 5. Preflight doctor ───────────────────────────────────────────────────────
step "agent-flows doctor"
run pnpm run preflight

# ── 6. Build ──────────────────────────────────────────────────────────────────
step "pnpm build"
run pnpm build

# DB schema is applied by makeDb() on first open (src/db/index.ts); no migration step needed
# ── 7. Done ───────────────────────────────────────────────────────────────────
step "Bootstrap complete — entry points: agent-flows serve  |  agent-flows mcp  |  agent-flows doctor"
