# Prompt engineering: Anthropic vs OpenAI — for provider-neutral yoke step prompts

Date: 2026-09-04. Goal: gather the documented, current prompt-engineering guidance from
**both** Anthropic and OpenAI so yoke can write `prompts/*.md` step prompts that run the same
text under either a Claude or a GPT model. **Facts only.** Every principle cites a primary
vendor URL inline. Claims not confirmable against a live primary page are marked
_unverified_.

Two structural facts about the sources, established while gathering them:

- **Anthropic consolidated its docs.** The classic per-technique sub-pages
  (`be-clear-and-direct`, `multishot-prompting`, `chain-of-thought`, `use-xml-tags`,
  `system-prompts`, `prefill-claudes-response`, `chain-prompts`, `long-context-tips`,
  `extended-thinking-tips`) now **302-redirect** into one living reference,
  **"Prompting best practices"**. Verified live: fetching
  `.../prompt-engineering/be-clear-and-direct` and `.../multishot-prompting` both redirect to
  `claude-prompting-best-practices`. `docs.claude.com` itself now redirects to
  `platform.claude.com`. That consolidated page is the primary source for Section A.
- **OpenAI restructured its guide.** The old canonical `platform.openai.com/docs/guides/prompt-engineering`
  now **301-redirects** to `developers.openai.com/api/docs/guides/prompt-engineering`, and the
  restructured live page **no longer presents the famous "six strategies" framework** (verified:
  the live page has no "six strategies" list and does not contain the strings "provide reference
  text", "split complex tasks", "give the model time to think", or "test changes systematically").
  The six-strategy framework is therefore treated below as **legacy OpenAI guidance** (still a real
  primary framework, but retired from the live page); its per-tactic detail is marked _unverified
  against the current live page_ because the Wayback Machine is blocked in this environment.

---

## A. Anthropic techniques

Primary source for the whole table (single consolidated reference):
`https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices`
(overview: `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview`).

| #   | Technique                                    | Documented guidance (concise)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Be clear and direct**                      | "Claude responds well to clear, explicit instructions." Be specific about desired output format and constraints; give steps as numbered/bulleted lists "when the order or completeness of steps matters." If you want "above and beyond" behavior, explicitly request it. **Golden rule:** "Show your prompt to a colleague with minimal context on the task and ask them to follow it. If they'd be confused, Claude will be too." Frame: treat Claude as "a brilliant but new employee who lacks context on your norms and workflows."                                                                                                                                                                                                                                          |
| 2   | **Add context (explain the why)**            | "Providing context or motivation behind your instructions … can help Claude better understand your goals." Example: instead of `NEVER use ellipses`, explain that a TTS engine can't pronounce them. "Claude is smart enough to generalize from the explanation."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3   | **Use examples (few-shot / multishot)**      | "Examples are one of the most reliable ways to steer Claude's output format, tone, and structure." Make them **Relevant** (mirror the real use case), **Diverse** (cover edge cases so Claude doesn't latch onto unintended patterns), **Structured** (wrap in `<example>` tags; multiple in `<examples>`). "Include 3–5 examples for best results."                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4   | **Structure prompts with XML tags**          | "XML tags help Claude parse complex prompts unambiguously." Wrap each content type in its own tag (`<instructions>`, `<context>`, `<input>`). Use "consistent, descriptive tag names"; nest tags for natural hierarchy (`<documents>` › `<document index="n">`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | **Give Claude a role (system prompt)**       | "Setting a role in the system prompt focuses Claude's behavior and tone… Even a single sentence makes a difference." Role text goes in the `system` field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | **Long-context prompting (20k+ tokens)**     | **Put longform data at the top**, above the query/instructions/examples ("Queries at the end can improve response quality by up to 30 percent in tests"). Wrap each document in `<document>` with `<document_content>` and `<source>` subtags. **Ground responses in quotes:** ask Claude to pull relevant quotes into `<quotes>` tags _before_ doing the task.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7   | **Control output format**                    | Prefer telling Claude **what to do, not what not to do** ("Your response should be composed of smoothly flowing prose paragraphs" beats "Do not use markdown"). Use **XML format indicators** (`<smoothly_flowing_prose_paragraphs>`). **Match your prompt style to the desired output** (e.g. remove markdown from the prompt to reduce markdown in the output).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8   | **Prefill — now removed for new models**     | Classic prefill (a partial assistant message to continue from) is **no longer supported on the last assistant turn** starting with Claude 4.6 models and Claude Mythos Preview: such requests "return a 400 error." Migrate to **Structured Outputs**, direct system-prompt instructions ("Respond directly without preamble…"), XML output tags, or tool calling. Prefill still works on older models and for non-final assistant turns.                                                                                                                                                                                                                                                                                                                                         |
| 9   | **Explicit tool/action instructions**        | Current models "follow instructions … literally" — "Can you suggest some changes" yields suggestions, not edits. Say "Change this function…" to make it act. `<default_to_action>` / `<do_not_act_before_instructions>` snippets steer proactivity. Dial back shouty language: "Where you might have said 'CRITICAL: You MUST use this tool when…', you can use more normal prompting like 'Use this tool when…'."                                                                                                                                                                                                                                                                                                                                                                |
| 10  | **Thinking & reasoning (adaptive thinking)** | Current models use **adaptive thinking** (`thinking: {type: "adaptive"}`) — Claude decides when/how much to think, driven by the `effort` parameter and query complexity; `budget_tokens` is deprecated/errors on 4.7+. **"Prefer general instructions over prescriptive steps"** — "'think thoroughly' often produces better reasoning than a hand-written step-by-step plan." **Multishot works with thinking** (show reasoning in `<thinking>` tags in your examples). **Manual CoT is a fallback** when thinking is off (use `<thinking>`/`<answer>` tags). **Ask Claude to self-check** ("verify your answer against [criteria]"). Note: with thinking disabled, Opus 4.5 is "particularly sensitive to the word 'think'" — prefer "consider," "evaluate," "reason through." |
| 11  | **Chain complex prompts**                    | With adaptive thinking + subagents, Claude handles most multi-step reasoning internally. Explicit chaining (sequential API calls) is "still useful when you need to inspect intermediate outputs or enforce a specific pipeline structure." Most common pattern is **self-correction**: draft → review against criteria → refine, each a separate call.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 12  | **Agentic / long-horizon**                   | State tracking across context windows (git, `tests.json`, `progress.txt`); "emphasize incremental progress"; native subagent orchestration (watch for over-spawning); anti-over-engineering snippet ("Avoid over-engineering. Only make changes that are directly requested or clearly necessary."); anti-hallucination snippet ("Never speculate about code you have not opened … read the file before answering").                                                                                                                                                                                                                                                                                                                                                              |

Prose notes worth carrying into yoke prompts: the **golden-rule / "new employee"** framing (row 1)
is Anthropic's single most load-bearing principle — specificity beats cleverness. The **XML-tag**
discipline (rows 3, 4, 6, 7) recurs across every other technique: examples, documents, output
format, and reasoning are all steered by tags. And the **prefill removal** (row 8) is a hard
current-fact, not a style preference — a prompt built around prefill breaks on new Claude models.

---

## B. OpenAI techniques

Primary current sources:
`https://developers.openai.com/api/docs/guides/prompt-engineering` (live guide),
`https://developers.openai.com/api/docs/guides/reasoning-best-practices` (reasoning models),
`https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide` (GPT-4.1 guide).
Legacy: `https://platform.openai.com/docs/guides/prompt-engineering` (the "six strategies",
now redirected/restructured — see below).

### B.1 — Current live guide (verified section-by-section)

| #   | Section                                   | Documented guidance (concise)                                                                                                                                                                                                |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Choosing a model**                      | Reasoning models for complex, multi-step planning; GPT models are "fast, cost-efficient, and benefit from explicit instructions"; weigh large-vs-small trade-offs.                                                           |
| 2   | **Message roles & instruction following** | Priority order **developer > user**. Use the `instructions` parameter for high-level tone/goals. Analogy: developer messages are "like a function and its arguments" — developer = the rules, user = the inputs.             |
| 3   | **Version prompts in code**               | Store production prompts in application code (not reusable prompt objects); use typed function arguments for dynamic values; "add representative fixtures, tests, and evaluation checks before changing production prompts." |
| 4   | **Message formatting (Markdown + XML)**   | Use **Markdown headers/lists** to mark sections and **XML tags** to delineate content boundaries. Structure developer messages with **Identity, Instructions, Examples, Context**.                                           |
| 5   | **Few-shot learning**                     | Include a handful of **diverse** input/output examples showing desired outputs, placed inside the developer message.                                                                                                         |
| 6   | **Include relevant context (RAG)**        | Add proprietary/external data the model wasn't trained on; constrain answers to those resources; mind context-window limits.                                                                                                 |
| 7   | **Coding / front-end best practices**     | Define the agent's role and responsibilities; enforce structured tool use with examples; require thorough testing; set Markdown standards for clean output.                                                                  |
| 8   | **Agentic tasks**                         | "Plan tasks thoroughly; resolve full query before yielding control"; decompose into sub-tasks and "reflect after each tool call"; use a TODO tool to track progress.                                                         |
| 9   | **Prompting reasoning models**            | "Provide high-level guidance rather than precise instructions" and "trust the model to work out implementation details."                                                                                                     |

### B.2 — GPT-4.1 prompting guide (verified)

- **Three agentic system-prompt reminders — Persistence, Tool-calling, Planning.** "Keep going
  until the user's query is completely resolved, before ending your turn"; use tools to read files
  rather than guess; plan explicitly before each function call. Together reported to lift SWE-bench
  Verified ~20%; the planning reminder alone ~4%.
- **Literal instruction following.** GPT-4.1 "follows instructions more closely and more literally
  than its predecessors"; specify desired behavior explicitly; "a single sentence firmly clarifying
  your desired behavior is almost always sufficient." **When instructions conflict, the model tends
  to follow the one closer to the end of the prompt.** **Avoid excessive all-caps** (can cause
  over-literalness).
- **Recommended prompt skeleton:** `# Role and Objective` / `# Instructions` (+ `## Sub-categories`)
  / `# Reasoning Steps` / `# Output Format` / `# Examples` / `# Context` / `# Final instructions`.
- **Delimiters:** start with **Markdown**; **XML** performs well for precise nesting/metadata;
  **JSON is verbose and underperforms** in long-context tests; an `ID | TITLE | CONTENT` layout beat
  JSON for documents.
- **Long context (1M window):** "Place your instructions at both the beginning and end of provided
  context" — better than a single placement.
- **Induced CoT (GPT-4.1 is _not_ a reasoning model):** it "benefits from explicit step-by-step
  prompting," e.g. "Think carefully step by step about what documents are needed…".
- **Tools:** use the API's `tools` field, not schemas injected into the prompt (~2% gain); clear
  names + detailed descriptions reduce hallucination.

### B.3 — Reasoning-model best practices (verified)

- **When to use which:** reasoning (o-series/GPT-5-class) for complex, multi-step, high-accuracy
  work; GPT for speed/cost on well-defined tasks; most workflows use both (reasoning to plan, GPT to
  execute).
- **Keep it simple:** "The models excel at understanding and responding to brief, clear
  instructions."
- **Avoid chain-of-thought prompts:** because reasoning happens internally, "prompting them to
  'think step by step' or 'explain your reasoning' is unnecessary" and "may reduce performance."
- **Use delimiters** (markdown, XML tags, section titles) to mark distinct input parts.
- **Start zero-shot:** "Reasoning models often don't need few-shot examples… try to write prompts
  without examples first" (add a few if output isn't in the desired form).
- **Be explicit about constraints** (budget, success criteria) rather than relying on inference.
- **Developer messages replace system messages** as of `o1-2024-12-17`.

### B.4 — The legacy "six strategies" framework

Source (legacy, now redirected): `https://platform.openai.com/docs/guides/prompt-engineering`.
OpenAI's own summary confirms the six strategy names; the per-tactic detail is _unverified against
the current live page_ (page restructured; Wayback blocked here). Presented because it is still a
real OpenAI framework and the tactics map cleanly onto the live sections in B.1–B.3.

1. **Write clear instructions** — include details; ask the model to adopt a persona; **use
   delimiters** (triple quotes / XML / headers); specify the steps; provide examples; specify output
   length. _(tactic wording per OpenAI's guide; unverified against live page.)_
2. **Provide reference text** — "providing reference text to GPTs can help in answering with fewer
   fabrications"; answer using / with citations from the reference text. _(confirmed description;
   tactic detail unverified against live page.)_
3. **Split complex tasks into simpler subtasks** — intent classification, summarize/filter long
   inputs, recursive summarization. _(unverified against live page.)_
4. **Give the model time to think** — get "its chain of reasoning before computing an answer";
   inner-monologue / work-it-out-first tactics. _(confirmed description; tactic detail unverified.)_
5. **Use external tools** — embeddings/RAG search, code execution, function calling. _(unverified
   against live page.)_
6. **Test changes systematically** — evaluate against gold-standard answers / evals. _(mirrors the
   live "Version prompts in code" + "add tests… before changing production prompts", which IS
   verified.)_

---

## C. Where they AGREE — the portable core

These are the safe rules for a single prompt that runs on either vendor. Each cites both sides.

| Portable principle                                                                | Anthropic                                                | OpenAI                                                                                                       |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Be clear, explicit, specific; a colleague could follow it**                     | Be clear and direct + golden rule (A-1)                  | Write clear instructions; GPT-4.1 literal following (B.1-1/B.2); reasoning "brief, clear instructions" (B.3) |
| **Positive, imperative instructions ("do X", not "don't")**                       | "Tell Claude what to do instead of what not to do" (A-7) | Clear-instruction tactics / specify the steps (B.4-1)                                                        |
| **Structure the prompt with explicit delimiters/sections**                        | XML tags per content type (A-4)                          | Markdown + XML sections; delimiters (B.1-4, B.2, B.3)                                                        |
| **Use a role / system(developer) block, kept separate from the task**             | Give Claude a role in `system` (A-5)                     | Developer message / persona; developer-vs-user priority (B.1-2)                                              |
| **Provide context / reference material and ground answers in it**                 | Add context (A-2); ground responses in quotes (A-6)      | Include relevant context / RAG (B.1-6); legacy "Provide reference text" (B.4-2)                              |
| **Examples help steer format/behavior**                                           | Use examples, 3–5, relevant + diverse (A-3)              | Few-shot learning, diverse examples (B.1-5) — _but see D for reasoning-model caveat_                         |
| **Decompose complex work; step-by-step for non-reasoning models**                 | Chain complex prompts; manual CoT fallback (A-10/A-11)   | Split complex tasks; give time to think (B.4-3/4); GPT-4.1 planning + induced CoT (B.2)                      |
| **In long context, anchor instructions at the boundaries**                        | Longform data at top, query at end (A-6)                 | GPT-4.1: instructions at beginning **and** end (B.2)                                                         |
| **Prefer defining tools via the API tool interface, not prompt-injected schemas** | Tool-use docs (A-9)                                      | GPT-4.1 explicit, ~2% gain (B.2)                                                                             |
| **Don't shout; avoid heavy all-caps / "CRITICAL: YOU MUST" on current models**    | Dial back "CRITICAL: You MUST…" (A-9)                    | GPT-4.1 avoid excessive all-caps → over-literalness (B.2)                                                    |
| **Test/evaluate prompt changes systematically; version them**                     | Overview assumes evals / "empirically test"              | Version prompts in code + tests before changes (B.1-3); legacy "Test changes systematically" (B.4-6)         |

The overlap is large: **specificity, explicit structure with delimiters, a separate role block,
grounded context, decomposition, boundary-anchored instructions, restrained tone, and systematic
evaluation are documented by both vendors.** A prompt built only from these will behave predictably
on either model family.

---

## D. Where they DIFFER — provider-specific behavior

Each row is a place where the _same_ prompt text can behave differently across the two vendors.

| Divergence                               | Anthropic                                                                                                                                                                                          | OpenAI                                                                                                                                                                       | Portable resolution                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primary structuring syntax**           | XML tags are the recommended default and thread through every technique                                                                                                                            | Markdown is the default; XML "performs well"; **JSON-as-prompt-scaffold underperforms** (GPT-4.1)                                                                            | **XML tags are the common denominator** — Anthropic recommends them, OpenAI accepts them. Markdown headings are also accepted by both. **Avoid JSON as prompt structure.** |
| **Prefilling the assistant turn**        | Classic technique, **removed** on Claude 4.6+ (400 error); migrate to structured outputs / direct instructions / XML output tags                                                                   | Not a documented technique; output shape is controlled by developer message + structured outputs                                                                             | **Never rely on prefill** in a neutral prompt. Constrain output via explicit format instructions / XML output tags instead.                                                |
| **Chain-of-thought on reasoning models** | Adaptive thinking is on for many current models; "prefer general instructions over prescriptive steps"; manual CoT only a fallback; avoid the literal word "think" when thinking is off (Opus 4.5) | Reasoning models: **do NOT** add "think step by step"/"explain your reasoning" (unnecessary, may hurt). GPT-4.1 (non-reasoning): **does** benefit from explicit step-by-step | **Do not hard-code "think step by step."** Ask for the _outcome_ (a plan, a checked answer). See E — genuine single-prompt tension.                                        |
| **Few-shot default**                     | Examples are "one of the most reliable ways" to steer (encourage 3–5)                                                                                                                              | Reasoning models: "start with zero-shot… without examples first"; GPT/GPT-4.1: examples help                                                                                 | Keep examples **optional and removable**; don't make a step depend on heavy few-shot if it may run on a reasoning model.                                                   |
| **Role message naming**                  | `system` field (+ user/assistant)                                                                                                                                                                  | `developer` (replaces system for o-series/current) with priority over `user`; `instructions` param                                                                           | Keep role/system content in its **own block** so each binding maps it to the right role name.                                                                              |
| **Self-verification**                    | "Ask Claude to self-check" helps (except Opus 5, which over-verifies — remove the instruction)                                                                                                     | Reasoning models verify internally; don't force it                                                                                                                           | Ask for a verified _result_, not a mandated verification _process_; let effort/model decide.                                                                               |
| **Reasoning-depth control**              | `effort` parameter + adaptive thinking (`budget_tokens` deprecated)                                                                                                                                | Reasoning-effort / model choice; developer message                                                                                                                           | This is a **binding/config concern, not prompt text** — keep it out of the neutral `.md`.                                                                                  |
| **Long-context instruction placement**   | Data at top, single query at end                                                                                                                                                                   | GPT-4.1: repeat instructions at start **and** end                                                                                                                            | Repeating the key instruction at the end is safe for both — the superset works everywhere.                                                                                 |

---

## E. Implications for yoke's provider-neutral prompts

Concrete rules for authoring `prompts/*.md` step prompts that run well under **both** Claude and
GPT. Each rule is justified by a cited technique from A/B/C/D.

**Rules that are unambiguously portable (adopt these as the house style):**

1. **Open with a clear, explicit objective and the exact output/format/constraints** — written so a
   colleague with no context could execute it. _(A-1 golden rule; B.1-1 / B.2 literal following;
   B.3 "brief, clear instructions".)_
2. **Phrase instructions as positive imperatives** ("Do X", "Change Y"), not prohibitions; use a
   numbered list when order or completeness matters. _(A-7 tell-what-to-do + A-1 sequential steps;
   B.4-1 specify the steps.)_
3. **Structure the prompt with XML tags** for each distinct block — `<instructions>`, `<context>`,
   `<input>`, `<examples>`, and an `<output_format>` or output tag for the result. Optionally mirror
   with Markdown headings. **Do not use JSON as the prompt scaffold.** _(A-4 XML; B.1-4 / B.2 XML
   accepted, JSON underperforms; D row 1.)_
4. **Keep the role / system instructions in their own block**, separate from task/user content, so
   binding A maps it to Claude `system` and binding B maps it to OpenAI `developer`. Don't bake role
   text into the user body. _(A-5; B.1-2; D row 5.)_
5. **Put long/reference material at the top and the actual task at the end**; for very long prompts,
   restate the one key instruction at the end too. _(A-6 data-at-top/query-at-end; B.2 begin-and-end;
   D row 8 — the superset is safe.)_
6. **When reference material is included, instruct the step to ground its answer in it** (quote/cite
   the relevant parts before answering). _(A-6 ground-in-quotes; B.1-6 RAG / B.4-2 reference text.)_
7. **Prefer restrained, firm phrasing over shouting.** No walls of all-caps or "CRITICAL: YOU MUST";
   current models over-trigger / turn over-literal. _(A-9 dial-back "MUST"; B.2 avoid all-caps.)_
8. **Make action steps explicitly imperative.** If the step must edit files or run something, say so
   directly ("Change…", "Run…", "resolve the full task before yielding") — not "could you suggest".
   Include the persistence + tool-use + planning intent for agentic steps. _(A-9 explicit action;
   B.1-8 / B.2 persistence + tool-calling + planning.)_
9. **State success criteria / "what done looks like" explicitly**, and ask for a verified result —
   without prescribing a visible reasoning process (see the flag below). _(A-10 self-check; B.3 be
   explicit about constraints.)_
10. **Never use assistant prefill** as a mechanism; it errors on Claude 4.6+ and isn't an OpenAI
    concept. Constrain output via explicit format instructions / XML output tags. _(A-8; D row 2.)_
11. **Keep effort/thinking/reasoning-depth in the binding, not the prompt.** The neutral `.md`
    carries task intent; each binding sets Claude `effort`/adaptive-thinking or OpenAI
    reasoning-effort/model. _(A-10; B.3; D row 7.)_
12. **Version prompts in the repo and back them with evals before changing them.** _(Anthropic
    overview "empirically test"; B.1-3 version-in-code + tests; B.4-6.)_

**Places where a single prompt genuinely cannot be optimal for both — flag honestly:**

- **Chain-of-thought wording (the big one).** If a yoke step can run on _either_ a reasoning model
  or a non-reasoning model, you cannot bake "think step by step / explain your reasoning" into the
  shared text: it _helps_ non-reasoning GPT-4.1 but is _discouraged and may hurt_ reasoning models on
  **both** vendors (OpenAI reasoning "avoid CoT"; Anthropic "prefer general instructions", avoid the
  word "think" when thinking is off). **Mitigation:** phrase for the _outcome_ ("Produce a short plan,
  then the implementation" / "Return a checked answer") rather than mandating internal reasoning; or
  template the CoT line per-binding/per-model so it's injected only for non-reasoning targets.
  _(D row 3.)_
- **Few-shot volume.** Reasoning-model targets prefer zero-shot; non-reasoning targets benefit from
  3–5 examples. Keep `<examples>` **optional/removable** so a reasoning binding can drop them.
  _(D row 4.)_
- **Self-verification.** Asking for an explicit self-check helps some Claude/GPT models but is
  redundant on reasoning models (and over-verifies on Opus 5). Prefer asking for a _verified result_
  over a mandated verification _procedure_. _(D row 6.)_

**Net recommendation for yoke:** author the neutral canon as **XML-tagged blocks** (role/system,
instructions, context, input, examples, output-format), with **positive imperative instructions,
explicit success criteria, reference-grounding, and boundary-anchored placement** — and treat
**chain-of-thought instructions, few-shot examples, and reasoning-depth** as **binding-injected,
model-conditional** rather than hard-coded in the shared prompt. That keeps the portable core in the
`.md` and pushes the genuinely divergent knobs into the thin bindings, which is exactly where yoke's
architecture already puts provider differences.

---

## Sources consulted (primary vendor docs)

Anthropic:

- Prompt engineering overview — `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview`
- Prompting best practices (consolidated reference; classic sub-pages redirect here) — `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices`
- Verified redirects: `.../prompt-engineering/be-clear-and-direct` and `.../multishot-prompting` → `claude-prompting-best-practices`; `docs.claude.com` → `platform.claude.com`.

OpenAI (current, live):

- Prompt engineering guide — `https://developers.openai.com/api/docs/guides/prompt-engineering`
- Reasoning best practices — `https://developers.openai.com/api/docs/guides/reasoning-best-practices`
- GPT-4.1 prompting guide (Cookbook) — `https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide`

OpenAI (legacy, redirected — six-strategy framework, per-tactic detail _unverified against live page_):

- `https://platform.openai.com/docs/guides/prompt-engineering` (now 301 → the developers.openai.com guide above)

_Unverified items are marked inline. The six-strategy tactic detail could not be re-fetched from a
live OpenAI URL because the page was restructured and web.archive.org is blocked in this
environment; strategy names and the reference-text / time-to-think descriptions are confirmed by
OpenAI's own surfaced summary, and strategy 6 is corroborated by the live "Version prompts in code"
section._
