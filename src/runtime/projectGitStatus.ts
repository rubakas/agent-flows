// `git status --porcelain` as the daemon runs it in the user's own project
// (gate material, dirty-workspace message after a failed write step).
//
// What is pinned, and why:
//  - `-c core.fsmonitor=false`: a repository's `core.fsmonitor` names a command
//    git runs on every index refresh. The daemon must not execute whatever the
//    checkout configures. It is only a performance cache, so turning it off
//    changes how fast status is, never what it says.
//  - GIT_OPTIONAL_LOCKS=0: a plain `git status` opportunistically rewrites the
//    index under `.git/index.lock`. That would make the daemon's read-only status
//    contend with the user's own git running at the same moment.
//  - GIT_NO_LAZY_FETCH=1 and GIT_TERMINAL_PROMPT=0: in a partial clone git would
//    fetch a missing object over the network (running the repository's own
//    `core.sshCommand`), and a credential prompt would hang with nobody to answer.
//  - a timeout, so a wedged git cannot block the daemon's event loop forever
//    (spawnSync blocks it).
//
// What is deliberately NOT disabled: `filter.*.clean`, textconv and the rest of
// the user's configuration. These calls run in the user's own project under the
// user's own config, and switching filters off would break setups such as Git
// LFS, where status needs the clean filter to know whether a file changed.
//
// The raw spawnSync result is returned so each caller keeps its own failure
// handling: a timeout surfaces as `result.error` with code ETIMEDOUT, exactly
// like a missing git binary.

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

/** Deadline for one status call; the env override lets a test exercise the timeout. */
function gitTimeoutMs(): number {
  const override = Number(process.env.AF_REVIEW_GIT_TIMEOUT_MS);
  return Number.isInteger(override) && override > 0 ? override : 120_000;
}

/** Runs `git status --porcelain` in `cwd`. Environment is built per call. */
export function projectGitStatus(cwd: string): SpawnSyncReturns<string> {
  return spawnSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    timeout: gitTimeoutMs(),
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}
