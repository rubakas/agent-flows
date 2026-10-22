# 048. Node security floor

| Field        | Value                                             |
| ------------ | ------------------------------------------------- |
| Feature Name | Node requirement: major pin plus a security floor |
| Branch       | `fix/048-node-floor`                              |
| Status       | Implemented 2026-10-22 (branch unpushed)          |
| Created      | 2026-10-22                                        |

## Problem

Node's security release of 2026-10-21 fixes four High CVEs on the 22.x line, in 22.23.4
(https://nodejs.org/en/blog/vulnerability/october-2026-security-releases). agent-flows
declares `engines.node: "22.x"` and `.nvmrc: 22`, so every check in the repository accepts a
vulnerable 22.x and `nvm use` can land on one.

The major is an ABI pin: better-sqlite3 is built for `NODE_MODULE_VERSION` 127, which is
Node 22. 22.23.4 has the same ABI, so the floor costs no rebuild. Node 24 stays out: it is a
different ABI and fails to load the addon.

Today the requirement is parsed in four places that agree only by accident: `src/nodeVersion.ts`
(major only), `bin/agent-flows` (major only, plain JS), `scripts/use-pinned-node.sh` and
`bootstrap.sh` (major only, and bootstrap gates on `-lt 22`, so a wrong-major Node skips the
check). None of them can express a minimum inside a major.

## Decisions

**D1 — One accepted form.** `engines.node` must match `/^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/` (no leading zeros, as npm): one major
with a security floor inside it, e.g. `"^22.23.4"`. Rejected: `"22.x"`, `"22"`, `"^22"`,
`"22.17.1"`, `">=22"`, `">=22.23.4 <23"`, `"^22.23.4 || ^24.22.1"`, `""`, `"^022.23.4"`. A range that could
admit another major reintroduces the ambiguity spec 038 removed. Every parser (TypeScript and
the launcher) uses the same expression and the same error text:
`engines.node must be "^MAJOR.MINOR.PATCH" — one major with a security floor inside it (e.g. "^22.23.4") — got "<value>"`.

**D2 — Satisfaction.** A version satisfies the pin when its major equals the pin's major and
`(minor, patch)` is at or above the pin's, compared numerically. A `v` prefix is tolerated.
Only a bare `N.N.N` satisfies: `22.23.4-rc.1`, a nightly tag, `22.23` and `22.23.4.1` do not.
The same rule holds in all three implementations (TypeScript, launcher, shell).

**D3 — Values.** `package.json` `engines.node` becomes `"^22.23.4"`. `.nvmrc` becomes
`22.23.4` exactly, so `nvm use` cannot select a vulnerable 22.x. `.npmrc` `engine-strict`
stays: pnpm refuses an unsafe Node at install time.

**D4 — No literal major in messages.** The requirement reads "Node <major> at or above
<floor>" and the remedy "nvm install <major>", both derived from the pin. A test greps the
launcher and the shell scripts for a hardcoded `22`.

**D7 — Output hygiene.** The launcher prints only the bare `N.N.N` a probe reported (anything
else the binary printed is dropped), strips control characters from every environment-derived
path it echoes, and lists a binary reachable by two paths once (by realpath).

**D8 — The shell validates its own input.** `.nvmrc` must hold the floor as `[v]N.N.N`. A legacy
bare `22` used to read as a floor of 22.22.22 and pass; it is refused, naming `.nvmrc`. The helper
`_node_satisfies` is a subshell function and the script unsets `_node_version`, `_node_satisfies`
and its own variables on every path; only `PATH` (and `NVM_DIR`, when nvm was needed) is left to
the caller.

**D9 — The CLI entry fails closed.** `node dist/cli.js` does not pass through the launcher, so
`src/cli.ts` checks `nodeSatisfies(process.versions.node, requiredNodePin())` before routing any
verb and prints the same refusal wording. Verbs started directly (`node dist/serve/server.js`)
still bypass it.

**D10 — `bootstrap.sh --dry-run` now runs the Node check.** It used to only echo. A dry run that
reports it would fail is the intended behaviour; the check changes `PATH` in-process only.

**D5 — One shell implementation.** `scripts/use-pinned-node.sh` owns the shell check
(`_node_satisfies version floor`, pure POSIX integer arithmetic). `bootstrap.sh` sources it
instead of carrying a second copy.

**D6 — Launcher searches by satisfaction.** `bin/agent-flows` rejects a candidate whose
version does not satisfy the pin, remembers below-floor candidates separately so the refusal
can name them, and filters nvm entries by satisfaction, newest first. The search order is
unchanged.

## Functional Requirements

| ID   | Requirement                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1 | `src/nodeVersion.ts` exposes `parseNodePin`, `requiredNodePin`, `nodeSatisfies` and the message helpers; the old major-only functions are gone                      |
| FR-2 | `doctor` fails a Node below the floor, naming the floor, the running version and `nvm install <major>`                                                              |
| FR-3 | `bin/agent-flows` re-execs under, or refuses without, an interpreter that satisfies the pin; the refusal names the floor, rejected below-floor paths and the remedy |
| FR-4 | `scripts/use-pinned-node.sh` and `bootstrap.sh` refuse a Node below the floor or of another major, via one shared check                                             |
| FR-5 | `package.json`, `.nvmrc` and the README state the same requirement                                                                                                  |

## Acceptance

- A1. `parseNodePin` accepts only `^M.m.p`; every rejected form in D1 throws the D1 text.
- A2. `nodeSatisfies`: 22.23.4, 22.23.5, 22.24.0, v22.23.4 pass; 22.23.3, 22.14.0, 24.22.1, 21.9.0 fail.
- A3. The package's own `engines.node` parses with a floor of at least 22.23.4 and `.nvmrc` equals the floor exactly.
- A4. `doctor` is green at the floor and red one patch below it.
- A5. Launcher, hermetic: a below-floor 22.x on PATH is passed over for a satisfying nvm Node; 22.23.4 and 22.24.0 on PATH are each chosen; only below-floor candidates yields a non-zero exit naming the floor, `nvm install <major>` and the rejected path.
- A6. Shell, hermetic: floor and newer 22.x pass without calling nvm; below-floor calls `nvm use <major>` and passes if that yields a satisfying Node; refuses with the floor and `nvm install` otherwise; Node 24 is refused.
- A7. Every new test fails when its floor check is removed (see Verified).
- A8. No test is skipped for want of a below-floor interpreter; it fails with a message instead.

## Out of scope / Follow-ups

- Node 24 support (a different ABI: needs a better-sqlite3 rebuild and a pin decision).
- Historical documents under `docs/research` and `docs/decisions`.
- Publishing: the package is private; no release is cut here.
- `/opt/homebrew/bin/node` and `/usr/local/bin/node` cannot be isolated from the launcher
  test; where either exists, the launcher refusal test fails and says so
  (`requireHermeticMachine`). A machine with `/usr/local/bin/node` therefore fails the launcher
  tests; there is no CI today.
- The daemon record does not store the Node version it started under: a daemon started under an
  old Node keeps serving until it idle-exits.
- The plugin scripts (`capture.mjs`, `check.mjs`) run under the ambient `node` by design: they use
  no TLS or decompression, which is where the 2026-10-21 CVEs are.
- `engine-strict` is enforced only by the corepack-pinned pnpm; a global pnpm 12 ignored it in the
  audit.
- Verbs started directly (`node dist/serve/server.js`) skip both the launcher and the `cli.ts`
  check.

## Verified

Each row is a mutation applied to a copy of one file, the named test file run, and the file
restored. "Red" counts failing subtests.

| Mutation                                              | Red | Tests that went red (examples)                                                                                  |
| ----------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------- |
| launcher: top-level check ignores the floor           | 22  | every re-exec case, "passes over a below-floor node on PATH…", "chooses a PATH node at …", the refusals         |
| launcher: `qualify` ignores the floor                 | 5   | "passes over a below-floor node on PATH…", "refuses when every candidate is below the floor…", override refusal |
| launcher: loop marker ignored                         | 1   | "refuses instead of re-execing again once the loop marker is set"                                               |
| launcher: native verdict accepted                     | 2   | "the native-module probe decides…", "with nothing else, refuses and says the module could not be loaded"        |
| launcher: nvm sort ascending, and lexical descending  | 1+1 | "tries nvm releases newest first, numerically"                                                                  |
| launcher: PATH searched after nvm                     | 2   | "prefers PATH over nvm when both qualify", "passes over a below-floor node on PATH…"                            |
| launcher: `satisfies` ignores a suffix (prefix match) | 1   | "treats a pre-release of the floor as below it when it is the RUNNING node"                                     |
| launcher: probe keeps text after the version          | 1   | "a probe that prints an escape sequence after a version is not echoed"                                          |
| launcher: pin accepts leading zeros                   | 3   | "rejects ^022.23.4", "rejects ^22.023.4", "rejects ^22.23.04" (parity with the TypeScript parser)               |
| launcher: `clean()` is the identity                   | 1   | "a path with an escape sequence in it is printed without it"                                                    |
| launcher: no realpath dedupe                          | 1   | "lists a binary reachable by two paths once"                                                                    |
| shell: floor ignored                                  | 4   | the three below-floor refusals, bootstrap "refuses below the floor"                                             |
| shell: suffix stripped from the patch                 | 3   | "refuses a pre-release of the floor", "a nightly build", "a version with a fourth part"                         |
| shell: `.nvmrc` not validated                         | 7   | one per invalid `.nvmrc` ("22", "22.23", "lts/*", "garbage", "22.23.4.1", "22.x.4", "22..4")                    |
| shell: helpers and variables left behind              | 1   | "leaves none of its working variables or helpers in the sourcing shell"                                         |
| TypeScript: `nodeSatisfies` ignores the floor         | 3   | "22.23.3 -> false", "22.14.0 -> false", "compares numerically, not as text"                                     |
| TypeScript: `nodeSatisfies` prefix match              | 3   | "22.23.4-rc.1 -> false", "…-nightly… -> false", "22.23.4.1 -> false"                                            |
| TypeScript: pin accepts leading zeros                 | 1   | "refuses every other form, with the one error text"                                                             |
| doctor: major-only check                              | 1   | "one patch below the security floor → fail naming the floor and the remedy"                                     |
| `src/cli.ts`: entry check removed                     | 1   | "cli: the entry point enforces the floor itself"                                                                |
