# 0016. Prompt authoring: portable core in the canon, model-conditional knobs in bindings

Status: Accepted (2026-09-05)

Amends: Charter rule 1 (provider portability) and rule 3 (canon neutrality).

## Context

Charter rule 1 makes provider portability an acceptance criterion — the same `prompts/*.md` must run
under Claude and GPT without modification. A primary-source survey of both vendors' official
prompt-engineering documentation (`docs/research/2026-09-04-prompting-anthropic-openai.md`) found:

- **Large portable overlap** — specificity, explicit structure, separate role blocks, grounded
  context, and restrained tone are documented best practices at both vendors.
- **Small set of genuinely non-portable knobs** — chain-of-thought phrasing (helps non-reasoning GPT,
  discouraged on reasoning models), few-shot volume (reasoning prefers zero-shot, non-reasoning
  benefits from 3–5 examples), and reasoning-depth control (a config concern on both sides).
- **One hard current fact** — prefilled assistant responses return a 400 error starting with Claude
  4.6+ models (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices).
  This is a breaking change: any prompt built around prefill breaks on new Claude models.

The decision applies the principle from ADR-0011 (canon neutral, binding-specific) to every
`prompts/*.md` file.

## Decision

### Canon prompts carry only the portable core. House style for every `prompts/*.md`:

1. **Open with an explicit objective and the exact output format and constraints** — written so a
   colleague with no context could execute it (Anthropic's "golden rule" applies to both vendors).

2. **Use XML-tagged blocks as the primary scaffold:** `<instructions>`, `<context>`, `<input>`,
   `<examples>`, and `<output_format>`. XML is the common denominator — Anthropic recommends it,
   OpenAI accepts it. Never use JSON as the prompt structure (documented to underperform on both
   sides).

3. **Keep role/system content in its own explicit block** so each binding maps it correctly:
   Binding A → Claude `system` field, Binding B → OpenAI `developer` role.

4. **Positive, numbered imperatives** when order matters ("Do X", "Change Y", "Run Z"). Restrained
   tone — no walls of all-caps or "CRITICAL: YOU MUST" (current models over-trigger on both sides).

5. **Reference material at the top, the actual task at the end.** For long prompts, restate the key
   instruction at the end; this superset works everywhere.

6. **When reference material is supplied, instruct the step to ground its answer in it** (quote or
   cite relevant parts before answering). Both vendors document this reduces hallucination.

7. **State success criteria explicitly.** Ask for a verified result, not a mandated verification
   process (let model/effort decide whether to self-check).

8. **Never use assistant prefill.** It errors on Claude 4.6+ and is not an OpenAI concept. Constrain
   output via explicit format instructions and XML output tags.

### Three knobs are binding-injected, never hard-coded:

1. **Chain-of-thought wording** — phrasing like "think step by step" helps non-reasoning GPT-4.1
   but is discouraged (may hurt performance) on reasoning models on BOTH vendors. Phrase the prompt
   for the outcome ("produce a short plan, then the implementation"; "return a checked answer"), and
   let a binding inject explicit step-by-step text only for non-reasoning targets.

2. **Few-shot examples volume** — reasoning models prefer zero-shot; non-reasoning benefit from 3–5
   examples. Keep `<examples>` optional and removable so a reasoning binding can drop them.

3. **Reasoning depth / effort** — a config concern (Claude `effort` parameter, OpenAI
   `reasoning_effort` and model choice), not prompt text. Bindings apply this at execution time, not
   through the `.md`.

## Consequences

- **Canon prompts are versioned in git.** Existing `prompts/*.md` predate this convention and are
  not yet compliant — converting them is follow-up work, not part of this decision.

- **Bindings gain responsibility for model-conditional text.** Binding A (Claude Code) injects CoT
  and examples wording at template-generation time based on model capability; Binding B (Mastra)
  does the same at step rendering. This is already the pattern — the decision formalizes it.

- **Prompt changes must be backed by evals before commit.** Both vendors document systematic
  evaluation as a prerequisite. The canon is the source of truth; a change here propagates to all
  bindings, so regression is costly. (Charter rule 6 already requires this as a lean-spec discipline.)

- **This is Charter rule 3 applied to prompts.** The neutral core stays in the canon, provider
  divergence lives in thin bindings. Yoke can swap providers (edit `YOKE_PROVIDER`, restart) without
  touching a single prompt because prompts are truly neutral.

## Alternatives Rejected

- **Hard-code chain-of-thought text** ("think step by step") in the neutral prompt. This optimizes
  for non-reasoning models but actively hurts reasoning models on both vendors, per their official
  guidance. A prompt that works everywhere must not include vendor-specific reasoning processes.

- **One prompt per binding** (e.g., `prompts/reviewer.claude.md`, `prompts/reviewer.gpt.md`). This
  duplicates every prompt and breaks portability — adding a step means writing it twice, and
  consistency becomes a manual discipline. The knob injection approach keeps one source.

- **Use OpenAI's `instructions` parameter instead of role blocks.** This is a binding-layer detail
  (Binding B handles it), not a prompt-authoring decision. The prompt stays neutral; the binding
  applies it.
