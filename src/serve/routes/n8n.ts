// n8n connection config and fetch client (FR-004/FR-005/FR-011).
// A per-resource module: only ever invoked from server.ts's handleRequest,
// after the Host/content-type/Origin preamble has already run.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { json } from "../route-helpers.js";
import type { ServerResponse } from "node:http";

/**
 * Returns the path to the n8n global config file (`~/.agent-flows/n8n.json`).
 * Evaluated lazily on every call so tests can redirect HOME to a temporary
 * directory without the path being fixed at module import time.
 * The apiKey stored in this file must NEVER appear in any response, error
 * message, or log line.
 */
export function getN8nGlobalConfigPath(): string {
  // Prefer process.env.HOME so tests can isolate file writes without touching
  // the owner's real ~/.agent-flows/n8n.json.
  const home = process.env.HOME ?? homedir();
  return join(home, ".agent-flows", "n8n.json");
}

export interface N8nConfig {
  configured: true;
  /** Base URL of the n8n instance (no trailing slash). */
  baseUrl: string;
  /** API key for n8n — daemon-side only; NEVER sent to clients. */
  apiKey: string;
  /** Where the configuration came from — drives UI copy and form-disabled state. */
  source: "environment" | "file";
}

/**
 * Read the n8n connection config from env overrides first, then from disk.
 * Returns `null` when n8n is not configured. The returned `apiKey` must never
 * appear in any HTTP response, error message, or log line. Re-read on every
 * call — never memoized, so config edits and env changes take effect
 * immediately without a server restart.
 */
export function readN8nConfig(): N8nConfig | null {
  const envUrl = process.env.AGENT_FLOWS_N8N_URL;
  const envKey = process.env.AGENT_FLOWS_N8N_API_KEY;
  if (envUrl && envKey) {
    return {
      configured: true,
      baseUrl: envUrl.replace(/\/+$/u, ""),
      apiKey: envKey,
      source: "environment",
    };
  }
  const configPath = getN8nGlobalConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.replace(/\/+$/u, "") : undefined;
    const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : undefined;
    if (!baseUrl || !apiKey) return null;
    return { configured: true, baseUrl, apiKey, source: "file" };
  } catch {
    return null;
  }
}

/**
 * Guard for the three routes that require n8n to be configured (from-n8n,
 * workflows list, pipeline push). Writes the pinned 503 body and returns
 * undefined when absent. GET /api/n8n/status is NOT a caller of this guard —
 * it maps the same null config to 200 {configured:false} and calls
 * readN8nConfig() directly instead.
 */
export function requireN8nConfig(res: ServerResponse): N8nConfig | undefined {
  const cfg = readN8nConfig();
  if (!cfg) {
    json(res, 503, {
      error: `n8n is not configured — add a baseUrl and apiKey to ${getN8nGlobalConfigPath()}`,
    });
    return undefined;
  }
  return cfg;
}

/** Validate and normalise a candidate n8n base URL. */
export type UrlValidationResult = { ok: true; normalized: string } | { ok: false; error: string };

export function validateN8nBaseUrl(raw: string): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "baseUrl must be a valid URL (http or https)" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "baseUrl must use http or https" };
  }
  return { ok: true, normalized: raw.replace(/\/+$/u, "") };
}

/**
 * Write `{ baseUrl, apiKey }` to `~/.agent-flows/n8n.json` with mode 0600.
 * The directory is created (mode 0700) if absent. The apiKey must never appear
 * in any response or log line — this function only writes it to disk.
 */
export function writeN8nConfig(baseUrl: string, apiKey: string): void {
  const configPath = getN8nGlobalConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify({ baseUrl, apiKey }), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Remove `~/.agent-flows/n8n.json` if it exists. */
export function deleteN8nConfig(): void {
  const configPath = getN8nGlobalConfigPath();
  if (existsSync(configPath)) {
    unlinkSync(configPath);
  }
}

export interface FetchN8nInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Thin fetch wrapper: attaches the base URL and the X-N8N-API-KEY header
 * only. Per-route status-code mapping and error message strings stay at the
 * call sites, since the three consumer routes map failures differently.
 * Never attaches headers, the config object, or the apiKey to a
 * thrown/rejected error — fetch's own network-level rejection messages pass
 * through untouched, and those messages cannot contain the key.
 */
export function fetchN8n(cfg: N8nConfig, path: string, init: FetchN8nInit = {}): Promise<Response> {
  return fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), "X-N8N-API-KEY": cfg.apiKey },
  });
}
