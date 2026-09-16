// The MCP server's `instructions` block (spec 038 D7, FR-010).
//
// A leaf module holding the text as constants so the size and shape bounds can
// be asserted against the real strings without starting a server — importing
// server.ts would call MCPServer.startStdio().
//
// The bounds are the harnesses' own: Claude Code truncates instructions past
// 2048 bytes, and Codex surfaces roughly the first 512 bytes when deciding
// whether a server is worth calling — so the first sentence has to carry the
// entry point on its own.

import { resolveCanonDir } from "./pipelineLoader.js";

/**
 * The full block, sent once a project has workflows of its own. Prose aimed at a
 * model deciding whether this server is relevant to the user's request, not a
 * manual: the tool schemas already describe the arguments.
 */
export const FULL_INSTRUCTIONS = `agent-flows runs multi-step engineering workflows over the user's own repository. Call decide_entry_point first with the user's request: it names the pipeline to run and why, so you never have to guess one. Use list_pipelines to see what this project offers.

A pipeline is a durable, long-running sequence of steps — investigation, drafting, code changes, checks and review of the results — each executed by a model or by a shell command in the user's own project directory rather than in this conversation. Runs are not chat turns: they persist on disk, survive a restart of this session, and are resumed by id rather than replayed. run_pipeline starts one and returns when it reaches a terminal state or a gate; get_run reports the current status and per-step progress of any run by id; cancel_run stops one that should not continue.

Pipelines stop at approval gates and ask the human to decide. When a run comes back awaiting_approval, show the gate message and the proposed output to the user, and call approve only with their answer — never on their behalf. Rejecting a gate ends the run.

Prefer these tools over doing the same work turn by turn in chat whenever the user asks for something a pipeline already covers: the run is reproducible, its artifacts are written to disk, and its steps are visible to the user while it runs.`;

/**
 * The short pointer, sent while the project has nothing beyond the bundled
 * layer — which is most projects, most of the time. It costs a few hundred
 * bytes of context instead of two kilobytes and still names the entry point, so
 * a model that needs the detail can get it from list_pipelines.
 */
export const SHORT_INSTRUCTIONS = `agent-flows runs multi-step engineering workflows over the user's own repository. Call decide_entry_point first with the user's request to find the right pipeline, or list_pipelines to see what is available. Runs are durable, resumable by id, and stop at gates where the human approves.`;

/**
 * Pick the scope for a project (D7).
 *
 * D13 (Ship 3) replaces the condition below with the merged-layer view — "has
 * anything beyond the bundled layer been added" — once layers exist. Until then
 * `resolveCanonDir`'s project/bundled flip answers the same question with what
 * is available today, and this one line is the whole seam.
 */
export function instructionsFor(projectDir: string): string {
  // D13 SEAM: replace with the merged view's "anything beyond bundled?" check.
  const customized = resolveCanonDir(projectDir).source === "project";
  return customized ? FULL_INSTRUCTIONS : SHORT_INSTRUCTIONS;
}
