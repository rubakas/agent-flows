// Loads project-supplied model/profile overrides from .agent-flows/providers.yaml.
//
// Kept separate from registry.ts so all filesystem and yaml-parse code is
// isolated here, and registry.ts stays pure (no fs, no yaml, no I/O).
//
// A single readFile call inside try/catch avoids the TOCTOU race of
// exists-then-read and correctly distinguishes ENOENT ("absent") from EACCES
// ("permission denied"). Callers load this once at startup and thread the
// frozen result — no re-read per request or per run.

import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { builtInProfileIds } from "./registry.js";
import type { ModelEntry, ProviderConfig, ProviderProfile } from "./registry.js";
import type { Role } from "./types.js";

export type { ProviderConfig } from "./registry.js";

// ── Error classes ─────────────────────────────────────────────────────────────

/** YAML syntax error or invalid UTF-8 — distinct from a schema violation. */
export class ProvidersParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvidersParseError";
  }
}

/** A well-formed YAML mapping that violates the providers.yaml schema. */
export class ProvidersValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvidersValidationError";
  }
}

/** A filesystem error other than "the file is absent" (ENOENT/ENOTDIR). */
export class ProvidersIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvidersIoError";
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const PROVIDERS_RELATIVE_PATH = join(".agent-flows", "providers.yaml");

const ID_MAX_LEN = 100;
const ENDPOINT_MAX_LEN = 2048;
const KEYENV_MAX_LEN = 64;

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CLI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
// Any POSIX-style environment variable name. A stricter suffix rule would reject
// real names used by common providers that do not end in the same word.
const KEYENV_RE = /^[A-Z][A-Z0-9_]*$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const ROLE_KEYS: readonly Role[] = ["reasoner", "worker", "scout"];

// ── Validation helpers ────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(sourceLabel: string, fieldPath: string, reason: string): never {
  throw new ProvidersValidationError(`${sourceLabel}: ${fieldPath}: ${reason}`);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  sourceLabel: string,
  fieldPath: string
): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    fail(
      sourceLabel,
      fieldPath,
      `contains unknown key(s) "${unknown.join('", "')}" — allowed: ${allowed.join(", ")}`
    );
  }
}

function validateId(value: unknown, sourceLabel: string, fieldPath: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(sourceLabel, fieldPath, "must be a non-empty string");
  }
  if (value.length > ID_MAX_LEN) {
    fail(sourceLabel, fieldPath, `must be at most ${ID_MAX_LEN} characters`);
  }
  if (!ID_RE.test(value)) {
    fail(sourceLabel, fieldPath, "must be a canonical lowercase id (letters, digits, ._- only)");
  }
  return value;
}

function validateCliOrApiModel(
  value: unknown,
  sourceLabel: string,
  fieldPath: string
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    fail(sourceLabel, fieldPath, "must be a non-empty string");
  }
  if (value.length > ID_MAX_LEN) {
    fail(sourceLabel, fieldPath, `must be at most ${ID_MAX_LEN} characters`);
  }
  if (!CLI_MODEL_RE.test(value)) {
    fail(sourceLabel, fieldPath, "must not start with '-' and may contain only [A-Za-z0-9._:@/-]");
  }
  return value;
}

function validateEndpoint(value: unknown, sourceLabel: string, fieldPath: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(sourceLabel, fieldPath, "must be a non-empty string");
  }
  if (value.length > ENDPOINT_MAX_LEN) {
    fail(sourceLabel, fieldPath, `must be at most ${ENDPOINT_MAX_LEN} characters`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(sourceLabel, fieldPath, "must be an absolute URL");
  }
  if (url.username || url.password) {
    fail(sourceLabel, fieldPath, "must not include a userinfo component");
  }
  if (url.protocol === "https:") {
    // ok — any HTTPS endpoint is allowed
  } else if (url.protocol === "http:") {
    // http is restricted to loopback to prevent credentials leaking to LAN hosts
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      fail(
        sourceLabel,
        fieldPath,
        "http scheme is only allowed for a loopback host (localhost, 127.0.0.1, ::1)"
      );
    }
  } else {
    fail(sourceLabel, fieldPath, "scheme must be https, or http for a loopback host");
  }
  return value;
}

function validateKeyEnv(
  value: unknown,
  sourceLabel: string,
  fieldPath: string
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    fail(sourceLabel, fieldPath, "must be a non-empty string");
  }
  if (value.length > KEYENV_MAX_LEN) {
    fail(sourceLabel, fieldPath, `must be at most ${KEYENV_MAX_LEN} characters`);
  }
  if (!KEYENV_RE.test(value)) {
    fail(
      sourceLabel,
      fieldPath,
      'must match an environment variable name matching "^[A-Z][A-Z0-9_]*$"'
    );
  }
  return value;
}

function parseModelEntry(raw: unknown, index: number, sourceLabel: string): ModelEntry {
  const fp = `models[${index}]`;
  if (!isPlainObject(raw)) fail(sourceLabel, fp, "must be an object");
  const id = validateId(raw.id, sourceLabel, `${fp}.id`);

  const transportRaw = raw.transport;
  if (transportRaw !== "cli" && transportRaw !== "api") {
    fail(sourceLabel, `${fp}.transport`, 'must be "cli" or "api"');
  }
  const transport = transportRaw;

  if (transport === "cli") {
    rejectUnknownKeys(raw, ["id", "transport", "cli"], sourceLabel, fp);
    if (!isPlainObject(raw.cli)) fail(sourceLabel, `${fp}.cli`, 'is required for transport "cli"');
    rejectUnknownKeys(raw.cli, ["bin", "model"], sourceLabel, `${fp}.cli`);
    const binRaw = raw.cli.bin;
    if (binRaw !== "claude" && binRaw !== "codex") {
      fail(sourceLabel, `${fp}.cli.bin`, 'must be "claude" or "codex"');
    }
    const bin = binRaw;
    const model = validateCliOrApiModel(raw.cli.model, sourceLabel, `${fp}.cli.model`);
    return { id, transport, cli: { bin, ...(model !== undefined ? { model } : {}) } };
  }

  rejectUnknownKeys(raw, ["id", "transport", "api"], sourceLabel, fp);
  if (!isPlainObject(raw.api)) fail(sourceLabel, `${fp}.api`, 'is required for transport "api"');
  rejectUnknownKeys(raw.api, ["endpoint", "keyEnv", "model"], sourceLabel, `${fp}.api`);
  const endpoint = validateEndpoint(raw.api.endpoint, sourceLabel, `${fp}.api.endpoint`);
  const keyEnv = validateKeyEnv(raw.api.keyEnv, sourceLabel, `${fp}.api.keyEnv`);
  const model = validateCliOrApiModel(raw.api.model, sourceLabel, `${fp}.api.model`);
  return {
    id,
    transport,
    api: {
      endpoint,
      ...(keyEnv !== undefined ? { keyEnv } : {}),
      ...(model !== undefined ? { model } : {}),
    },
  };
}

function parseProfileEntry(raw: unknown, index: number, sourceLabel: string): ProviderProfile {
  const fp = `profiles[${index}]`;
  if (!isPlainObject(raw)) fail(sourceLabel, fp, "must be an object");
  rejectUnknownKeys(raw, ["id", "roles"], sourceLabel, fp);
  const id = validateId(raw.id, sourceLabel, `${fp}.id`);

  if (!isPlainObject(raw.roles)) fail(sourceLabel, `${fp}.roles`, "must be an object");
  const rawRoles = raw.roles; // extract to a local so TypeScript keeps the narrowed type
  rejectUnknownKeys(rawRoles, ROLE_KEYS, sourceLabel, `${fp}.roles`);
  const missing = ROLE_KEYS.filter((r) => !(r in rawRoles));
  if (missing.length > 0) {
    fail(
      sourceLabel,
      `${fp}.roles`,
      `must declare exactly reasoner, worker, scout — missing "${missing.join('", "')}"`
    );
  }

  const roles = {} as Record<Role, string>;
  for (const role of ROLE_KEYS) {
    const value = rawRoles[role];
    if (typeof value !== "string" || value.length === 0) {
      fail(sourceLabel, `${fp}.roles.${role}`, "must be a non-empty string");
    }
    // Any non-empty string is accepted — unknown ids pass through to the registry's
    // claude CLI passthrough (registry.ts:20-21), so the validator must not be
    // stricter than the runtime.
    roles[role] = value;
  }
  return { id, roles };
}

// ── Pure parser ───────────────────────────────────────────────────────────────

/**
 * Parses and validates providers.yaml content. No filesystem access, no
 * process.env — same input always yields the same output or the same throw.
 *
 * Exported for bundle import validation (bundle.ts calls this on bundled content
 * before writing any file to the project).
 */
export function parseProviders(text: string, sourceLabel: string): ProviderConfig {
  let raw: unknown;
  try {
    // maxAliasCount bounds anchor/alias expansion to prevent billion-laughs-style blowup.
    raw = parseYaml(text, { maxAliasCount: 100 });
  } catch (err) {
    const linePos = (err as { linePos?: { line: number; col: number }[] }).linePos?.[0];
    const where = linePos ? ` at line ${linePos.line}, column ${linePos.col}` : "";
    throw new ProvidersParseError(
      `${sourceLabel}: YAML parse error${where}: ${(err as Error).message}`
    );
  }

  // A zero-byte or comments-only file parses to null/undefined — not an error.
  if (raw === null || raw === undefined) return { models: [], profiles: [] };

  if (!isPlainObject(raw)) {
    fail(sourceLabel, "(document)", "must be a YAML mapping, not a sequence or scalar");
  }

  rejectUnknownKeys(
    raw,
    ["version", "models", "profiles", "defaultProvider"],
    sourceLabel,
    "(document)"
  );

  if (raw.version !== 1) {
    fail(sourceLabel, "version", "is required on a non-empty document and must equal 1");
  }

  const modelsRaw = raw.models ?? [];
  if (!Array.isArray(modelsRaw)) fail(sourceLabel, "models", "must be an array");
  const models: ModelEntry[] = [];
  const seenModelIds = new Set<string>();
  modelsRaw.forEach((m: unknown, i: number) => {
    const entry = parseModelEntry(m, i, sourceLabel);
    if (seenModelIds.has(entry.id)) {
      fail(sourceLabel, `models[${i}].id`, `duplicate id "${entry.id}"`);
    }
    seenModelIds.add(entry.id);
    models.push(entry);
  });

  const profilesRaw = raw.profiles ?? [];
  if (!Array.isArray(profilesRaw)) fail(sourceLabel, "profiles", "must be an array");
  const profiles: ProviderProfile[] = [];
  const seenProfileIds = new Set<string>();
  profilesRaw.forEach((p: unknown, i: number) => {
    const entry = parseProfileEntry(p, i, sourceLabel);
    if (seenProfileIds.has(entry.id)) {
      fail(sourceLabel, `profiles[${i}].id`, `duplicate id "${entry.id}"`);
    }
    seenProfileIds.add(entry.id);
    profiles.push(entry);
  });

  let defaultProvider: string | undefined;
  if (raw.defaultProvider !== undefined) {
    if (typeof raw.defaultProvider !== "string" || raw.defaultProvider.length === 0) {
      fail(sourceLabel, "defaultProvider", "must be a non-empty string");
    }
    // Validate against the union of project-declared and built-in profile ids.
    const availableProfileIds = new Set([...seenProfileIds, ...builtInProfileIds()]);
    if (!availableProfileIds.has(raw.defaultProvider)) {
      fail(
        sourceLabel,
        "defaultProvider",
        "does not name a profile in this file or a built-in profile"
      );
    }
    defaultProvider = raw.defaultProvider;
  }

  return { models, profiles, ...(defaultProvider !== undefined ? { defaultProvider } : {}) };
}

// ── Filesystem wrapper ────────────────────────────────────────────────────────

export interface LoadProvidersDeps {
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
}

/**
 * Reads and validates <projectDir>/.agent-flows/providers.yaml.
 *
 * Absent file → `{ models: [], profiles: [] }` (silent; behaviour unchanged from today).
 * Malformed file → throws ProvidersValidationError or ProvidersParseError loudly
 * (FR-003: never a silent fallback).
 *
 * Symlink containment mirrors the prompt-file guard in load.ts to prevent a
 * committed providers.yaml → ~/.ssh/id_rsa from being followed.
 */
export function loadProviders(projectDir: string, deps?: LoadProvidersDeps): ProviderConfig {
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const absPath = join(projectDir, PROVIDERS_RELATIVE_PATH);

  let text: string;
  try {
    text = readFile(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { models: [], profiles: [] };
    }
    throw new ProvidersIoError(
      `cannot read ${PROVIDERS_RELATIVE_PATH} (${code ?? "unknown error"})`
    );
  }

  // Symlink containment: a committed providers.yaml -> outside-project target must be rejected.
  if (!deps?.readFile) {
    let realProjectDir: string;
    let realFilePath: string;
    try {
      realProjectDir = realpathSync(projectDir);
      realFilePath = realpathSync(absPath);
    } catch (err) {
      throw new ProvidersIoError(
        `cannot resolve ${PROVIDERS_RELATIVE_PATH}: ${(err as Error).message}`
      );
    }
    const rootWithSep = realProjectDir.endsWith(sep) ? realProjectDir : realProjectDir + sep;
    if (!realFilePath.startsWith(rootWithSep)) {
      throw new ProvidersValidationError(
        `${PROVIDERS_RELATIVE_PATH}: resolves outside the project directory via symlink — rejected`
      );
    }
  }

  return parseProviders(text, PROVIDERS_RELATIVE_PATH);
}
