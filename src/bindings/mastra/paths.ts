// ── Path helpers ──────────────────────────────────────────────────────────────

/** Derive the Mastra LibSQL db path from the ticket db path.
 *
 * Strips a trailing `.sqlite` or `.db` extension (anchored at end, so
 * directory components containing `.db` are unaffected) then appends
 * `-mastra.db`. Paths with no recognised extension get the suffix appended
 * directly.
 */
export function mastraDbPath(ticketDbPath: string): string {
  return ticketDbPath.replace(/\.(sqlite|db)$/, "") + "-mastra.db";
}
