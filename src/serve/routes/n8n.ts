// n8n connection config and fetch client (FR-004/FR-005/FR-011).
// A per-resource module: only ever invoked from server.ts's handleRequest,
// after the Host/content-type/Origin preamble has already run.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { json } from "../route-helpers.js";
import type { ServerResponse } from "node:http";

/**
 * The n8n global config file path. Lives in `~/.agent-flows/n8n.json`.
 * Format: `{"baseUrl": "...", "apiKey": "..."}`.
 *
 * The file is outside every project directory so it cannot be committed with a project.
 * The apiKey must NEVER appear in any response, error message, or log line.
 */
export const N8N_GLOBAL_CONFIG_PATH = join(homedir(), ".agent-flows", "n8n.json");

export interface N8nConfig {
  configured: true;
  /** Base URL of the n8n instance (no trailing slash). */
  baseUrl: string;
  /** API key for n8n — daemon-side only; NEVER sent to clients. */
  apiKey: string;
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
    return { configured: true, baseUrl: envUrl.replace(/\/+$/u, ""), apiKey: envKey };
  }
  if (!existsSync(N8N_GLOBAL_CONFIG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(N8N_GLOBAL_CONFIG_PATH, "utf8")) as Record<string, unknown>;
    const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.replace(/\/+$/u, "") : undefined;
    const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : undefined;
    if (!baseUrl || !apiKey) return null;
    return { configured: true, baseUrl, apiKey };
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
      error: `n8n is not configured — add a baseUrl and apiKey to ${N8N_GLOBAL_CONFIG_PATH}`,
    });
    return undefined;
  }
  return cfg;
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
