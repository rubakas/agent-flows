// Resolves the directory where pipeline steps execute — the user's project,
// not this tool's own checkout.
//
// NOTE: `cwd` controls where steps EXECUTE. It does NOT control where pipeline
// definitions are loaded from — those still come from this tool's own pipelines/
// directory. Distributing pipeline definitions into projects is separate,
// upcoming work. Do not conflate the two.

import { existsSync, statSync } from "node:fs";

/**
 * Returns the directory where workflow steps should execute.
 *
 * Prefers AGENT_FLOWS_PROJECT_DIR (set by the wrapper scripts before they cd
 * into the tool's checkout, or by an operator/launcher). Falls back to
 * process.cwd() when the variable is absent.
 *
 * Throws if the resolved directory does not exist, so a misconfiguration fails
 * loudly at startup rather than silently running steps in the wrong tree.
 */
export function resolveProjectDir(): string {
  const dir = process.env.AGENT_FLOWS_PROJECT_DIR ?? process.cwd();
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // statSync throws when the path does not exist
  }
  if (!existsSync(dir) || !isDir) {
    throw new Error(
      `AGENT_FLOWS_PROJECT_DIR is set to "${dir}" but that directory does not exist. ` +
        `Set it to an existing directory or unset it to use the launch directory.`
    );
  }
  return dir;
}
