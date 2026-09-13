/**
 * Fixture: verified code review of an invented refund module.
 *
 * WHAT THIS FIXTURE COVERS
 * ────────────────────────
 * End-to-end verdict quality on findings the pipeline can actually produce: a
 * real defect that is present in the diff, that a competent reviewer raises
 * unprompted, and that the verifier then adjudicates on the merits; plus the
 * classification of a policy question as `business-decision` and its exclusion
 * from the blocking count (spec 030 FR-004).
 *
 * It also covers the DECLINED path end to end, via `conditional`. A decoy is bait:
 * something in the diff a competent reviewer will plausibly flag, that a guard
 * the verifier can actually reach already closes. Raising a decoy is fine and
 * even desirable — the graded event is what the verifier does next. DECLINED is
 * the win; CONFIRMED or PARTIAL is a verifier rubber-stamping a finding a guard
 * closes, which is the failure this pipeline exists to prevent. Note the
 * inversion against `audit-planted-defects.ts`, which shares the word: there a
 * decoy raised at all is a false positive, because `audit` has no verify step to
 * adjudicate it.
 *
 * Both decoys are modelled on failure class 2 of the brief — a finding headlined
 * "nothing bounds this value" where a parent-level validation already bounds it.
 *
 * WHAT IT DOES NOT COVER
 * ──────────────────────
 * The seeded-bad-citation cases — spec 030 acceptance criteria 1, 2 and 5, where
 * the verifier must disprove a claim the reviewer got WRONG. Nothing here can
 * seed such a claim: `verify`'s only upstream inputs are `correctness` and
 * `security`, which receive `plan`, `baseline` and `introducedCommits`, and a
 * competent reviewer will not invent a false claim on demand. An answer key
 * demanding a verdict on a finding that is never raised is missing by
 * construction, and with `THRESHOLDS.verdictAccuracy = 1` that fails the eval
 * for reasons unrelated to verification quality. Business-decision items are
 * conditional for the same reason: audit's worker prompts omit non-defects by
 * instruction, so such an item reaches the verifier only as a defect someone
 * raised and the verifier reclassified, never as itself.
 *
 * Those three criteria are covered offline instead, by `reviewVerdicts` unit
 * tests in `src/evals/scorers.test.ts` that feed synthetic verify output
 * directly to the scorer. That is the right place for them: they grade the
 * scorer's treatment of a wrong claim, which needs no model at all.
 *
 * The decoys in `conditional` are the reason that gap is narrower than it reads:
 * they reach the DECLINED path without seeding anything, because the bait — not
 * the fixture — supplies the wrong claim. Everything in `conditional` is scored
 * three-state precisely because a reviewer cannot be compelled to raise a given
 * item: one nobody raises is inconclusive, never a pass and never a failure.
 *
 * ANSWER-KEY DISCIPLINE
 * ─────────────────────
 * The diff must never contain the answer. No `// BUG:` marker, no comment naming
 * the owner of a policy call, no docstring stating the remedy — a model scores by
 * copying such a comment rather than by verifying anything. Keywords are drawn
 * from identifiers and structure that survive without commentary.
 */

import type { KeyedItem, VerdictExpectation } from "../scorers.js";

/**
 * An answer-key entry plus the names it hangs on.
 *
 * `identifiers` are function, constant or field names that must literally appear
 * in the diff — a verifier cannot cite what is not there. `keywords` are matched
 * against the verifier's output; two or more are required, and each must also
 * occur in the diff, so that no key can be satisfied by ordinary prose.
 */
export interface CodeReviewExpectation extends VerdictExpectation {
  identifiers: string[];
}

/**
 * An item that is graded only if it is raised at all.
 *
 * Two shapes live here. Bait — a plausible finding a reachable guard closes —
 * `want`s `DECLINED` and `forbid`s a CONFIRMED defect: raising it is fine,
 * declining it is the win, and only the rubber stamp fails. A business-decision
 * `want`s `kind: business-decision` and forbids nothing: no producer can
 * originate a non-defect, so it only ever arrives as a defect the verifier
 * reclassifies, and nothing about it is worth failing a run over.
 *
 * The gap between `want` and `forbid` is deliberate. A key sweeps in neighbouring
 * findings about the same lines — a caveat about files that do not exist, a
 * correctly narrowed PARTIAL — and those are neither the win nor the failure.
 * Grading them would fail a verifier for being right.
 *
 * `keywords` must identify the CLAIM, not the adjudication — they have to match
 * the finding whatever verdict it carries, or a rubber-stamped item would score
 * as never raised and the failure would vanish.
 */
export interface CodeReviewConditional extends KeyedItem {
  /** What a correct adjudication of this item looks like; unset fields are not compared. */
  want: { verdict?: "CONFIRMED" | "PARTIAL" | "DECLINED"; kind?: string };
  /** The adjudication that fails the eval. Absent: nothing about this item is gating. */
  forbid?: { verdict?: "CONFIRMED" | "PARTIAL" | "DECLINED"; kind?: string };
}

export interface CodeReviewFixture {
  /** Diff passed as `plan` input to the code-review pipeline. */
  diff: string;
  /** What existed before the change; passed as the `baseline` input. */
  baseline: string;
  /** Verdicts the verifier must reach, one per finding raised upstream. */
  expectations: CodeReviewExpectation[];
  /** Items graded only when raised: bait to decline, and the business-decision call. */
  conditional: CodeReviewConditional[];
  /** Repo paths that must exist on disk (anti-rot). Empty: the diff invents its own module. */
  expectedPaths: string[];
}

const DIFF = `\
diff --git a/src/billing/refund.ts b/src/billing/refund.ts
new file mode 100644
--- /dev/null
+++ b/src/billing/refund.ts
@@ -0,0 +1,41 @@
+import { daysSince } from "./clock.js";
+import { writeLedgerEntry } from "./ledger.js";
+import { saveOrder } from "./order.js";
+import type { Order } from "./order.js";
+
+const FEE_RATE_BASIS_POINTS = 250;
+
+// Refunds are only offered inside this window.
+export const REFUND_WINDOW_DAYS = 90;
+
+export interface RefundResult {
+  refundedCents: number;
+  feeCents: number;
+}
+
+/** Refund a paid order. All money is integer cents; never a float. */
+export function applyRefund(order: Order, amountCents: number): RefundResult {
+  if (!Number.isInteger(amountCents) || amountCents <= 0) {
+    throw new Error("refund amount must be a positive integer number of cents");
+  }
+  if (daysSince(order.paidAt) > REFUND_WINDOW_DAYS) {
+    throw new Error("the refund window for this order has closed");
+  }
+  const feeCents = Math.floor((amountCents * FEE_RATE_BASIS_POINTS) / 10000);
+
+  order.refundedCents += amountCents;
+  saveOrder(order);
+  writeLedgerEntry({ orderId: order.id, amountCents, feeCents });
+
+  return { refundedCents: amountCents, feeCents };
+}
+
+/** Undo a refund. */
+export function reverseRefund(order: Order): void {
+  if (order.refundedCents !== order.paidCents) {
+    throw new Error("only a full refund can be reversed; partial refunds are not reversible");
+  }
+  order.refundedCents = 0;
+  saveOrder(order);
+  writeLedgerEntry({ orderId: order.id, amountCents: -order.paidCents, feeCents: 0 });
+}
diff --git a/src/billing/refundController.ts b/src/billing/refundController.ts
--- a/src/billing/refundController.ts
+++ b/src/billing/refundController.ts
@@ -18,4 +18,7 @@ export function assertRefundable(order: Order, amountCents: number): void {
   if (order.status !== "paid") {
     throw new Error("order is not paid");
   }
+  if (amountCents > order.paidCents - order.refundedCents) {
+    throw new Error("refund exceeds the amount paid");
+  }
 }
@@ -31,4 +34,4 @@ export async function handleRefund(req: RefundRequest): Promise<RefundResult> {
   const order = await loadOrder(req.orderId);
   assertRefundable(order, req.amountCents);
-  return legacyRefund(order, req.amountCents);
+  return applyRefund(order, req.amountCents);
 }
`;

const BASELINE = `\
Baseline: main@a1b2c3d. Before this change src/billing/ contained order.ts, ledger.ts, clock.ts and
refundController.ts; refundController.ts already defined assertRefundable and routed refunds
through legacyRefund. src/billing/refund.ts did not exist. The amountCents > paidCents check
inside assertRefundable is added by this change and appears as an added line in the hunk at
refundController.ts:18.

Order (src/billing/order.ts, unchanged by this work) exports saveOrder, which writes the order row
to the database in its own transaction, and declares paidAt as a non-nullable Date. It is
written in the same transaction that sets status to "paid", so an order whose status is "paid"
always carries a real timestamp and daysSince never receives undefined. handleRefund is the only
production caller of applyRefund.`;

const fixture: CodeReviewFixture = {
  diff: DIFF,
  baseline: BASELINE,

  expectations: [
    {
      phrase:
        "real ordering defect: saveOrder persists order.refundedCents before the ledger entry, so a failed ledger write leaves the two stores disagreeing",
      // The verifier has to land on the pair, not on either half: the order
      // mutation alone is unremarkable and the ledger write alone is correct.
      keywords: ["refundedCents", "ledger"],
      identifiers: ["refundedCents", "saveOrder", "writeLedgerEntry"],
      expectedVerdict: "CONFIRMED",
      expectedKind: "defect",
    },
  ],

  // Order is claim priority: a finding is attributed to the first key that
  // matches it, expectations first and then these in order. The NaN bait names
  // the refund window it claims to bypass, so it satisfies the policy key too —
  // listed last, the policy key only ever takes a finding the bait did not claim.
  conditional: [
    {
      phrase:
        "applyRefund never checks amountCents against order.paidCents — bounded by assertRefundable one frame up",
      // Reading refund.ts alone, this is real: applyRefund validates the shape of
      // amountCents and the age of the order, and nothing in it caps the amount
      // against what was actually paid. The cap is a frame up, which is exactly
      // the shape of failure class 2 — "nothing bounds this, at any layer" when
      // the parent already does.
      //
      // Guard, visible in the diff: the added line in the refundController.ts:18
      // hunk rejects amountCents > order.paidCents - order.refundedCents, and the
      // second hunk shows handleRefund calling assertRefundable before applyRefund
      // on the same req.amountCents.
      // Keyed on the over-refund guard's own words ("refund exceeds the amount
      // paid"), not on `paidCents`: an unrelated concurrency finding about
      // handleRefund names applyRefund and paidCents too, and claiming it would
      // grade a correctly-narrowed PARTIAL defect as a rubber-stamped bait.
      keywords: ["applyRefund", "exceeds"],
      want: { verdict: "DECLINED" },
      forbid: { verdict: "CONFIRMED", kind: "defect" },
    },
    {
      phrase:
        "daysSince(order.paidAt) could go NaN on an unset paidAt and skip the refund window — paidAt is non-nullable on a paid order",
      // The window check is the only thing standing between a stale order and a
      // refund, and Order is imported from a file the reviewer cannot open, so
      // "what if paidAt is unset" is a fair question rather than invented doubt.
      // NaN > REFUND_WINDOW_DAYS is false, so an unset value really would skip
      // the window — the claim is sound and only its premise is wrong.
      //
      // Guard, visible in the baseline: Order.paidAt is declared non-nullable and
      // written in the transaction that sets status to "paid". The diff's
      // assertRefundable hunk shows the status !== "paid" rejection as unchanged
      // context, so no other status reaches applyRefund.
      keywords: ["daysSince", "paidAt"],
      want: { verdict: "DECLINED" },
      forbid: { verdict: "CONFIRMED", kind: "defect" },
    },
    {
      phrase:
        "90-day refund window is a finance policy call, not a defect — classified once, given an owner, excluded from the blocking count",
      // Nothing in the diff says who owns the number or that it is a policy
      // question; the verifier has to reach that from the code, which enforces
      // the window correctly and only leaves the value itself open. Conditional
      // rather than expected: no worker prompt can emit a non-defect, so this
      // only ever arrives as a defect the verifier reclassifies — the verdict it
      // carries is not graded, the classification is.
      //
      // Keyed on the constant and the word "window", not on the guard line's
      // identifiers: a finding about the window CHECK (the NaN bait) quotes that
      // line too, and keying on it handed this item the bait's copy instead of
      // the policy call. The declaration `export const REFUND_WINDOW_DAYS = 90;`
      // and the comment above it are what a policy finding cites.
      keywords: ["REFUND_WINDOW_DAYS", "window"],
      want: { kind: "business-decision" },
    },
  ],

  // The diff invents src/billing/*, which deliberately does not exist in this
  // repo, so there is no real path to anchor. Empty rather than pointing at a
  // file the fixture never references.
  expectedPaths: [],
};

export default fixture;
