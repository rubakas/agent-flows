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

export type StepKind = "llm" | "gate" | "assemble-spec" | "persist-ticket" | "pipeline" | "loop";

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
   * Per-step deadline in milliseconds. Overrides the pipeline's `defaultTimeoutMs` and
   * the built-in default. Set to `0` to disable the deadline for this step — useful for
   * long-running steps that must not be killed mid-thought. `null` is not accepted; use `0`.
   */
  timeoutMs?: number;
  /**
   * Declares workspace access for the step's agent. When set to `"read"`,
   * the agent is constrained to read-only file access (Read and Glob tools only).
   * When set to `"write"`, the agent may also edit and create files (Edit and Write
   * tools added); Bash/shell is never granted — that is the separate concern of the
   * forthcoming check step kind. Absent = no repo access (default, fully backward
   * compatible). Not supported for api transport.
   */
  workspace?: "read" | "write";
  /**
   * For `kind: "pipeline"` steps: names the id of the nested pipeline to
   * expand in place of this step at load time.
   * For `kind: "loop"` steps: names the id of the pipeline that is the loop body.
   * The referenced pipeline YAML must live in the same directory as the parent.
   */
  pipeline?: string;
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
