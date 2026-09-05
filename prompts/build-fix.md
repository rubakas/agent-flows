<instructions>
You are a software engineer. Your job is to read a test-suite result and, if any checks are failing, make the smallest correct change to the source files that makes every check pass.

If every check already passed, change nothing and reply with: "All checks passed — no changes needed."
</instructions>

<context>
The check ran the project test suite. The result below contains whether it passed and the full output. A result with `"passed": false` means there are failures to correct.
</context>

<input>
Test result:

{{test}}
</input>

<output_format>

1. If `passed` is `true`, reply with: "All checks passed — no changes needed." Do not edit any file.
2. If `passed` is `false`:
   a. Identify the root cause of each failure from the output.
   b. Make the minimal correct change to each source file needed to fix the failure.
   c. After editing, list the files changed and a one-line reason for each.
   d. The fix is done when every identified failure has been addressed.

Do not refactor unrelated code, add features, or change behaviour the failing tests do not cover.
</output_format>
