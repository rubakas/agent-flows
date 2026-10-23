# 050. Node 24 LTS as the one runtime

| Field        | Value                                                |
| ------------ | ---------------------------------------------------- |
| Feature Name | Retarget the Node pin and floor from 22.23.4 to 24.22.1 |
| Branch       | `fix/node-floor-review-verdict`                      |
| Status       | Implemented 2026-10-23 (branch unpushed)             |
| Created      | 2026-10-23                                           |

## Why

The owner wants one Node on the machine, and wants it to be the current LTS version number.
On 2026-10-23 `nvm version-remote --lts` resolves to 24.22.1 (LTS since 2025-10-28, maintenance
from 2026-10-20, end of life 2028-04-30). Node 26 becomes LTS on 2026-10-28 and is not chosen.
The project pinned Node 22 (spec 048), so a machine on the LTS had to keep a second Node just
for agent-flows.

## Decision

The mechanism of spec 048 is kept exactly; only its values move.

- `package.json` `engines.node` becomes `"^24.22.1"`. It is still the single source of truth:
  one major with a security floor inside it.
- `.nvmrc` becomes `24.22.1` exactly.
- `@types/node` moves to major 24 so the compiler describes the runtime in use.
- The parse and satisfaction rules (spec 048 D1, D2, D8) are unchanged: the accepted form is
  `^MAJOR.MINOR.PATCH`; a version satisfies when its major equals the pin's and
  `(minor, patch)` is at or above the pin's. 22.x is now a wrong major, as 24 was before.
- Prose that said Node 24 could not load the addon is rewritten: the principle is one ABI, so a
  different major, older or newer, cannot load it.

## Evidence

- better-sqlite3 11.10.0 (the current dependency) builds from source under Node 24.22.1 and
  `new Database(':memory:')` opens (ABI 137). No prebuilt binary for ABI 137 was used, so the
  build needs the Xcode command line tools. No dependency upgrade is needed.
- A global install made under Node 24 while the pin still said 22 installed with only an
  `EBADENGINE` warning, then refused to run under either Node: the addon was built for 137 and
  the launcher demanded 22.

## Acceptance

- A1. `engines.node` is `"^24.22.1"`, parses with `parseNodePin`, and `.nvmrc` equals the floor.
- A2. `nodeSatisfies` passes 24.22.1, 24.22.2, 24.23.0, v24.22.1; fails 24.22.0, 24.14.0,
  22.23.4 (the old pin, now the wrong major) and 26.12.1.
- A3. The cross-major range `"^22.23.4 || ^24.22.1"` is still rejected by both parsers.
- A4. `pnpm-lock.yaml` moves only `@types/node` (and its `undici-types`).
- A5. better-sqlite3 loads from the worktree under Node 24.22.1; typecheck and build are green.
- A6. The retargeted fixtures fail when the major comparison is removed, in `nodeSatisfies` and
  in the launcher's `satisfies()`.
- A7. No remaining prose says Node 24 is unsupported or names 22.23.4 as the requirement.

## Out of scope / Follow-ups

- (a) The launcher refusal advice "Run the command under the Node that installed the
  dependencies" is misleading when that Node is the one being refused.
- (b) Node 26 becomes LTS on 2026-10-28. Moving to it is the same two-line change
  (`engines.node`, `.nvmrc`) plus a reinstall.
- (c) better-sqlite3 v12 would bring prebuilt binaries for Node 24, so no compiler toolchain
  would be needed.

## Verified

(Filled in at the end of the work.)
