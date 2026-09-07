// Shared low-level helpers used across handleRequest's route dispatch.
// Nothing here is registered as an HTTP entry point on its own — every
// export is only ever called from within server.ts's handleRequest, after
// the Host/content-type/Origin preamble has already run.

import type { RunService } from "../runtime/runService.js";
import type { IncomingMessage, ServerResponse } from "node:http";

// Safe pipeline/template/run id: lowercase alphanumeric and hyphens, must start with a letter or digit.
// Prohibits dot, slash, backslash, space — blocks all path-traversal attempts.
const RE_SAFE_ID = /^[a-z0-9][a-z0-9-]*$/u;

export function isSafeId(id: string): boolean {
  return RE_SAFE_ID.test(id) && id.length <= 100;
}

/**
 * Pre-check for skill/agent names supplied by the client.
 * Blocks the most obvious traversal forms before the resolve-based containment check.
 */
export function isSafeName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && !name.startsWith(".") && !/[/\\\0]/u.test(name);
}

/**
 * Replace any occurrence of the launch root in an error message with the
 * literal string `<root>` so absolute filesystem paths never enter HTTP
 * or SSE payloads.
 */
export function safePath(message: string, root: string): string {
  return message.split(root).join("<root>");
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** Thrown by readBody() when the accumulated request body exceeds the cap. */
export class RequestTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit`);
    this.name = "RequestTooLargeError";
  }
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return; // drain remaining data without accumulating
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        tooLarge = true;
        // Resume to drain the rest of the request body so the socket stays
        // alive long enough for the caller to write a 413 response.
        req.resume();
        reject(new RequestTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

export type JsonBodyResult = { ok: true; value: Record<string, unknown> } | { ok: false };

export function parseJsonBody(raw: string): JsonBodyResult {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return { ok: true, value: v as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Reads and parses a JSON request body. Callers write the 400 response
 * themselves on `{ ok: false }` so each route keeps its own error message.
 * `maxBytes` is mandatory — every route must state its own limit explicitly.
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<JsonBodyResult> {
  const raw = await readBody(req, maxBytes);
  return parseJsonBody(raw);
}

/**
 * Reads and discards a request body for mutation routes that ignore the
 * payload. Still capped — an oversized body rejects with
 * RequestTooLargeError, which propagates to the outer 413 handler exactly
 * as a direct readBody() call would.
 */
export async function readAndDiscardBody(req: IncomingMessage, maxBytes: number): Promise<void> {
  await readBody(req, maxBytes);
}

const RUN_SERVICE_UNAVAILABLE = { error: "RunService not available in this instance" };

/**
 * Guard for routes that require an injected RunService. Writes the pinned
 * 503 body and returns false when absent, narrowing `runService` to
 * non-null for the caller on success.
 */
export function requireRunService(
  runService: RunService | null,
  res: ServerResponse
): runService is RunService {
  if (!runService) {
    json(res, 503, RUN_SERVICE_UNAVAILABLE);
    return false;
  }
  return true;
}
