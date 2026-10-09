// Content hashing shared by the canon writer and the Mastra rebuild fingerprint.
// Kept in its own module so a consumer that only needs a hash does not import
// the writer, and with it the workflow-script generator and the db schema.

import { createHash } from "node:crypto";

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
