// The daemon's per-process authentication token (spec 039 D15).
//
// The daemon has no authentication today, which is survivable only because it
// can act on exactly one directory. Once a request can name any directory
// (the project registry, spec 039 D4), any local process able to reach the
// daemon's port could run workflow steps in an arbitrary folder — this token
// is what a request must present to be believed.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Bytes of entropy in a generated token — at least 32, rendered url-safe. */
const TOKEN_BYTES = 32;

/** A fresh, random, url-safe token with at least 32 bytes of entropy. */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Whether two tokens are equal, in constant time.
 *
 * Hashing both sides first, rather than comparing them directly, keeps the
 * comparison length-independent — `timingSafeEqual` requires equal-length
 * buffers, and comparing lengths before it would otherwise leak the
 * candidate's length through timing. A missing or empty candidate never
 * matches.
 */
export function tokensMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
