# Research: Jev (TypeSafe AI) — the API contract, what is actually guaranteed, and where it fits agent-flows

Date: 2026-09-21. Question: is Jev, TypeSafe AI's "System One" model, a useful component for
agent-flows — specifically for gate judging, entry-point selection, code-review classification and
pre-screening — and what exactly does it guarantee?

Every claim below is cited to a primary source (TypeSafe's own docs page + heading, the official SDK
source, or a live probe) unless marked **UNVERIFIED**. Secondary coverage (DataCamp, Vercel,
LangChain, MindStudio, dev.to) was used only to locate primary pages and is cited nowhere else.
Notation: "P" = primary, "S" = secondary; see the Sources block at the end.

---

## 1. What Jev is

- Jev is TypeSafe's flagship model and "the first System One model". It "returns typed decisions and
  probabilities rather than generated text" (P8). Current version `jev-1.13.0`, released under the
  aliases `jev-latest` and `jev-preview`, both currently pointing at `jev-1.13.0` (P2).
- Announced 2026-09-15 by Diogo Almeida in "Introducing System One Models & Jev" (P10). The framing:
  "Think of Jev as a frontier-intelligence function call: unstructured state in, typed probabilistic
  decisions out." (P10)
- Training path is called **RLCD** — "Reinforcement learning for calibrated decisions" — presented
  alongside RLHF and RLVR: "The model does not generate text. It returns decisions and probabilities.
  Higher probability should correspond to a greater chance that the answer is correct." (P9)
- It is not fine-tuned per account: "Jev is not fine-tuned or LoRA-adapted with customer data […] the
  same weights serve every account." Domain adaptation happens through `state`, `instructions` and
  `criteria` only (P2).

The secondary framing in the brief ("System One", 70–500ms, $0.042/MTok, cannot hallucinate) is
substantially accurate but each part has a primary-source nuance — see §3 and §5.

## 2. The verified API contract

One endpoint (P1):

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

Request body: `state` (string | object | array, required), `model` (string, required),
`questions` (map<string, Question>, required — "A key you choose. The matching Answer is returned
under this same id. The key is not sent to the underlying model and is not used in inference.") (P1).

There are exactly **three** question types. From the official JS SDK's `src/types.ts` at tag `v0.6.0`
(P11) — these are the authoritative type definitions:

```ts
export interface NoulQuestion {
  type: "noul";
  instructions?: EntryType;
  criteria?: { true?: EntryType; false?: EntryType } | null;
}

export interface ChoiceQuestion<T extends ChoiceCriteria = ChoiceCriteria> {
  type: "choice";
  instructions?: EntryType;
  criteria: T; // { [label: string]: Description }
}

/** At least two descriptions indexed by score from zero; `null` leaves a score undescribed. */
export type ScoreCriteria = readonly [EntryType, EntryType, ...EntryType[]];

export interface ScoreQuestion<T extends ScoreCriteria = ScoreCriteria> {
  type: "score";
  instructions?: EntryType;
  criteria: T;
}

export type Question = NoulQuestion | ScoreQuestion | ChoiceQuestion;
```

And the answers (P11):

```ts
export interface NoulResponse {
  readonly type: "noul";
  readonly noul: number;
}
export interface ChoiceResponse<T> {
  readonly type: "choice";
  readonly choice: keyof T & string;
  readonly confidence: number;
  readonly probabilities: { readonly [label in keyof T]: number };
}
export interface ScoreResponse<T> {
  readonly type: "score";
  readonly score: number; // expected value; may fall between levels
  readonly confidence: number;
  readonly legend: ScoreLegend<T>;
  readonly probabilities: { readonly [score in ScoreOf<T>]: number };
}
export interface SystemOneResult<Q extends Questions> {
  readonly model: string;
  readonly answers: { readonly [K in keyof Q]: ResultFor<Q[K]> };
  readonly usage: Usage; // { input_tokens, output_tokens }
}
```

Mapping to the decision shapes the brief asked about:

| Wanted                                | Jev support        | How                                                                                                                             |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| single-label classification           | yes                | `choice`, up to 255 options (P5)                                                                                                |
| boolean / support estimation          | yes                | `noul`, returns P(yes) as a float; no `confidence` field (P1, P7)                                                               |
| ordinal rating against a rubric       | yes                | `score`, "at least two levels; the API accepts up to 10" (P6)                                                                   |
| multi-choice (several labels at once) | **no**             | one Choice returns ONE label; docs' pattern is one Noul per label (P3, "Common-sense structural invariants")                    |
| ranking                               | **no native type** | done by one question per candidate + sorting in code (P18 re-ranking cookbook)                                                  |
| tool selection                        | yes, as `choice`   | it is single-label classification over a known set                                                                              |
| free-form extraction                  | **no**             | "when the answer space is bounded, turn extraction into a Choice over the options rather than asking for the value itself" (P3) |

Response is `{model, answers, usage:{input_tokens, output_tokens}}`; errors are `401`, `422`, `429`,
`529` with a JSON body (P1). `GET /v1/models` lists the names the account may send (P2).

Official clients: `pip install typesafe-sdk` (Python ≥3.10) and `npm install @typesafe-ai/sdk`
(Node ≥20); both read `TYPESAFE_API_KEY` from the environment and default to `jev-latest` (P12, P16).

**No official CLI exists.** The `typesafe-ai` GitHub org contains `typesafe-sdk-python`,
`typesafe-sdk-js`, `skills`, `system-one-adapter-python` and infra repos — no CLI (P13). Of the leads
given: `tumf/jev-cli` states in its own README "**Unofficial:** This is an independent community
project. It is not affiliated with, maintained by, or endorsed by TypeSafe AI." (P14);
`Nasrallah-AL/jev-cli` is the source of `npm i -g jevctl` (npm `jevctl` homepage points at that repo,
author "Nasr Shaer", MIT) (P19); `MrJev/jev-cli` is a GitHub **fork** of that repo (P13b). All three
are third-party. TypeSafe's own agent-facing artifact is a _skill_, not a CLI:
`claude plugin marketplace add typesafe-ai/skills` (P20).

## 3. What is guaranteed vs what is claimed

This is the load-bearing part. The two halves of the headline claim have very different standing.

**Guaranteed (structural, and stated as such):**

- Output-space closure. "Every answer is constrained to the options you supplied. The model returns a
  probability distribution over your options or levels, never a value outside them. Your code never
  has to recover a value from generated prose." (P4)
- Type conformance. "Possible outputs and structure are defined in advance. The model never makes
  type errors." (P10) TypeSafe is explicit that this number is not measured: "Our number is not
  empirical. **Schema matching is guaranteed**, thus we can confidently add 0% into the plots." (P10)
  and, in the evidence section, "No type errors: This would be an easy thing to falsify with just a
  single counter-example, but it is mathematically impossible." (P10)
- Independence between questions. "Every answer is independent. One question's answer is not hidden
  context for another. You can add or remove questions without changing the others' results." (P4)

**Not guaranteed (statistical or unstated):**

- Correctness of any single answer. "Calibration is measured across groups of predictions; it does
  not guarantee that an individual answer is correct." (P8) and "These rates describe groups of
  predictions, not a guarantee about any single answer." (P9)
- Confidence 1.0 does not mean correct: "confidence 1.0 means the returned distribution puts all its
  probability on one level. This describes the model's answer, not a guarantee that the answer is
  correct." (P6)
- Resistance to adversarial input. "State is data, and `jev-1.13` does not treat it as hostile by
  default. Content written to adversarially steer the model […] can move the answer. We expect to
  improve on this in the future." (P3)
- Arithmetic/logical consistency between related questions. The jaggedness page shows P(noul) and
  1 − P(negated noul) summing to 1.19 on a real example, and a Noul at 0.22 against a yes/no Choice
  at 0.01 for the same question — "don't hold the model to arithmetic identities between separate
  questions." (P3)

**So: "cannot hallucinate" means "cannot emit a token outside your declared answer space".** It is a
claim about the shape of the output, not about the content of the judgement. A wrong label is still
available to it — the model simply returns a wrong member of your enum with a probability attached.
For our purposes that is precisely the distinction that matters (see §6.3).

## 4. Limits — what it does not do

All from the official Models page (P2) and the official jaggedness page (P3):

- **Context:** 64k tokens per request total, and 32k for `state` plus the single longest question (P2).
- **Rate limits:** 250,000 tokens/second and 1,200 requests/minute, over either → `429`. Explicitly
  unstable: "the limits above can change without notice" (P2).
- **Input modality:** text only — string, JSON object, or array of text values. No image, audio or
  video (P2, P8).
- **Cardinality:** Choice ≤ 255 options (P1, P5); Score ≥ 2 and ≤ 10 levels (P6). The blog notes
  higher-cardinality demos were done with "a 2 stage-system of scoring independently then making an
  explicit choice, hence the occasional slowdown" — i.e. that is caller-side, not a model feature (P10).
- **Language:** "English is the primary training language and where accuracy is currently best. Other
  languages, including CJK scripts, are handled but not equally well" (P2).
- **No generation at all.** "`jev-1.13` is not trained to generate text. While you can force it to by
  chaining choices, this will not work well and will be very slow." (P3)
- **Stated unsuitability** (P3, nine named failure modes): literal reading of the instruction; counting
  and arithmetic ("Jev is not a calculator"); date/time comparison ("reads dates as text, not as
  ordered quantities"); indirection ("a property of a property or something that requires multiple
  hops of reasoning costs accuracy"); **large state full of irrelevant detail** ("Accuracy falls as the
  state grows with content unrelated to the decision […] Jev suffers from context rot"); adversarial
  content; contradictory instructions vs criteria; structural non-invariance; generation.
- **Can it see code/diffs meaningfully?** Partially and indirectly. Code is text, and the docs' own
  examples include "detecting a programming language" as a Choice (P4). But: "questions about
  high-level programming languages will perform better than questions about low level assembly, or
  binary encoded instructions" (P3), and it has **no tools** — no file read, no grep, no repo access.
  Whatever it judges must be pasted into `state` inside 32k tokens. There is no primary-source claim
  about Jev on diffs specifically: **UNVERIFIED**.
- **Latency vs input size:** the only published latency figure is "End-to-end response time is
  70ms-500ms" from the launch post (P10), with the caveat "our published evals are generally run from
  our laptops on the West Coast (this is where our service is currently based)". No latency-vs-token
  curve is published: **UNVERIFIED**. The docs do state that _question count_ is nearly free —
  "Adding questions barely changes the response time because they run in parallel within one request"
  (P4, P17).

## 5. Pricing and access

- **Price:** `jev-1.13.0` — "$42 / $0.042" per Btok / Mtok, "Charged per input token. Output tokens
  are free." (P2). The launch post states the same: "Input tokens: $0.042 / MTok ($42 per billion
  tokens). Output tokens: FREE (too cheap to meter)." (P10). There is no separate pricing page; the
  Models doc page is the pricing page.
- **Auth:** `Authorization: Bearer <API_KEY>`; keys from `https://console.typesafe.ai/keys`; SDKs read
  `TYPESAFE_API_KEY` from the environment (P1, P12). Console login is Google or email code (P21).
- **Access:** early access with a waitlist — "Today, we are opening early access and bringing
  developers off the waitlist as quickly as we can." (P10). Higher limits "available on custom and
  enterprise plans" via sales@typesafe.ai (P2).
- **Free tier:** no free tier, trial or free credits are documented anywhere in the docs or on the
  site — **UNVERIFIED** (absence of evidence; not evidence of absence).
- **Data handling:** "Jev is not trained on customer requests or responses"; zero data retention
  offered to enterprise customers only (P2, P22).

## 6. Could we reach it through our existing `api` transport? No.

Concretely, `src/canon/adapters/api.ts:37-40` builds an OpenAI chat-completions body
(`{model, messages:[{role:"user", content: prompt}]}`) and `:69-71` reads
`json.choices?.[0]?.message?.content`, throwing when it is not a string. Jev's endpoint accepts
`{state, model, questions}` and returns `{model, answers, usage}` (P1) — no `messages`, no `choices`,
no string content anywhere in the response. Pointing a `ModelEntry.api.endpoint`
(`src/canon/registry.ts:11`) at `https://api.typesafe.ai/v1/systemone` would produce a `422` from
TypeSafe, and even a hypothetical success would fail our own `missing choices[0].message.content`
guard.

Live probe (2026-09-21, unauthenticated, P15):

```
POST https://api.typesafe.ai/v1/systemone        → 403 {"detail":{"error_type":"authentication_error",…}}
POST https://api.typesafe.ai/v1/chat/completions → 404 {"detail":"Not Found"}
```

The `403`-vs-`404` split is the useful bit: the auth layer answers on the real route, so the `404` on
`/v1/chat/completions` is a genuinely absent route rather than a blanket rejection. **There is no
OpenAI-compatible surface.**

What a real integration would cost, precisely:

- `ProviderAdapter` (`src/canon/adapters/types.ts:45,54-59`) declares `id: "claude" | "codex" | "api"`
  and `run(prompt: string, …): Promise<string>`. Jev's call is not prompt→string; it is
  (state, questions)→typed answers. It does not fit this seam without either (a) widening the seam, or
  (b) a lossy shim that JSON-stringifies answers back into a string for the existing pipeline plumbing.
- `ModelTransport` is `"cli" | "api"` (`src/canon/registry.ts:5`); the literal `"api"` appears across
  ~10 non-test files including `src/doctor.ts`, `src/canon/loadProviders.ts`,
  `src/runtime/artifactStore.ts`, `src/runtime/stepIntrospection.ts`, `src/runtime/runService.ts` and the providers UI
  (`src/serve/ui-providers.js`). A third transport touches all of them.
- Capabilities are already correct for it: like `api`, a Jev transport would report
  `workspaceRead:false, workspaceWrite:false, budgetCap:false, stepDenyPatterns:false`
  (`src/canon/adapters/api.ts:111-121`), and `runApiTransportStep:91-97` already refuses
  `permissions.contents` for api transport — Jev has no workspace either, so that refusal is right.

Note also `typesafe-ai/system-one-adapter-python` (P23), a first-party "drop-in `TypeSafeClient`
replacement backed by LLM APIs" — it exists to run the _System One shape_ on OpenAI/Anthropic for
cost/speed comparison. It is the inverse of what we would want and is Python-only, but it is the
cheapest way to A/B a Jev-shaped question set against our current models without an API key.

## 7. Fit assessment for agent-flows

### 7.1 Gate judging (`runJudgeCore`, `src/runtime/runService.ts:1135`) — **partial fit, would need a split**

What is there: `buildJudgePrompt` (`:1262-1292`) concatenates the judge prompt with untrusted gate
material (pipeline id, gate question, a spec payload capped at 64 KiB — `JUDGE_SPEC_CAP`, `:366`, and
`git status --porcelain`). `runJudgeCore:1173-1196` runs the reasoner and calls `parseVerdict`
(`:1300`) which requires `{verdict: "approve"|"reject", reason: <non-empty string>}`; one retry with a
"[PARSE ERROR …]" suffix, then judge failure → `degradeToManual`.

- What Jev replaces: the JSON-shaped verdict token. A `choice` over `{approve, reject}`, or a `noul`
  ("does this gate material satisfy the pipeline's acceptance criteria?"), makes the malformed-verdict
  branch unreachable _by construction_ (P4) and gives us a calibrated number to threshold, which is
  strictly more information than the current binary. TypeSafe's own confidence-gated routing pattern
  is exactly this shape (P24).
- What breaks: `parseVerdict` requires a **non-empty `reason` string**, and that reason is persisted
  into `GateDecision` and surfaced to the operator. Jev cannot produce it — "not trained to generate
  text" (P3). So Jev cannot replace the judge; it could only be a _pre-decision_ in front of it, or
  the judge would have to lose its reason field, which is a regression in auditability.
- Second problem: the judge runs with `contentsAccess: "read"` and `workspaceDir` for CLI transports
  (`:1161-1166`) — it reads the repo. Jev cannot. The gate judge is a System Two task by design.
- The 64 KiB spec cap is roughly 16k tokens, inside Jev's 32k state budget, so size is not the blocker.
- **Verdict:** not a replacement. A defensible _narrow_ use is a cheap pre-filter: one `noul` for
  "does this gate material contain an instruction directed at the reviewer?" over the untrusted
  `GATE_MATERIAL` block before it reaches the reasoner — TypeSafe names "detect jailbreaks of LLM
  prompts" as a use case (P10), though they also concede Jev itself is steerable by adversarial state
  (P3), so it is defence in depth, never a boundary.

### 7.2 `decide_entry_point` — **bad fit; the premise in the brief is wrong**

`src/runtime/entryPoint.ts` is **not** an LLM classifier. Its header says so: "FR-005 — deterministic
entry-point selection for stage pipelines. **Never calls a model**; the rule is an inspectable
function, not a model guess." (`:1-3`). It branches on explicit `kind`, then on whether the input is an
existing path, then on JSON artifact signatures (`spec`+`gateDecisions` → develop; `findings`|`plan` →
spec-creation), and free text falls to a fixed conservative default (`:132-137`). The MCP tool
(`src/bindings/mastra/server.ts:173-205`) is a thin proxy to `POST /api/runs/decide`
(`src/serve/server.ts:1806-1828`).

Putting Jev here would replace a pure, instant, testable function with a network call, a probability
and a new failure mode, to answer a question that has an exact answer. **Do not.**

The one honest opening: branch 3 does not classify at all — _all_ free text routes to `investigate`.
If we ever want free text routed across the real pipeline set rather than defaulted, that is a genuine
single-label classification over a closed set of pipeline ids and is Jev's canonical use case (P25,
intent routing). But it is new behaviour, not a replacement, and it must stay behind the existing
`reason` string plus operator correction. Low value; the default is cheap and already correctable.

### 7.3 code-review classification (`codeReviewFindings`, `src/canon/schemas.ts:26-68`) — **fixes a real gap, but not the one that hurt us**

Two separate things are worth separating here.

**(a) The enum-conformance gap is real and currently unguarded.** Our schema enforcement is a prompt
suffix plus a top-level key check, nothing more. `src/bindings/mastra/buildSteps.ts:471-478` appends
"Return ONLY a valid JSON object matching this JSON Schema…", and `tryParseSchemaOutput` (`:197-215`)
checks only `JSON.parse` succeeded and `schemaKey in parsed`. **No enum, no required-field and no
`additionalProperties` check ever runs.** A finding with `"severity": "moderate"` or a missing
`severityRationale` passes today, silently, and lands in the artifact. Downstream, `parseJsonFindings`
(`src/evals/scorers.ts:398-423`) reads the fields defensively and `reviewSeverity` (`:756`) ranks an
unparseable severity as 0. With a Jev `choice`, `severity ∈ {blocking, major, minor}` is closed by
construction (P4) and one retry path disappears. That is a genuine improvement — but note it can also
be had for free today by validating the JSON Schema we already ship in `src/canon/schemas.ts`. **An
Ajv call is the cheaper fix for the format half.**

**(b) The judgement half — which is the half that actually cost us two benchmark runs — Jev does not
address.** Spec 040's own diagnosis is explicit: "in benchmark run 1 all 13 findings arrived `minor`,
including a `falsifiability` finding raised `major` with a neutering-edit argument" (D11,
`specs/040-code-review-execution/spec.md:160-169`), and D13: "Prose guidance moved a quantitative
behaviour — the verifier's hedging rate — but moved neither structural behaviour. […] Where the wanted
behaviour is structural, the instrument has to be a contract." Nothing in run 1 or run 2 was a
malformed enum. The failures were a **correct-typed wrong value** and a **displaced finding**. Jev's
guarantee is the shape, not the value (§3). A Jev `score` over an explicit severity rubric would
return a calibrated distribution instead of a bare label, which is more information than a label plus
a `severityRationale` string — and D13's "a field that cannot be left silent" reasoning applies just
as well to a probability that cannot be left flat. But:

- `verify` is `role: reasoner` with `permissions.contents: read` and exists to adjudicate each claim
  **against the repository** (`pipelines/code-review.yaml:57-64`). That is multi-hop indirection over
  files Jev cannot open. Jev's own jaggedness page lists indirection and large irrelevant state as
  failure modes (P3). Handing it the 27–41 KB of verify output we actually produce
  (`src/evals/fixtures/__fixtures__/verify-2026-09-13*.json`) plus a diff would push it toward the 32k
  state ceiling with exactly the "large state full of irrelevant detail" profile the docs warn about.
- The `severityRationale` string that D13 made required is **text**. Jev cannot emit it. Splitting
  severity off to Jev means the rationale and the severity are produced by different models, and the
  rationale would no longer be the reasoner's account of its own decision.

**Verdict:** a defensible _narrow_ experiment is Jev as a **second opinion on severity only** — feed
each already-verified finding (claim + quote + probes, one finding per call or batched as parallel
questions) as `state` and ask one `score` against the blocking/major/minor rubric, then flag
disagreement with the reasoner's label in `synthesis`. That is a falsifiable, additive check that
costs almost nothing and would have caught run 1's uniform-minor collapse. It is **not** a replacement
for `verify`, and it should not be sold as fixing the silent downgrade — it would surface the
downgrade, not prevent it.

### 7.4 Pre-screening worker findings before `verify` — **the best fit in this repo, with one caveat**

Today `verify` (`role: reasoner`) receives everything `correctness`, `security` and `falsifiability`
raised and adjudicates all of it. Run 1 produced 13 findings, most of which died at `verify`.
Pre-screening is exactly what the docs' own "classifying RAG passages" / relevance-filter pattern is
for (P3, "Large state full of irrelevant detail" → "you can use a Noul to filter for relevance").

- Shape: one `noul` per candidate finding — "Is this finding about a line inside the diff under
  review?", "Does this finding restate an already-listed finding?" — batched as parallel questions in
  a single request against the diff as `state`. Adding questions is nearly free (P4, P17).
- Cost: negligible. At $0.042/MTok input with free output (P2), screening a 10k-token diff with 20
  questions is fractions of a cent, versus a reasoner pass.
- What breaks: it is a **network dependency inside a pipeline step**, and we have no transport for it
  (§6). It would need the adapter work, an API key in the daemon's environment, and a failure policy
  — the honest default being "screen fails → pass everything through", never "screen fails → drop".
- Caveat, and it is the same one D12 raises: a screen that drops a finding is a displacement
  instrument. D12's metric — "retained baseline findings alongside added ones […] **This is the metric
  that matters**" (`specs/040-code-review-execution/spec.md:184-188`) — is exactly the metric a
  pre-screen can quietly wreck. It must be benchmarked against the same baseline set before it is
  allowed to drop anything, and shipped first in _annotate-only_ mode.

### 7.5 Eval scorers (`src/evals/scorers.ts`) — **real fit, but it would cost us determinism**

`matchAll` (`:381-394`) matches an expectation to a finding by requiring every keyword to be a
substring of the finding text. That is brittle semantic matching done with `includes()` — precisely
what TypeSafe's re-ranking and semantic-find cookbooks use a Noul/Choice for (P18). And
`severityDropAccountedFor` (`:737-741`) is a length floor plus a substring check, with a comment that
states the limit outright: "Deliberately not a judgement of whether the reason is GOOD: no offline
scorer can make that call, and pretending to would make the gate unfalsifiable in the other
direction."

Jev _could_ make that call. But the scorers' docstrings advertise "Pure and offline: no model call, no
file read" (`:490-497`, `:743-755`), and that purity is why the evals are trustworthy gates. Putting a
remote calibrated model inside a scorer means the gate's verdict can move without our code changing —
including via a silent `jev-latest` alias move (P2 explicitly warns: "an alias moves when a new
release ships, so the answers behind it can change without a change on your side"). **Not worth it for
the gate itself.** Worth it as a separate, clearly-labelled _diagnostic_ run alongside the pure
scorer, where disagreement between the two is the signal.

### 7.6 Places it does not fit at all

- `check` steps (`DEFAULT_CHECK_COMMAND`, `src/bindings/mastra/buildSteps.ts:41-42`) — these run the
  project's real gate. Deterministic, already correct.
- Anything needing prose: `reason` on gate decisions, `severityRationale`, `correctedWording`, the
  whole `synthesis` step. Jev cannot write text (P3).
- Anything needing repo access: every `permissions.contents: read` step. Jev has no tools.
- Date/version/count logic anywhere — explicitly a Jev failure mode (P3).

### 7.7 Summary table

| Candidate                         | Replaces                      | Better than what's there?                                                         |
| --------------------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| Pre-screen worker findings        | nothing (new step)            | **Yes, probably** — cheap, additive, benchmarkable; must ship annotate-only first |
| Severity second opinion at review | nothing (new check)           | **Maybe** — surfaces the downgrade, does not prevent it                           |
| Injection screen on gate material | nothing (new check)           | **Maybe** — defence in depth only, never a boundary                               |
| Gate judge verdict                | `parseVerdict` retry loop     | **No** — loses the `reason` and the repo read                                     |
| `codeReviewFindings` enums        | prompt suffix + key check     | **No** — Ajv on the schema we already ship is cheaper and offline                 |
| `decide_entry_point`              | a deterministic pure function | **No** — strict regression                                                        |
| Eval scorers                      | offline substring matching    | **No** for the gate; yes as a side-by-side diagnostic                             |

Ordered honestly: one candidate worth building, two worth an experiment, four to leave alone. And the
prerequisite for any of them is §6 — a new transport, because our `api` adapter cannot reach Jev.

## 8. What I could NOT verify against a primary source

1. **"Cannot hallucinate" as a correctness claim.** The blog asserts Jev "can't hallucinate" (P10) but
   the only substantiation given is schema conformance ("Schema matching is guaranteed"), and the docs
   repeatedly disclaim per-answer correctness (P8, P9, P6). No primary source defines "hallucination"
   for a model that emits no text. Treat the popular framing as marketing shorthand for §3's
   structural guarantee.
2. **The 70–500ms latency figure is not reproducible from here** and has no published curve against
   input size or question count. It comes from the launch post only (P10), self-measured "from our
   laptops on the West Coast". No latency SLO appears in the docs.
3. **The 40×–200× / 193.6× / 444.6× speed and cost multipliers** are TypeSafe's own workflow-eval
   methodology, with reference answers taken from "the average of GPT-6 Astra and Fable 5.1" and
   workloads "made by individuals on our model capabilities team" (P10, their own caveat). Not
   independently reproduced; not reproducible without early access.
4. **Whether a free tier, trial or free credits exist.** Nothing in the docs or on the site. The
   console is a login wall (P21). Unknown.
5. **Current waitlist status / whether new signups get keys.** "Early access", "bringing developers
   off the waitlist as quickly as we can" (P10) — as of 2026-09-21 no primary statement of general
   availability exists.
6. **Any hard cap on the number of questions per request.** The docs describe only the shared 64k
   token budget (P2) and say question count barely affects latency (P4, P17). No count limit is stated
   either way.
7. **Behaviour on code diffs specifically.** No primary source evaluates Jev on source code or diffs.
   Everything in §7 that depends on that is a hypothesis to be benchmarked, not a finding.
8. **The launch post's FAQ answers** ("How does Jev perform against public benchmarks?", "Where does
   our training data come from?") are collapsed accordions whose bodies are not present in the served
   HTML. Not read.
9. **Nothing here was run against the live API.** No API key was used; the only live calls were the
   unauthenticated route probes in P15. Every request/response shape above comes from the docs and the
   official SDK source, not from an observed round trip.

---

## Sources

Primary:

- P1 https://docs.typesafe.ai/api.md — "## Evaluation endpoint", "## Request body", "## Question
  types", "## Response body", "## Answer types", "## Errors"
- P2 https://docs.typesafe.ai/models.md — "## Current models" table (price, rate limits, context
  length, input), "## Aliases", "## Customizing Jev", "## Language support", "## Data handling",
  "## Listing models"
- P3 https://docs.typesafe.ai/model-jaggedness/jev-1.13.md — "## The failure modes in detail" and each
  named subsection (Literal reading, Math and Numbers, Date and time comparison, Indirection, Large
  state full of irrelevant detail, Adversarial content, Contradictory instructions and criteria,
  Common-sense structural invariants, Generation). Note dated "Last reviewed 2026-09-17".
- P4 https://docs.typesafe.ai/primitives.md — "## What comes back" (the two composability bullets),
  "Send every question that uses the same state in one request"
- P5 https://docs.typesafe.ai/primitives/choice.md — "A Choice question accepts up to 255 options"
- P6 https://docs.typesafe.ai/primitives/score.md — "at least two levels; the API accepts up to 10";
  "confidence 1.0 […] describes the model's answer, not a guarantee that the answer is correct"
- P7 https://docs.typesafe.ai/confidence.md — "## Confidence is derived from the probabilities";
  "(Noul answers don't carry one.)"; "## Thresholds scale with risk"
- P8 https://docs.typesafe.ai/concepts/system-one.md — "## How it differs from an LLM"
- P9 https://docs.typesafe.ai/introduction/machine-learning-primer.md — "## RLCD and calibrated
  decisions"
- P10 https://typesafe.ai/blog/introducing-system-one-models-and-jev — launch post, 2026-09-15:
  "Frontiers, Old and New" table, "Evidence / Technical Results", "Hallucination and Type-safety",
  "Wikiracing" nuance (cardinality 255), "What's next" (early access / waitlist)
- P11 https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts — `NoulQuestion`,
  `ChoiceQuestion`, `ScoreQuestion`, `ScoreCriteria`, `NoulResponse`, `ChoiceResponse`,
  `ScoreResponse`, `SystemOneRequest`, `SystemOneResult`, `RetryPolicy`
- P12 https://docs.typesafe.ai/introduction/quickstart.md — "## Call it: the API", "## Code it: the
  Python SDK", playground and keys URLs
- P13 https://api.github.com/orgs/typesafe-ai/repos — full repo list of the official org (2026-09-21);
  P13b https://api.github.com/repos/MrJev/jev-cli — `"fork": true`
- P14 https://raw.githubusercontent.com/tumf/jev-cli/main/README.md — "**Unofficial:** This is an
  independent community project."
- P15 Live probe, 2026-09-21: `POST https://api.typesafe.ai/v1/systemone` → `403`
  `authentication_error`; `POST https://api.typesafe.ai/v1/chat/completions` → `404 {"detail":"Not
Found"}`; `POST /v1/models` → `405`
- P16 https://docs.typesafe.ai/sdk/javascript.md — `npm install @typesafe-ai/sdk`, Node ≥ 20
- P17 https://docs.typesafe.ai/patterns/fan-out.md — "All questions are evaluated in parallel, so
  adding more questions usually has little effect on response time."
- P18 https://docs.typesafe.ai/cookbooks/rerank_typesafe.md and
  https://docs.typesafe.ai/cookbooks/semantic_find.md (index entries in llms.txt) — one question per
  query-candidate pair for re-ranking; line-id scoring for semantic search
- P19 https://registry.npmjs.org/jevctl — `jevctl@0.2.3`, `homepage:
https://github.com/Nasrallah-AL/jev-cli`, author "Nasr Shaer", MIT, `bin: {jev: dist/cli.js}`
- P20 https://docs.typesafe.ai/agent-skill.md — `claude plugin marketplace add typesafe-ai/skills`
- P21 https://console.typesafe.ai/ → redirects to `/login` (Google or emailed code)
- P22 https://docs.typesafe.ai/legal.md — DPA, MCA, ZDR for enterprise
- P23 https://github.com/typesafe-ai/system-one-adapter-python — README, "A drop-in replacement for
  `typesafe_sdk`'s `system_one` evaluation API, backed by LLM APIs instead of TypeSafe."
- P24 https://docs.typesafe.ai/patterns/confidence-routing.md (index entry in llms.txt)
- P25 https://docs.typesafe.ai/patterns/intent-routing.md (index entry in llms.txt)
- P26 https://docs.typesafe.ai/llms.txt — full documentation index used to enumerate pages
- This repo, read directly: `src/canon/adapters/api.ts`, `src/canon/adapters/types.ts`,
  `src/canon/registry.ts`, `src/canon/schemas.ts`, `src/bindings/mastra/buildSteps.ts`,
  `src/bindings/mastra/server.ts`, `src/runtime/runService.ts`, `src/runtime/entryPoint.ts`,
  `src/serve/server.ts`, `src/evals/scorers.ts`, `pipelines/code-review.yaml`,
  `specs/040-code-review-execution/spec.md`

Secondary (used only to locate the primary pages; not relied on for any claim):

- S1 datacamp.com/blog/system-one-models-jev, vercel.com/i/what-is-jev,
  langchain.com/blog/building-a-harness-with-jev, mindstudio.ai/blog/jev-system-one-model-launch,
  flaviocopes.com/jev/, dev.to/valyuai/… — WebSearch results for "TypeSafe AI Jev"
