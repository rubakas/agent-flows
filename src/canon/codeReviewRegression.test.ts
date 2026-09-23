import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCanonOutput } from "./validateOutput.js";

/**
 * Named regression fixtures for spec 044.
 *
 * One real `code-review` run closed with "Change is ready to merge — zero
 * blocking findings" while missing four things. The schema slots this spec
 * added (`evidenceBasis`, `remedyScope`, `sites`) exist so each of those four
 * is expressible in an honest shape and rejectable in its wrong one. Each case
 * below names the real defect it stands for, and asserts both directions: the
 * shape the run actually emitted is refused, and the shape it should have
 * emitted passes.
 *
 * Every assertion here was proven able to fail by neutering the rule it depends
 * on (spec 044 V6). All content is synthetic — no client data, no real paths
 * from the reviewed repository.
 *
 * Defects 3 and 4 are delivery-dimension outputs, and they are pinned twice:
 * once as `codeReviewFindings` entries, where what is checkable is the evidence
 * the verifier rested on, and once as `codeReviewDelivery` entries, where the
 * classification itself is now a schema slot. That second half did not exist
 * when this file was written — the classification vocabulary
 * `prompts/code-review-delivery.md` defines was prose in a prompt, so
 * `silently-decided` was indistinguishable from `implemented` and a fixture
 * asserting a payload "expressed `replaced-by-prose`" would only have asserted
 * that free text accepts a string, which it accepts for `banana` equally.
 * `CODE_REVIEW_DELIVERY_SCHEMA` is what closed it (spec 044 D1: a new axis is a
 * schema slot, not a sentence in a prompt).
 */

type Finding = Record<string, unknown>;

function finding(overrides: Finding = {}): Finding {
  return {
    claim: "placeholder claim",
    file: "app/services/example_service.rb",
    line: 42,
    quote: "def example",
    verdict: "CONFIRMED",
    citationAccurate: true,
    evidenceBasis: "file-content",
    remedyScope: "single-site",
    sites: [],
    scope: "introduced",
    kind: "defect",
    severity: "major",
    severityRationale: "placeholder rationale",
    probes: {
      guard: "none",
      reachability: "reached on the default path",
      remedy: "placeholder remedy",
      callers: "one caller",
      scope: "introduced by this diff",
    },
    correctedWording: "placeholder wording",
    ...overrides,
  };
}

function validate(...findings: Finding[]): string | undefined {
  return validateCanonOutput("codeReviewFindings", { codeReviewFindings: findings });
}

/**
 * DEFECT 1 — the unverifiable provenance question.
 *
 * The run asked a human whether a commit had removed real client documents and
 * whether git history needed scrubbing, and routed it to the owner as an
 * `external-confirmation` item marked CONFIRMED. Its own verifier rationale
 * admitted it could not check either way, because the removed blobs are not in
 * the working tree. Its only evidence was the commit's subject line. Per
 * D5 that is `UNVERIFIABLE`, not a question for a human, and CONFIRMED on a
 * commit subject must be refused.
 */
describe("spec 044 regression — defect 1: a provenance question the run could not check", () => {
  const provenanceQuestion = (overrides: Finding = {}) =>
    finding({
      claim: "Commit 9f0c1ab removed stored attachment blobs; git history may need scrubbing",
      file: "storage/attachments/",
      line: "n/a",
      quote: "chore: drop legacy attachment fixtures",
      evidenceBasis: "commit-message",
      kind: "external-confirmation",
      severity: "blocking",
      severityRationale: "the removed blobs are not in the working tree; nothing here can be read",
      probes: {
        guard: "unverified",
        reachability: "unverified",
        remedy: "unverified",
        callers: "unverified",
        scope: "unverified — the objects are not reachable from the checked-out tree",
      },
      correctedWording: "Whether the removed blobs held client documents cannot be settled here.",
      ...overrides,
    });

  it("refuses CONFIRMED when the only evidence is a commit subject line", () => {
    const report = validate(provenanceQuestion({ verdict: "CONFIRMED" }));
    assert.ok(report !== undefined, "CONFIRMED resting on a commit message must be rejected");
    assert.match(report, /"CONFIRMED"/, "the report must name the offending verdict");
    assert.match(report, /"commit-message"/, "the report must name the offending evidenceBasis");
  });

  it("accepts the same finding once it declares itself UNVERIFIABLE", () => {
    assert.equal(validate(provenanceQuestion({ verdict: "UNVERIFIABLE" })), undefined);
  });
});

/**
 * DEFECT 2 — a remedy that is unsafe at one of its sites.
 *
 * A finding named three mint sites and recommended one derivation for all of
 * them. At one site the stored basis is a fee, not price x shares, so applying
 * the remedy there would replace a valuation price with fee-per-share — a
 * different quantity, silently. Per D7 a remedy is validated per site or it is
 * not validated: `all-sites-verified` cannot stand next to a site the reviewer
 * itself marked unsafe.
 */
describe("spec 044 regression — defect 2: one remedy proposed across three unlike sites", () => {
  const priceSite = {
    file: "app/models/lot_mint.rb",
    line: 88,
    remedySafe: true,
    remedyNote: "basis is price x shares here; the derivation reproduces it",
  };
  const otherPriceSite = {
    file: "app/services/rebalance_mint.rb",
    line: 141,
    remedySafe: true,
    remedyNote: "basis is price x shares here too",
  };
  const feeSite = {
    file: "app/services/fee_mint.rb",
    line: 57,
    remedySafe: false,
    remedyNote:
      "basis stored here is a fee, not price x shares — the remedy would store fee-per-share as a valuation price, a different quantity",
  };

  const threeSites = [priceSite, otherPriceSite, feeSite];

  const mintRemedy = (overrides: Finding = {}) =>
    finding({
      claim: "All three mint sites should derive unit price as basis / share_count",
      file: "app/models/lot_mint.rb",
      line: 88,
      quote: "unit_price = basis / share_count",
      evidenceBasis: "file-content",
      severity: "major",
      severityRationale: "a wrong unit price propagates into every downstream valuation",
      correctedWording: "The derivation holds at two of the three sites.",
      ...overrides,
    });

  it("refuses all-sites-verified while one named site is marked unsafe", () => {
    const report = validate(
      mintRemedy({
        remedyScope: "all-sites-verified",
        sites: threeSites,
      })
    );
    assert.ok(report !== undefined, "all-sites-verified with an unsafe site must be rejected");
    assert.match(report, /"all-sites-verified"/, "the report must name the offending scope");
    assert.match(report, /fee_mint\.rb/, "the report must name the site that broke it");
  });

  /**
   * Spec 044 V3. The reviewed run named three sites and scoped the remedy as if
   * it had checked one. `remedyScope` and `sites` disagreeing that way is the
   * defect itself in schema form: a per-site check that was never done. The
   * accepted counterpart is the `sites-differ` test below — same three sites,
   * same finding, one field different.
   */
  it("refuses single-site while the same finding names three sites", () => {
    const report = validate(mintRemedy({ remedyScope: "single-site", sites: threeSites }));
    assert.ok(report !== undefined, "single-site across three sites must be rejected");
    assert.match(report, /"single-site"/, "the report must name the offending scope");
    assert.match(report, /3 locations/, "the report must name how many sites contradicted it");
    assert.match(report, /fee_mint\.rb/, "the report must name the sites it scoped away");
  });

  it("accepts sites-differ with the fee site marked unsafe and the difference written down", () => {
    assert.equal(
      validate(
        mintRemedy({
          remedyScope: "sites-differ",
          sites: threeSites,
        })
      ),
      undefined
    );
  });
});

/**
 * DEFECT 3 — a ticket answered with a manual note and an uninvoked rake task.
 *
 * The ticket offered a choice of three named remedies; the commit did none of
 * them and substituted a README note plus a rake task no CI job runs.
 * `prompts/code-review-delivery.md` classifies that `replaced-by-prose`
 * ("replacing an automated check with a task no scheduled job runs: if nothing
 * invokes it without a human, it is prose").
 *
 * What is pinned here is the evidence rule that governs such a
 * finding once it reaches the verifier: `prompts/code-review-verify.md` routes `replaced-by-prose`
 * through the absence rule, and the absence of a CI job invoking the task is
 * `absence-of-file` — an observation, so CONFIRMED stands. The rake task's own
 * name is not: reading `rake attachments:verify` and inferring it runs is
 * exactly the `identifier-name` failure the slot was added to catch. The
 * classification itself is pinned below, on the delivery step's own schema.
 */
describe("spec 044 regression — defect 3: a rake task no CI job invokes", () => {
  const undeliveredCheck = (overrides: Finding = {}) =>
    finding({
      claim:
        "The ticket asked for a fixture, a manifest or a loud skip; the commit added a rake task no workflow invokes",
      file: ".github/workflows/",
      line: "n/a",
      quote: "no workflow references attachments:verify",
      kind: "defect",
      severity: "major",
      severityRationale: "a check nothing invokes is not a check; the ticket's remedy is undone",
      probes: {
        guard: "none — no scheduled job references the task",
        reachability: "only a human at a terminal reaches it",
        remedy: "invoke the task from a workflow, or deliver one of the three named remedies",
        callers: "grep across .github/workflows and config/schedule returned nothing",
        scope: "introduced by this diff",
      },
      correctedWording: "The ticket's remedy was replaced with a manual procedure.",
      ...overrides,
    });

  it("accepts CONFIRMED when the delivery gap rests on a search that came back empty", () => {
    assert.equal(
      validate(undeliveredCheck({ verdict: "CONFIRMED", evidenceBasis: "absence-of-file" })),
      undefined
    );
  });

  it("refuses CONFIRMED when the same gap rests only on the task's name", () => {
    const report = validate(
      undeliveredCheck({ verdict: "CONFIRMED", evidenceBasis: "identifier-name" })
    );
    assert.ok(report !== undefined, "CONFIRMED resting on an identifier name must be rejected");
    assert.match(report, /"CONFIRMED"/, "the report must name the offending verdict");
    assert.match(report, /"identifier-name"/, "the report must name the offending evidenceBasis");
  });
});

/**
 * DEFECT 4 — a ticket answered with a comment on an untouched code path.
 *
 * The ticket asked either to count swept links or to make the sweep path
 * explicit; the commit was comment-only and the code path was untouched. Per
 * `prompts/code-review-delivery.md`, "a comment-only change to a code path the
 * ticket asked to alter is this class [`replaced-by-prose`], not
 * `implemented`" — so this defect carries the same class as defect 3, by the
 * prompt's own definition rather than by a class invented here.
 *
 * What is pinned here is that the honest evidence for
 * this one is the untouched code the verifier read (`file-content`, CONFIRMED
 * stands), and that the added comment is not evidence that the path changed —
 * `evidenceBasis: "comment"` cannot carry CONFIRMED. The classification itself
 * is pinned below, on the delivery step's own schema.
 */
describe("spec 044 regression — defect 4: a comment where the code path was asked to change", () => {
  const commentOnlyChange = (overrides: Finding = {}) =>
    finding({
      claim:
        "The ticket asked to count swept links or make the path explicit; the sweep body is unchanged",
      file: "app/jobs/link_sweep_job.rb",
      line: 31,
      quote: "links.each { |link| link.destroy }",
      kind: "defect",
      severity: "major",
      severityRationale: "neither named remedy was delivered; only a comment was added above it",
      probes: {
        guard: "none",
        reachability: "the sweep runs on every scheduled pass",
        remedy: "return the swept count, or name the path in the job's signature",
        callers: "one scheduled caller",
        scope: "introduced by this diff",
      },
      correctedWording: "A comment was added; the code path the ticket named is unchanged.",
      ...overrides,
    });

  it("accepts CONFIRMED when the verifier read the untouched code path itself", () => {
    assert.equal(
      validate(commentOnlyChange({ verdict: "CONFIRMED", evidenceBasis: "file-content" })),
      undefined
    );
  });

  it("refuses CONFIRMED when the added comment is the evidence", () => {
    const report = validate(commentOnlyChange({ verdict: "CONFIRMED", evidenceBasis: "comment" }));
    assert.ok(report !== undefined, "CONFIRMED resting on a comment must be rejected");
    assert.match(report, /"CONFIRMED"/, "the report must name the offending verdict");
    assert.match(report, /"comment"/, "the report must name the offending evidenceBasis");
  });

  it("accepts a CONFIRMED file-content finding beside an UNVERIFIABLE one resting on nothing", () => {
    assert.equal(
      validate(
        commentOnlyChange({ verdict: "CONFIRMED", evidenceBasis: "file-content" }),
        finding({ verdict: "UNVERIFIABLE", evidenceBasis: "none" })
      ),
      undefined
    );
  });
});

// ── the same defects, on the delivery step's own schema ──────────────────────

type DeliveryEntry = Record<string, unknown>;

function deliveryEntry(overrides: DeliveryEntry = {}): DeliveryEntry {
  return {
    requirement: "placeholder requirement",
    source: "TICKET-000",
    classification: "implemented",
    evidence: "app/models/placeholder.rb:1",
    decisionTaken: "not a decision",
    optionsForeclosed: "not a decision",
    ...overrides,
  };
}

function validateDelivery(
  entries: DeliveryEntry[],
  specSourcesProvided = true
): string | undefined {
  return validateCanonOutput("codeReviewDelivery", {
    specSourcesProvided,
    codeReviewDelivery: entries,
  });
}

/**
 * DEFECT 3, classified — the rake task no CI job invokes.
 *
 * The same ticket as defect 3 above, now expressed where the classification
 * lives. It offered three named remedies and got a README note plus a task
 * nothing schedules, which `prompts/code-review-delivery.md` calls
 * `replaced-by-prose` ("if nothing invokes it without a human, it is prose").
 *
 * The dishonest shape is the one the real run emitted: the same entry called
 * `implemented`, with nothing to cite for it. Exactly one field differs between
 * the two, and that field is the classification — an `implemented` claim must
 * name the file that carries it, and a search that came back empty has no file
 * to name.
 */
describe("spec 044 regression — defect 3 classified: a remedy replaced by a manual procedure", () => {
  const undeliveredCheck = (overrides: DeliveryEntry = {}) =>
    deliveryEntry({
      requirement: "Commit a fixture, commit a manifest, or make the skip loud.",
      source: "TICKET-411, acceptance criteria",
      evidence:
        "no code satisfies this — a repository-wide search for a scheduled invocation of the rake task returned nothing, and none of the three named remedies is present; a README note and a task a human runs by hand were added instead",
      ...overrides,
    });

  it("accepts replaced-by-prose for a task no scheduled job invokes", () => {
    assert.equal(
      validateDelivery([undeliveredCheck({ classification: "replaced-by-prose" })]),
      undefined
    );
  });

  it("refuses the same entry called implemented with no file to cite", () => {
    const report = validateDelivery([undeliveredCheck({ classification: "implemented" })]);
    assert.ok(report !== undefined, "an implemented claim citing no file must be rejected");
    assert.match(report, /"implemented"/, "the report must name the offending classification");
    assert.match(
      report,
      /no code satisfies this/,
      "the report must quote the evidence that failed"
    );
  });
});

/**
 * DEFECT 4, classified — a comment where the code path was asked to change.
 *
 * `prompts/code-review-delivery.md`: "a comment-only change to a code path the
 * ticket asked to alter is this class [`replaced-by-prose`], not
 * `implemented`". The accepted and refused shapes differ in the classification
 * alone; the evidence — a comment, named as a comment, with no code path to
 * point at — is the same sentence in both.
 */
describe("spec 044 regression — defect 4 classified: a comment instead of the code path", () => {
  const commentOnlyChange = (overrides: DeliveryEntry = {}) =>
    deliveryEntry({
      requirement: "Count the swept links, or make the sweep path explicit.",
      source: "TICKET-508, body",
      evidence:
        "no code satisfies this — the only change to the sweep is a comment above it; neither named remedy appears, and a search for a returned count came back empty",
      ...overrides,
    });

  it("accepts replaced-by-prose for a comment-only answer to a code request", () => {
    assert.equal(
      validateDelivery([commentOnlyChange({ classification: "replaced-by-prose" })]),
      undefined
    );
  });

  it("refuses the same entry called implemented", () => {
    const report = validateDelivery([commentOnlyChange({ classification: "implemented" })]);
    assert.ok(report !== undefined, "a comment is not an implementation the entry can cite");
    assert.match(report, /"implemented"/, "the report must name the offending classification");
  });
});

/**
 * DEFECT 5 — a silent decision reported as a shrug.
 *
 * `silently-decided` is the class this dimension exists for, and it says
 * nothing without naming which decision was made: "the ticket asked a human to
 * choose, the commit chose, and the record does not show that a choice was
 * made" (`prompts/code-review-delivery.md`). An entry that names the class and
 * not the decision reproduces exactly the gap it is reporting.
 */
describe("spec 044 regression — defect 5: a silent decision with no decision named", () => {
  const silentChoice = (overrides: DeliveryEntry = {}) =>
    deliveryEntry({
      requirement: "Whether a fee-basis lot is valued per share or per lot needs a decision.",
      source: "TICKET-233, open questions",
      classification: "silently-decided",
      evidence: "app/services/fee_mint.rb:57 — `unit_price = basis / share_count`",
      optionsForeclosed: "valuing the lot as a whole, which the ticket listed as the alternative",
      ...overrides,
    });

  it("refuses silently-decided with an empty decisionTaken", () => {
    const report = validateDelivery([silentChoice({ decisionTaken: "" })]);
    assert.ok(report !== undefined, "a silent decision with no decision named must be rejected");
    assert.match(report, /"silently-decided"/, "the report must name the offending classification");
    assert.match(report, /decisionTaken is ""/, "the report must name the offending value");
  });

  it("accepts it once the decision the code took is named", () => {
    assert.equal(
      validateDelivery([
        silentChoice({ decisionTaken: "valued per share, dividing the stored fee by share_count" }),
      ]),
      undefined
    );
  });
});

/**
 * DEFECT 6 — requirements with no ticket behind them.
 *
 * `prompts/code-review-delivery.md` forbids deriving requirements from the
 * change: with no spec source there is nothing to fail the change against, and
 * a list of requirements read out of the diff is a review grading itself.
 * `specSourcesProvided` is what makes that distinguishable from a run that read
 * the tickets and found every requirement delivered.
 */
describe("spec 044 regression — defect 6: a delivery report with no spec source", () => {
  it("refuses entries reported when no spec source was supplied", () => {
    const report = validateDelivery([deliveryEntry()], false);
    assert.ok(report !== undefined, "requirements invented with no spec source must be rejected");
    assert.match(report, /specSourcesProvided "false"/, "the report must name the offending flag");
    assert.match(report, /1 entries/, "the report must name how many entries contradicted it");
  });

  it("accepts the empty report that says the dimension had nothing to run against", () => {
    assert.equal(validateDelivery([], false), undefined);
  });
});
