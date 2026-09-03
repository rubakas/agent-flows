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

_node_major() { node --version 2>/dev/null | tr -d 'v' | cut -d. -f1; }

# ── 1. Node ≥ 22 ──────────────────────────────────────────────────────────────
step "Check Node.js ≥ 22"
_need_node=0
if ! command -v node &>/dev/null; then
  _need_node=1
elif [[ $(_node_major) -lt 22 ]]; then
  _need_node=1
fi
if [[ $_need_node == 1 ]]; then
  if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
    if [[ $DRY_RUN == 1 ]]; then
      echo "  + source $HOME/.nvm/nvm.sh"
      echo "  + nvm use"
    else
      # shellcheck source=/dev/null
      source "$HOME/.nvm/nvm.sh"
      nvm use
    fi
  fi
  if [[ $DRY_RUN == 0 ]]; then
    _still_bad=0
    if ! command -v node &>/dev/null; then _still_bad=1
    elif [[ $(_node_major) -lt 22 ]]; then _still_bad=1; fi
    if [[ $_still_bad == 1 ]]; then
      echo "ERROR: Node ≥ 22 required. Run: nvm install 22 && nvm use  (reads .nvmrc)" >&2
      exit 1
    fi
  fi
fi

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
step "pnpm run doctor"
run pnpm run doctor

# ── 6. Build ──────────────────────────────────────────────────────────────────
step "pnpm build"
run pnpm build

# DB schema is applied by makeDb() on first open (src/db/index.ts); no migration step needed
# ── 7. Done ───────────────────────────────────────────────────────────────────
step "Bootstrap complete — entry points: pnpm mcp  |  pnpm canon:check  |  pnpm bindings:claude  |  pnpm doctor"
