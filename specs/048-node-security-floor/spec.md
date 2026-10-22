# 048. Node security floor

| Field        | Value                                             |
| ------------ | ------------------------------------------------- |
| Feature Name | Node requirement: major pin plus a security floor |
| Branch       | `fix/048-node-floor`                              |
| Status       | In progress 2026-10-22                            |
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

**D1 — One accepted form.** `engines.node` must match `/^\^(\d+)\.(\d+)\.(\d+)$/`: one major
with a security floor inside it, e.g. `"^22.23.4"`. Rejected: `"22.x"`, `"22"`, `"^22"`,
`"22.17.1"`, `">=22"`, `">=22.23.4 <23"`, `"^22.23.4 || ^24.22.1"`, `""`. A range that could
admit another major reintroduces the ambiguity spec 038 removed. Every parser (TypeScript and
the launcher) uses the same expression and the same error text:
`engines.node must be "^MAJOR.MINOR.PATCH" — one major with a security floor inside it (e.g. "^22.23.4") — got "<value>"`.

**D2 — Satisfaction.** A version satisfies the pin when its major equals the pin's major and
`(minor, patch)` is at or above the pin's, compared numerically. A `v` prefix is tolerated.

**D3 — Values.** `package.json` `engines.node` becomes `"^22.23.4"`. `.nvmrc` becomes
`22.23.4` exactly, so `nvm use` cannot select a vulnerable 22.x. `.npmrc` `engine-strict`
stays: pnpm refuses an unsafe Node at install time.

**D4 — No literal major in messages.** The requirement reads "Node <major> at or above
<floor>" and the remedy "nvm install <major>", both derived from the pin. A test greps the
launcher and the shell scripts for a hardcoded `22`.

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
- A7. Every new test fails when its floor check is removed (neutering recorded in the hand-off).
- A8. No test is skipped for want of a below-floor interpreter; it fails with a message instead.

## Out of scope / Follow-ups

- Node 24 support (a different ABI: needs a better-sqlite3 rebuild and a pin decision).
- Historical documents under `docs/research` and `docs/decisions`.
- Publishing: the package is private; no release is cut here.
- `/opt/homebrew/bin/node` and `/usr/local/bin/node` cannot be isolated from the launcher
  test; where either exists, the launcher refusal test fails and says so.
