// Typed seam interfaces — every capability plugs into one of these.
// Core resolves capabilities through the Registry, never by direct import.

import type {
  tickets,
  requirements,
  acceptanceCriteria,
  weaknesses,
  securityFindings,
  provenance,
} from "../db/schema.js";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";

// ── TicketStore ───────────────────────────────────────────────────────────────

export type TicketRow = InferSelectModel<typeof tickets>;
export type RequirementRow = InferSelectModel<typeof requirements>;
export type AcceptanceCriterionRow = InferSelectModel<typeof acceptanceCriteria>;
export type WeaknessRow = InferSelectModel<typeof weaknesses>;
export type SecurityFindingRow = InferSelectModel<typeof securityFindings>;
export type ProvenanceRow = InferSelectModel<typeof provenance>;

type TicketState = TicketRow["state"];

export interface NewTicket {
  slug: string;
  title: string;
  body?: string | null;
  intent?: string;
  sourceRef?: string;
}

/** Input for adding a requirement row. */
export type NewRequirement = Omit<InferInsertModel<typeof requirements>, "id">;

/** Input for adding an acceptance criterion row. */
export type NewAcceptanceCriterion = Omit<InferInsertModel<typeof acceptanceCriteria>, "id">;

/** Input for adding a weakness row. */
export type NewWeakness = Omit<InferInsertModel<typeof weaknesses>, "id">;

/** Input for adding a security finding row. */
export type NewSecurityFinding = Omit<InferInsertModel<typeof securityFindings>, "id">;

/** Input for adding a provenance row (timestamp is assigned by the store). */
export type NewProvenance = Omit<InferInsertModel<typeof provenance>, "id" | "at">;

/** A ticket with all its child rows eagerly loaded. */
export interface FullTicket extends TicketRow {
  requirements: RequirementRow[];
  acceptanceCriteria: AcceptanceCriterionRow[];
  weaknesses: WeaknessRow[];
  securityFindings: SecurityFindingRow[];
  provenance: ProvenanceRow[];
}

/**
 * Persists and retrieves pipeline tickets (source of truth per ADR-0002).
 * Implementations: DrizzleSQLiteTicketStore, …
 */
export interface TicketStore {
  createTicket(data: NewTicket): Promise<TicketRow>;
  getTicket(id: number): Promise<TicketRow | undefined>;
  getFullTicket(id: number): Promise<FullTicket | undefined>;
  updateState(id: number, state: TicketState): Promise<void>;
  addRequirement(input: NewRequirement): Promise<RequirementRow>;
  addAcceptanceCriterion(input: NewAcceptanceCriterion): Promise<AcceptanceCriterionRow>;
  addWeakness(input: NewWeakness): Promise<WeaknessRow>;
  addSecurityFinding(input: NewSecurityFinding): Promise<SecurityFindingRow>;
  addProvenance(input: NewProvenance): Promise<ProvenanceRow>;
  listRequirements(ticketId: number): Promise<RequirementRow[]>;
  listAcceptanceCriteria(ticketId: number): Promise<AcceptanceCriterionRow[]>;
  listWeaknesses(ticketId: number): Promise<WeaknessRow[]>;
  listSecurityFindings(ticketId: number): Promise<SecurityFindingRow[]>;
  listProvenance(ticketId: number): Promise<ProvenanceRow[]>;
  listTickets(): Promise<TicketRow[]>;
}
