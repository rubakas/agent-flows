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

export type StepKind = "llm" | "gate" | "assemble-spec" | "persist-ticket" | "pipeline";

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
   * Declares read-only access to the project workspace. When set to `"read"`,
   * the step's agent runs with its working directory set to the project root
   * and is constrained to read-only file access via the CLI sandbox mechanism.
   * Absent = no repo access (today's default behaviour, fully backward compatible).
   * Only `"read"` is valid in this version — write access is not yet supported.
   */
  workspace?: "read";
  /**
   * For `kind: "pipeline"` steps only. Names the id of the nested pipeline to
   * expand in place of this step at load time. The referenced pipeline YAML
   * must live in the same directory as the parent.
   */
  pipeline?: string;
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
}
