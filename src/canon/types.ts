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
  | "check"
  | "review-material";

export type Role = "reasoner" | "worker" | "scout";

export interface StepDef {
  id: string;
  kind: StepKind;
  role?: Role;
  model?: string;
  prompt?: string;
  schema?: "weaknesses" | "securityFindings" | "codeReviewFindings" | "codeReviewDelivery";
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
   * - `contents: "read"`: read-only file access (Read, Glob and Grep tools only).
   * - `contents: "write"`: read + edit access (Edit and Write tools added);
   *   Bash/shell is never granted — that is the separate concern of kind: "check".
   * - `contents: "none"` or absent `permissions`: no repo access (default, fully
   *   backward compatible). Not supported for api transport.
   *
   * The optional `deny` field (key name adopted from Claude Code's own
   * `permissions.deny` settings format, not invented here) adds step-only deny
   * patterns on top of the project-wide credential and build-config deny set that
   * the runtime applies whenever `contents` is set:
   *
   *   effective deny = project defaults ∪ step.deny
   *
   * Deny is narrowing-only (spec 031 D5): nothing a pipeline declares can remove a
   * project default. The companion `allow` field was removed — a pipeline author is
   * not an authorisation authority, and one line of YAML must never re-open a
   * credential denial.
   *
   * `deny` accepts plain path globs — NOT vendor rule strings like `Read(...)`.
   * The binding turns them into CLI rules; the canon stays provider-neutral.
   * Useful for adding narrower restrictions specific to this step (e.g. deny a
   * directory that is safe for other steps to read).
   *
   * It requires `contents` to be present; rejected otherwise — a deny list that is
   * not applied is a silent no-op and the operator must be told, not guessed for.
   *
   * Any scope other than `contents` (plus the `deny` sub-field) is rejected at
   * load time.
   */
  permissions?: {
    contents: "read" | "write" | "none";
    /** Additional deny patterns for this step only. Plain path globs. */
    deny?: string[];
  };
  /**
   * For `kind: "check"` steps: the shell command to execute via `/bin/sh -c`.
   * A non-zero exit code yields `passed: false`; it is not an error — the run continues,
   * unless the step sets `required: true`, which turns a non-zero exit into a run failure.
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
   * For `kind: "check"` steps only: when true, a non-zero exit fails the whole run
   * instead of being recorded as `passed: false` and carried on in the context.
   *
   * The default (absent or false) is the loop-friendly behaviour: `build-round`'s
   * `test` step must be allowed to fail so the loop can iterate on it. A terminal
   * verification check — the last word on whether the tree the run produced is
   * acceptable — must do the opposite, or the run reports success over a broken tree.
   *
   * On a `review-material` step it means the same thing: a capture that came back
   * unavailable fails the run instead of being carried in the context as
   * `available: false`.
   *
   * Must be a boolean; rejected on every step kind other than `check` and
   * `review-material` (FR-004 style loud load-time validation: a flag that is
   * silently ignored is worse than absent).
   */
  required?: boolean;
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
   * For `kind: "llm"` steps: whether this step may be retried on a different provider
   * when its first attempt fails with a transport-level error. Defaults to true — an
   * absent field keeps the provider profile's `fallback` chain.
   *
   * Set to `false` to pin the step to the provider the run chose. The prompt a failover
   * hands the second vendor is the SAME rendered prompt, upstream step outputs included —
   * on a `contents: read` pipeline that is repository content the first provider read.
   * A step whose prompt carries content that must not reach a second vendor says so here;
   * it then fails as if the chain were exhausted rather than crossing providers.
   *
   * Must be a boolean; rejected on every step kind other than `llm` — a flag that is
   * silently ignored is worse than one that is absent.
   */
  failover?: boolean;
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
