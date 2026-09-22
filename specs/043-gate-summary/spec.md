# 043. What am I approving?

| Field        | Value                                               |
| ------------ | --------------------------------------------------- |
| Feature Name | Gate summary                                        |
| Branch       | `main`                                              |
| Status       | Implemented 2026-09-22 — live-proven at a real gate |
| Created      | 2026-09-22                                          |

## Context

Owner ask, verbatim: "стадія апрува не дуже очевидна, я бачу кнопки апрув або ні але не бачу самої
суті, що саме апрувити, має бути коротке самарі" — the approval stage shows Approve and Reject but
not the substance of what is being approved; it needs a short summary.

**What the page shows today.** When a run is `awaiting_approval`, `ui.html` renders a `.gate-box`
containing exactly one line — `snapshot.gateMessage` — and two buttons. `gateMessage` is a fixed
string written in the pipeline YAML, identical on every run of that pipeline:

- `spec-creation.yaml`: "Approve this hardened, verified spec?"
- `ship.yaml`: "Commit all staged changes locally?"

It names the KIND of decision and carries no information about this particular run. An operator is
asked to approve without being shown anything to approve.

**The material already exists and is already sent.** `GetResult.spec` is documented as "the spec the
human is being asked to approve", is populated on suspension (`runService.ts:1013-1014`), and is
returned by `GET /api/runs/:id`. The page has never rendered it. For `spec-creation` it is a
`HardenedSpec` — `title`, `description`, `requirements[]`, `acceptanceCriteria[]`, `weaknesses[]`,
`securityFindings[]`. For `ship` it is absent, and the substance is the working tree.

**A model already reads exactly this material at exactly this moment.** `gateJudge.ts` builds
`{ gate question, spec payload capped at 64 KB, git status --porcelain }` and calls `runLlmStep` to
produce an approve/reject verdict for auto-mode runs. A summary is that same material with a
different prompt and a cheaper role. This spec reuses that seam rather than inventing a second one.

Only two pipelines contain a gate, so the whole surface is two call sites.

## Decisions

**D1 — The summary is written by a model.** (Owner, 2026-09-22, choosing this over a structural
summary built from the fields.) A structural rendering — title, description, "7 requirements · 3
acceptance criteria · 2 weaknesses" — can be built with no model call and no latency, but it
restates the shape of the payload rather than telling the operator what the run decided. The owner
asked for a summary; a field listing is not one.

**D2 — It is generated when the gate suspends, not when the page is opened.** At suspension the run
is still executing and nobody is waiting; by the time the operator arrives the text is already
there. Generating on page load would put a model call between the operator and the buttons every
time the page is refreshed, and would re-spend on every reload. The summary is persisted with the
suspend payload, so it survives a reload, a restart, and a daemon that serves the run from disk.

**D3 — A failed summary must never block the gate.** The summary is generated on a best-effort
path: no provider configured, a model error, a timeout, or an empty answer all leave the gate fully
usable. In that case the page falls back to the structural summary D1 rejected as insufficient —
insufficient is not the same as useless, and it costs nothing when the model path has already
failed.

**D4 — The page says which one it is showing.** A generated summary is labelled as generated. The
fallback is labelled as the payload's own fields. An operator must never be unable to tell a model's
reading of the run from a mechanical listing of it, because only one of the two can be wrong about
the run.

**D5 — The summary describes, it does not recommend.** This text sits between an Approve button and
a Reject button, so anything that reads as a verdict will be acted on as one. The prompt asks for
what the run produced and what approving it would cause — never whether to approve. The auto-mode
judge already exists for verdicts and renders separately; the two must not be confusable.

**D6 — The material stays one click away, always.** The summary is model output about model output
and can be wrong. The full spec payload and the working-tree status remain expandable under it, so
an operator who wants to check the summary against the thing it summarises never has to leave the
gate. A summary that replaces the material would make the gate less trustworthy than the bare
question it replaced.

**D7 — Role is `scout`, not `reasoner`.** The judge uses `reasoner` because a verdict carries the
decision. A summary does not decide anything, it is read by someone who does, and it is on the
critical path of every gated run. Cheapest capable tier.

**D8 — The summary is capped, and the cap is visible.** Same 64 KB material cap the judge already
uses. Output is capped at a short paragraph; a summary that has to be scrolled is not a summary and
competes with the material it is supposed to introduce.

## Functional Requirements

- **FR-001.** On suspension at a gate, the service generates a summary from the same material
  `buildJudgePrompt` assembles (gate question, spec payload, `git status --porcelain`), using a new
  `prompts/gate-summary.md` and the run's own provider profile at the `scout` role.
- **FR-002.** The summary is stored on the run record alongside `gateMessage` and `spec`, and is
  returned by `GET /api/runs/:id` as `gateSummary`. It is absent, never empty-string, when not
  produced.
- **FR-003.** Generation failure of any kind leaves `status` at `awaiting_approval` with the gate
  approvable, and records why in the step log — never on the gate box.
- **FR-004.** The gate box renders, in order: the gate question, the summary (labelled as generated)
  or the structural fallback (labelled as the spec's own fields), an expander holding the full spec
  payload rendered as markdown, and then the buttons.
- **FR-005.** With neither a summary nor a spec payload — `ship`'s gate before anything is staged —
  the box says what it could not find and names the gate step, rather than showing the bare question
  as it does today.
- **FR-006.** Approve and Reject are reachable and unchanged in every one of the states above.

## Verification

- **V1.** A gate whose summary generation throws still returns `awaiting_approval` with the gate
  approvable — proven by injecting a runner that rejects, then approving the run through the normal
  route.
- **V2.** The rendered gate box is distinguishable between the generated and the fallback case by
  its label alone — proven on both branches without a browser, since the renderer is a pure
  function in a `ui-*.js` module.
- **V3.** The full spec payload is present in the rendered HTML in both branches (D6), proven
  against a `HardenedSpec` fixture.
- **V4.** A hostile `HardenedSpec` — markup in `title`, `description` and every array element —
  reaches the page as text (the payload is model output).
- **V5.** The summary is generated once per suspension, not once per page load — proven by counting
  runner invocations across repeated `GET /api/runs/:id`.

## Out of scope

- Changing the auto-mode judge, its prompt, or its role.
- Summaries for anything that is not a gate.
- Regenerating a summary on request.
- The ADR-0019 renames.

## Risks

- **A wrong summary is worse than no summary**, because it is read INSTEAD of the material. D6 is
  the only mitigation and it is a weak one: it relies on the operator choosing to expand. This is
  the risk the owner accepted when choosing D1 over a structural summary that cannot be wrong.
- **Latency at every gated run.** The call happens while nobody is waiting (D2), but it does delay
  the moment the run becomes visibly approvable.
- **Two models now speak at one gate** — the judge's verdict and this summary. D5 separates them by
  content and the page must separate them visually, or an operator will read a description as a
  recommendation.
- **Cost on a path with no opt-out.** Every gated run now makes one extra model call. `scout` (D7)
  bounds it; nothing else does.

## Outcome (2026-09-22)

Implemented as specified; every FR and every V above is covered by a test, and V1, V2 and V3 were
each proven able to fail by neutering the mechanism they guard.

Seams, as built:

- `gateMaterial.ts` — extracted from `gateJudge.ts`, which now uses it too. The judge and the
  summary read the same block by construction rather than by two copies staying in step.
- `gateSummary.ts` — kept out of `gateJudge.ts` on purpose. A text nobody's decision depends on
  must not live in the path of one that resolves the run.
- `summaryDeps` is a sixth constructor argument to `RunService`, NOT part of `JudgeDeps`: the
  daemon passes `judgeDeps: undefined`, so a gate a human answers is precisely a gate with no judge
  configured. Deriving the summary from judge deps would have shipped a feature that never runs —
  the same shape as the dead `daemonToken` module deleted the same day.
- `ui-gate.js` — three registrations, all of them required: `STATIC_MODULES` in `server.ts`,
  `PAGE_ASSETS` in `scripts/copy-dist-assets.mjs`, and `MARKUP` in `ui-style.test.ts`.

**Live proof.** A `ship` run was started and suspended at its gate, which carries no spec payload —
the FR-005 branch. The box said, unprompted:

> Approving commits scripts/copy-dist-assets.mjs, the sole staged change. Nine unstaged
> modifications and eight untracked files remain in the working tree and will not be included. No
> specification was provided to contextualize this commit.

Three things the fixed question "Commit all staged changes locally?" could never say: what is
actually staged, what is being left behind, and that nothing was attached to explain the commit. It
describes and does not recommend (D5). The run was cancelled, never approved, so nothing was
committed.
