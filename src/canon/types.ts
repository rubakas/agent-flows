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
   * For `kind: "gate"` steps only: when true, the gate is always answered by a human
   * regardless of the run-level `gateMode`. The judge is never dispatched for this gate.
   * Validated at load time: must be a boolean; rejected on non-gate steps (FR-013).
   */
  manualOnly?: boolean;
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
   * For `kind: "check"` steps only: an explicit per-step allowlist of environment variable
   * names that this step's shell command may receive, on top of the built-in base set
   * (`CHECK_ENV_ALLOWLIST` in runStep.ts: PATH, HOME, SHELL, TMPDIR, LANG, etc.).
   *
   * Any variable not in the base set or in this list is stripped before `/bin/sh -c`
   * is invoked. A step that needs `GH_TOKEN` must declare `env: [GH_TOKEN]` here.
   *
   * Must be a non-empty array of valid environment variable name strings (letters, digits,
   * underscore; must start with letter or underscore). Only meaningful on `check` steps —
   * rejected on all other step kinds.
   */
  env?: string[];
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
  /**
   * Per-step cost cap for claude-transport llm steps. Passed as `--max-budget-usd`
   * to the CLI; the CLI trips it and emits a result event with subtype
   * `error_max_budget_usd`, which the parser maps to `StepBudgetExceededError`.
   *
   * No default value — the field must be explicitly set. Absent → flag is not emitted.
   * The value is a client-side estimate from the CLI's bundled price table and is not
   * a billing limit. Must be a positive number. Only valid on llm steps; rejected on
   * check steps and other non-llm kinds at load time. Rejected at runtime on
   * api/codex transports (no equivalent flag exists for those transports).
   *
   * Overrides `PipelineDef.defaultMaxBudgetUsd` when both are set.
   */
  maxBudgetUsd?: number;
}

export interface PipelineDef {
  id: string;
  version: number;
  description: string;
  inputs: string[];
  /**
   * Subset of `inputs` that may be omitted when triggering the pipeline standalone.
   * The Mastra workflow schema emits `z.string().optional().default("")` for each
   * listed name instead of the usual `z.string()`. Every name here must also appear
   * in `inputs`; violation is rejected at load time.
   */
  optionalInputs?: string[];
  steps: StepDef[];
  defaultTimeoutMs?: number;
  /**
   * Pipeline-level cost cap fallback for claude-transport llm steps. Applied when
   * a step does not declare its own `maxBudgetUsd`. Step-level value overrides this.
   * No default; absent → no budget limit unless set on the step. Positive number only.
   */
  defaultMaxBudgetUsd?: number;
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
