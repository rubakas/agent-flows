#!/usr/bin/env bash
# Put the project's pinned Node on PATH, or refuse.
#
# Sourced, not executed: it changes the PATH of the script that sources it.
# Callers must already be in the package root.
#
# better-sqlite3 is compiled for one Node ABI, so this is a pin and not a floor —
# Node 24 is newer than the pin and equally unable to load the addon. The version
# is read from .nvmrc so this file carries no copy of it.
#
# The four copies of this block that preceded it each ended in a silent `|| true`
# fallthrough, so a machine without nvm simply carried on under the wrong Node
# and died later inside a database call with ERR_DLOPEN_FAILED. A wrong Node is
# refused here, by name, with what to do about it.

_pinned="$(tr -d '[:space:]' < .nvmrc)"

_node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$(_node_major)" != "$_pinned" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  command -v nvm >/dev/null 2>&1 && nvm use "$_pinned" >/dev/null 2>&1 || true
fi

if [ "$(_node_major)" != "$_pinned" ]; then
  echo "$(basename "$0"): needs Node $_pinned (this is $(node -v 2>/dev/null || echo 'no node'))." >&2
  echo "better-sqlite3 is built for one Node ABI; any other version fails inside the first query." >&2
  echo "Run: nvm install $_pinned && nvm use   (reads .nvmrc)" >&2
  exit 1
fi

unset _pinned
