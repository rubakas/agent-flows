#!/usr/bin/env bash
# Put the project's pinned Node on PATH, or refuse.
#
# Sourced, not executed: it changes the PATH of the script that sources it.
# Callers must already be in the package root.
#
# The requirement is a major AND a floor (spec 048). better-sqlite3 is compiled
# for one Node ABI, so the major is a pin — a newer major is as unable to load
# the addon as an older one. Inside that major the floor is a security
# one: the ABI does not change between releases, so an unpatched release loads the
# addon fine and is still refused. Both come from .nvmrc, which holds the floor
# (MAJOR.MINOR.PATCH), so this file carries no copy of either.
#
# The four copies of this block that preceded it each ended in a silent `|| true`
# fallthrough, so a machine without nvm simply carried on under the wrong Node
# and died later inside a database call with ERR_DLOPEN_FAILED. A wrong Node is
# refused here, by name, with what to do about it. bootstrap.sh sources this too,
# so there is one shell implementation of the check, not two.

_floor="$(tr -d '[:space:]' < .nvmrc)"
_floor="${_floor#v}"

# .nvmrc must hold the floor as MAJOR.MINOR.PATCH. A legacy bare major ("24")
# would otherwise be read as a floor of 24.24.24 and pass, so it is refused.
_floor_ok=0
case "$_floor" in
  *[!0-9.]* | '' | .* | *. | *..*) ;;
  *.*.*.*) ;;
  *.*.*) _floor_ok=1 ;;
esac
if [ "$_floor_ok" != 1 ]; then
  echo "$(basename "$0"): .nvmrc must hold the Node security floor as MAJOR.MINOR.PATCH (e.g. 24.22.1), got \"$_floor\"." >&2
  unset _floor _floor_ok
  exit 1
fi
unset _floor_ok
_major="${_floor%%.*}"

# _node_satisfies VERSION FLOOR: same major, and (minor, patch) at or above the
# floor. Plain POSIX tests on integers, so "24.100.0" is above "24.22.1". Only a
# bare N.N.N satisfies: "24.22.1-rc.1" and "24.22" do not. A subshell function, so
# its working variables cannot leak into the sourcing script.
_node_satisfies() (
  v="${1#v}"
  case "$v" in *.*.*) ;; *) exit 1 ;; esac
  vMajor="${v%%.*}"
  rest="${v#*.}"
  vMinor="${rest%%.*}"
  vPatch="${rest#*.}"
  fMajor="${2%%.*}"
  rest="${2#*.}"
  fMinor="${rest%%.*}"
  fPatch="${rest#*.}"
  for n in "$vMajor" "$vMinor" "$vPatch" "$fMajor" "$fMinor" "$fPatch"; do
    case "$n" in '' | *[!0-9]*) exit 1 ;; esac
  done
  [ "$vMajor" -eq "$fMajor" ] || exit 1
  [ "$vMinor" -gt "$fMinor" ] && exit 0
  [ "$vMinor" -eq "$fMinor" ] && [ "$vPatch" -ge "$fPatch" ]
)

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
  unset _floor _major
  unset -f _node_satisfies _node_version
  exit 1
fi

# Nothing but PATH (and NVM_DIR, if it was needed) is left behind for the caller.
unset _floor _major
unset -f _node_satisfies _node_version
