/**
 * Fixture: adversarial audit of a proposed step-execution helper.
 *
 * The diff below introduces a plausible-looking `validateStep` + `runCheckStep`
 * module in the agent-flows runtime style.  Two real defects are deliberately planted;
 * one piece of code LOOKS suspicious but is actually fine (the decoy).
 *
 * Planted defects
 * ───────────────
 * 1. CORRECTNESS — inverted command fallback in runCheckStep:
 *    `context["command"] ?? step.command` means a caller-supplied context key
 *    named "command" silently overrides the authoritative step definition.
 *    The fallback order should be reversed: step.command must take priority.
 *    Keywords: command, context, override
 *
 * 2. SECURITY — shell injection via step.id interpolation:
 *    `step.id` is spliced directly into a shell string passed to execSync.
 *    step.id originates from YAML and could carry shell injection metacharacters
 *    (; $() ` etc.) if the YAML source is not fully trusted.
 *    Keywords: step.id, injection
 *
 * Decoy (looks suspicious, actually safe)
 * ────────────────────────────────────────
 * D1. parseInt(String(step.maxIterations ?? "1"), 10)
 *     Could this yield NaN?  It cannot: the YAML schema loader validates
 *     maxIterations as a positive integer before any StepDef reaches this
 *     function, so the input is always a valid number or the default "1".
 *     Keywords: parseint, nan
 */

import type { KeyedItem } from "../scorers.js";

export interface AuditFixture {
  /** Diff passed as `plan` input to the audit pipeline. */
  diff: string;
  /** Defects deliberately planted in the diff; the auditor should find all of them. */
  plantedDefects: KeyedItem[];
  /** Code that looks suspicious but is actually fine; auditor must NOT flag these. */
  decoys: KeyedItem[];
  /** Repo paths that must exist on disk (anti-rot). */
  expectedPaths: string[];
}

const DIFF = `\
diff --git a/src/runtime/validateStep.ts b/src/runtime/validateStep.ts
new file mode 100644
--- /dev/null
+++ b/src/runtime/validateStep.ts
@@ -0,0 +1,44 @@
+// Step validation and execution helper for the agent-flows runtime.
+import { execSync } from "node:child_process";
+import type { StepDef } from "../canon/types.js";
+
+const LOG_FILE = "/tmp/agent-flows-run.log";
+
+/**
+ * Validate that a step definition is complete enough to run.
+ * Returns a list of validation errors; empty list means valid.
+ */
+export function validateStep(step: StepDef): string[] {
+  const errors: string[] = [];
+  if (step.kind === "check" && !step.command) {
+    errors.push(\`step "\${step.id}": check step requires a command\`);
+  }
+  if (step.kind === "llm" && !step.prompt) {
+    errors.push(\`step "\${step.id}": llm step requires a prompt\`);
+  }
+  if (step.kind === "loop") {
+    // DECOY: parseInt looks risky — could this yield NaN if maxIterations is
+    // not a valid integer?  It cannot: the YAML schema loader validates
+    // maxIterations as a positive integer before any StepDef reaches here.
+    const iterations = parseInt(String(step.maxIterations ?? "1"), 10);
+    if (iterations < 1) {
+      errors.push(\`step "\${step.id}": maxIterations must be at least 1\`);
+    }
+  }
+  return errors;
+}
+
+/**
+ * Run a check step and return the raw output.
+ * Caller is responsible for ensuring the step has kind === "check".
+ */
+export function runCheckStep(
+  step: StepDef,
+  context: Record<string, string>
+): string {
+  // BUG (correctness): context["command"] is evaluated first, so it overrides
+  // step.command when a context key named "command" is present.  The fallback
+  // order is inverted — step.command should be authoritative, not the context.
+  const cmd = context["command"] ?? step.command ?? "";
+  // BUG (security): step.id is interpolated into a shell string without
+  // sanitisation.  step.id originates from YAML and could carry shell injection
+  // metacharacters (; $() \` etc.) if the YAML source is not fully trusted.
+  execSync(\`echo "Running step \${step.id}" >> \${LOG_FILE}\`);
+  return execSync(cmd, { encoding: "utf8" });
+}
`;

const fixture: AuditFixture = {
  diff: DIFF,

  plantedDefects: [
    {
      phrase: 'inverted command fallback — context["command"] overrides step.command',
      // An auditor finding this must reference the context value overriding the
      // step definition; all three keywords together identify the finding.
      keywords: ["command", "context", "override"],
    },
    {
      phrase: "step.id interpolated into shell command — shell injection vector",
      // step.id (the exact identifier) plus "injection" require the auditor to
      // name both the source and the vulnerability class.
      keywords: ["step.id", "injection"],
    },
  ],

  decoys: [
    {
      phrase: "parseInt(maxIterations) could yield NaN — actually safe due to schema validation",
      // Only match if the auditor specifically raises NaN as a risk alongside
      // parseInt; auditors that dismiss or ignore this path won't mention NaN.
      keywords: ["parseint", "nan"],
    },
  ],

  // src/canon/types.ts defines StepDef which the diff imports — if the file
  // moves or is deleted this fixture needs updating.
  expectedPaths: ["src/canon/types.ts"],
};

export default fixture;
