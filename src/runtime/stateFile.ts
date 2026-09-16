// Writing a file into a project's state directory.
//
// The state directory holds a project's daemon record and its visibility
// preference. Both are owner-only (0600) inside an owner-only directory (0700),
// and both have to create that directory: `resolveProjectState` is pure, so a
// project that has never run a daemon has no state directory yet.

import { mkdirSync, writeFileSync } from "node:fs";

/** Create `stateDir` if absent (0700) and write `contents` to `path` as 0600. */
export function writeStateFile(stateDir: string, path: string, contents: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
}
