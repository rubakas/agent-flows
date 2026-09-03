// FR-006: Persist a hardened spec into Yoke's SQLite ticket store.

import { randomUUID } from "node:crypto";
import type { HardenedSpec } from "./types.js";
import type { TicketStore } from "../module/seams.js";

export type { HardenedSpec } from "./types.js";

export async function persistTicket(
  store: TicketStore,
  spec: HardenedSpec
): Promise<{ ticketId: number }> {
  const ticket = await store.createTicket({
    slug: `yoke-${randomUUID()}`,
    title: spec.title,
    body: spec.description,
    intent: "yoke:spec-creation",
  });

  const ticketId = ticket.id;

  for (let i = 0; i < (spec.requirements ?? []).length; i++) {
    const text = spec.requirements![i];
    await store.addRequirement({
      ticketId,
      code: `REQ-${String(i + 1).padStart(3, "0")}`,
      text,
    });
  }

  for (const text of spec.acceptanceCriteria ?? []) {
    await store.addAcceptanceCriterion({ ticketId, text });
  }

  for (let i = 0; i < (spec.weaknesses ?? []).length; i++) {
    const w = spec.weaknesses![i];
    await store.addWeakness({
      ticketId,
      code: `WEAK-${String(i + 1).padStart(3, "0")}`,
      text: w.text,
      severity: w.severity ?? "low",
      blocking: w.blocking ?? false,
    });
  }

  for (let i = 0; i < (spec.securityFindings ?? []).length; i++) {
    const f = spec.securityFindings![i];
    await store.addSecurityFinding({
      ticketId,
      code: `SEC-${String(i + 1).padStart(3, "0")}`,
      text: f.text,
      severity: f.severity ?? "low",
      blocking: f.blocking ?? false,
    });
  }

  await store.addProvenance({
    ticketId,
    section: "spec-creation",
    agent: "yoke",
    model: "yoke:spec-creation",
    runId: randomUUID(),
  });

  await store.updateState(ticketId, "ready");

  return { ticketId };
}
