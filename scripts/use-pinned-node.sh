#!/usr/bin/env bash
# Put the project's pinned Node on PATH, or refuse.
#
# Sourced, not executed: it changes the PATH of the script that sources it.
# Callers must already be in the package root.
#
# The requirement is a major AND a floor (spec 048). better-sqlite3 is compiled
# for one Node ABI, so the major is a pin — Node 24 is newer than the pin and
# equally unable to load the addon. Inside that major the floor is a security
# one: the ABI does not change between releases, so an unpatched 22.x loads the
# addon fine and is still refused. Both come from .nvmrc, which holds the floor
# (MAJOR.MINOR.PATCH), so this file carries no copy of either.
#
# The four copies of this block that preceded it each ended in a silent `|| true`
# fallthrough, so a machine without nvm simply carried on under the wrong Node
# and died later inside a database call with ERR_DLOPEN_FAILED. A wrong Node is
# refused here, by name, with what to do about it. bootstrap.sh sources this too,
# so there is one shell implementation of the check, not two.

_floor="$(tr -d '[:space:]' < .nvmrc)"
_major="${_floor%%.*}"

# _node_satisfies VERSION FLOOR: same major, and (minor, patch) at or above the
# floor. Plain POSIX tests on integers, so "22.100.0" is above "22.23.4".
_node_satisfies() {
  _ns_v="${1#v}"
  case "$_ns_v" in *.*.*) ;; *) return 1 ;; esac
  _ns_vMajor="${_ns_v%%.*}"
  _ns_rest="${_ns_v#*.}"
  _ns_vMinor="${_ns_rest%%.*}"
  _ns_vPatch="${_ns_rest#*.}"
  _ns_vPatch="${_ns_vPatch%%[!0-9]*}"
  _ns_fMajor="${2%%.*}"
  _ns_rest="${2#*.}"
  _ns_fMinor="${_ns_rest%%.*}"
  _ns_fPatch="${_ns_rest#*.}"
  case "$_ns_vMajor$_ns_vMinor$_ns_vPatch$_ns_fMajor$_ns_fMinor$_ns_fPatch" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$_ns_vMajor" -eq "$_ns_fMajor" ] || return 1
  [ "$_ns_vMinor" -gt "$_ns_fMinor" ] && return 0
  [ "$_ns_vMinor" -eq "$_ns_fMinor" ] && [ "$_ns_vPatch" -ge "$_ns_fPatch" ]
}

_node_version() { node -p 'process.versions.node' 2>/dev/null || echo 0; }

if ! _node_satisfies "$(_node_version)" "$_floor"; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  command -v nvm >/dev/null 2>&1 && nvm use "$_major" >/dev/null 2>&1 || true
fi

if ! _node_satisfies "$(_node_version)" "$_floor"; then
  echo "$(basename "$0"): needs Node $_major at or above $_floor, the security floor (this is $(node -v 2>/dev/null || echo 'no node'))." >&2
  echo "better-sqlite3 is built for one Node ABI; any other major fails inside the first query." >&2
  echo "Run: nvm install $_major && nvm use $_major" >&2
  exit 1
fi

unset _floor _major
