export interface Finding {
  text: string;
  severity?: "low" | "medium" | "high" | "critical";
  blocking?: boolean;
}

export interface HardenedSpec {
  title: string;
  description: string;
  requirements?: string[];
  acceptanceCriteria?: string[];
  weaknesses?: Finding[];
  securityFindings?: Finding[];
}

export type StepKind =
  | "llm"
  | "gate"
  | "assemble-spec"
  | "persist-ticket"
  | "export-spec"
  | "pipeline"
  | "loop"
  | "check";

export type Role = "reasoner" | "worker" | "scout";

export interface StepDef {
  id: string;
  kind: StepKind;
  role?: Role;
  model?: string;
  prompt?: string;
  schema?: "weaknesses" | "securityFindings";
  dependsOn?: readonly string[];
  message?: string;
  /**
   * Named Agent Skills this step may invoke. The field name `skills` is adopted from
   * Anthropic's documented Agent Skills spec, not invented here. Only allowed on `llm`
   * steps; the runtime resolves names to installed skills via `--plugin-dir`. Must be a
   * non-empty array of non-blank strings. The canon does not validate that a named skill
   * is installed — that is a runtime concern.
   */
  skills?: string[];
  /**
   * Per-step deadline in milliseconds. Overrides the pipeline's `defaultTimeoutMs` and
   * the built-in default. Set to `0` to disable the deadline for this step — useful for
   * long-running steps that must not be killed mid-thought. `null` is not accepted; use `0`.
   */
  timeoutMs?: number;
  /**
   * Declares repository access for the step's agent, following the GitHub Actions
   * `permissions:` convention. Only the `contents` scope is supported.
   *
   * - `contents: "read"`: read-only file access (Read and Glob tools only).
   * - `contents: "write"`: read + edit access (Edit and Write tools added);
   *   Bash/shell is never granted — that is the separate concern of kind: "check".
   * - `contents: "none"` or absent `permissions`: no repo access (default, fully
   *   backward compatible). Not supported for api transport.
   *
   * The optional `allow` and `deny` fields (key names adopted from Claude Code's
   * own `permissions.allow`/`permissions.deny` settings format, not invented here)
   * give per-step control over the project-wide credential and build-config deny
   * set that the runtime applies whenever `contents` is set:
   *
   *   effective deny = (project defaults ∪ step.deny) − step.allow
   *
   * Both fields accept plain path globs — NOT vendor rule strings like
   * `Read(...)`. The binding turns them into CLI rules; the canon stays
   * provider-neutral.
   *
   * `allow` removes patterns from the effective deny set. Subtraction is exact
   * string equality after normalisation (trim, backslash→forward-slash, strip
   * leading `./`). Writing `"**\/*.pem"` removes the project-default `"**\/*.pem"`
   * credential deny and grants access to all `.pem` files for this step. A
   * specific path like `"fixtures/sample.pem"` only removes that exact string; it
   * does NOT remove the broad `"**\/*.pem"` project default, which would still deny
   * the file via glob matching. To allow a specific file covered by a broad glob,
   * the broad glob itself must be named in `allow`.
   *
   * `allow` can never widen the tool set beyond `contents`: a step with
   * `contents: "read"` that allows a path still cannot write it.
   *
   * `deny` adds step-only deny patterns on top of the project defaults, before
   * `allow` subtraction. Useful for adding narrower restrictions specific to this
   * step (e.g. deny a directory that is safe for other steps to read).
   *
   * Both fields require `contents` to be present; rejected otherwise — an
   * exception to a deny list that is not applied is a silent no-op and the
   * operator must be told, not guessed for.
   *
   * Any scope other than `contents` (plus the `allow`/`deny` sub-fields) is
   * rejected at load time.
   */
  permissions?: {
    contents: "read" | "write" | "none";
    /** Exceptions to the project-default deny set. Plain path globs. */
    allow?: string[];
    /** Additional deny patterns for this step only. Plain path globs. */
    deny?: string[];
  };
  /**
   * For `kind: "check"` steps: the shell command to execute via `/bin/sh -c`.
   * A non-zero exit code yields `passed: false`; it is not an error — the run continues.
   * Required and non-empty. Cannot be combined with `prompt`, `role`, `model`, `schema`,
   * or `permissions`.
   */
  command?: string;
  /**
   * For `kind: "export-spec"` steps: the directory path to write the Spec Kit
   * `spec.md` file into. The directory is created if it does not exist.
   * Required and non-empty. Cannot be combined with `prompt`, `role`, `model`,
   * `schema`, or `permissions`.
   */
  path?: string;
  /**
   * For `kind: "pipeline"` steps: names the id of the nested pipeline to
   * expand in place of this step at load time.
   * For `kind: "loop"` steps: names the id of the pipeline that is the loop body.
   * The referenced pipeline YAML must live in the same directory as the parent.
   */
  pipeline?: string;
  /**
   * For `kind: "pipeline"` steps only. Maps each of the nested pipeline's
   * declared `inputs` to a context key available in the parent pipeline
   * (a parent input name or an ancestor step id). At load time the nested
   * prompts' input placeholders are rewritten to the mapped parent key so
   * the runtime never sees the bare input name. Every key must be a declared
   * input of the target pipeline; validation fails at load time otherwise.
   */
  with?: Record<string, string>;
  /**
   * For `kind: "loop"` steps only. Maximum number of times the body pipeline
   * may run. Must be a positive integer. Exhausting the budget is not an error.
   */
  maxIterations?: number;
  /**
   * For `kind: "loop"` steps only. The context key that signals convergence.
   * The loop stops as soon as `ctx[until]` is truthy or `maxIterations` is reached.
   */
  until?: string;
}

export interface PipelineDef {
  id: string;
  version: number;
  description: string;
  inputs: string[];
  steps: StepDef[];
  defaultTimeoutMs?: number;
}

export interface LoadedPipeline {
  def: PipelineDef;
  prompts: Record<string, string>;
  /**
   * Resolved loop bodies, keyed by the loop step's id. Populated by
   * `expandNested` for every `kind: "loop"` step in the pipeline.
   * Optional so that consumers that do not use loop steps are unaffected.
   */
  bodies?: Record<string, LoadedPipeline>;
}
