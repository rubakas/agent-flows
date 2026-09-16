// FR-008: preflight doctor — checks external prerequisites and reports issues.
// FR-006: covers prerequisites for both Binding A (claude CLI) and Binding B (codex/ollama).

import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveProjectDir } from "./bindings/mastra/projectDir.js";
import { listPipelines, loadPipeline } from "./canon/load.js";
import { loadProviders } from "./canon/loadProviders.js";
import { defaultRegistry, getActiveProfile } from "./canon/registry.js";
import { packageVersion } from "./packageRoot.js";
import { classifyIdentity, probeDaemon, readDaemonRecord } from "./runtime/daemonRecord.js";
import { resolveProjectState } from "./runtime/projectState.js";
import { harnessReach, resolveSetupEnv, type HarnessReach } from "./setup/harnesses.js";
import type { ProviderConfig } from "./canon/registry.js";

const execFileAsync = promisify(execFile);
const _require = createRequire(import.meta.url);
const _doctorDir = dirname(fileURLToPath(import.meta.url));
const _repoRoot = join(_doctorDir, "..");

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorProbes {
  nodeVersion: () => string;
  which: (bin: string) => string | undefined;
  /** Returns all resolved locations of bin in PATH order. */
  whichAll: (bin: string) => string[];
  exec: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetchJson: (url: string) => Promise<unknown>;
  /** Tries to load better-sqlite3 for the active Node ABI; returns true if ok. */
  requireNative: () => boolean;
  /** Returns true if an HTTP server responds at baseUrl (any status code counts). */
  reachable: (baseUrl: string) => Promise<boolean>;
  /** Loads every pipeline in the pipelines/ directory; returns ids and any errors. */
  loadCanon: () => { loaded: string[]; failed: { file: string; error: string }[] };
  env: NodeJS.ProcessEnv;
  /** Project-level provider configuration; empty arrays when no providers.yaml is present. */
  providers: ProviderConfig;
  /** Per-harness MCP reach: binary on PATH, our entry, and whether it is stale (FR-032). */
  harnessReach: () => HarnessReach[];
  /** Whether this project's daemon is listening, via daemon.json + GET /api/daemon (FR-032). */
  projectDaemon: () => Promise<DaemonStatus>;
}

/** What the daemon record and the identity route say about this project (FR-032). */
export interface DaemonStatus {
  state: "listening" | "not-running" | "stale-record" | "mismatch";
  detail: string;
}

/**
 * One harness's reach, phrased so the failure is unambiguous at a glance: a
 * stale entry (its command no longer resolves) fails, because every session of
 * that harness reports a broken MCP server until it is fixed; an installed
 * harness with no entry only warns, because `setup` fixes it in one command.
 */
export function reachResult(reach: HarnessReach): CheckResult {
  const name = `${reach.label} (MCP)`;
  if (reach.note !== undefined) {
    return { name, status: "ok", detail: reach.note };
  }
  if (reach.binaryPath === undefined && !reach.registered) {
    return { name, status: "ok", detail: "not installed — nothing to register" };
  }
  const where = reach.configPath ?? "an unknown config";
  if (reach.registered && reach.stale) {
    return {
      name,
      status: "fail",
      detail: `registered in ${where} but STALE: ${reach.command?.[0] ?? "its command"} no longer exists`,
      hint: "agent-flows setup  (re-registers the current install)",
    };
  }
  if (reach.registered) {
    return {
      name,
      status: "ok",
      detail: `registered in ${where} → ${(reach.command ?? []).join(" ")}`,
    };
  }
  return {
    name,
    status: "warn",
    detail: `${reach.binaryPath ?? "installed"} — not registered`,
    hint: "agent-flows setup",
  };
}

export async function runDoctor(probes: DoctorProbes): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Node ≥ 22 (required)
  {
    const raw = probes.nodeVersion().replace(/^v/, "");
    const major = parseInt(raw.split(".")[0], 10);
    if (major >= 22) {
      results.push({ name: "Node.js ≥ 22", status: "ok", detail: `v${raw}` });
    } else {
      results.push({
        name: "Node.js ≥ 22",
        status: "fail",
        detail: `v${raw} (need ≥ 22)`,
        hint: "nvm install 22 && nvm use  (reads .nvmrc)",
      });
    }
  }

  // 2. pnpm on PATH (required)
  {
    const p = probes.which("pnpm");
    if (p) {
      results.push({ name: "pnpm", status: "ok", detail: p });
    } else {
      results.push({
        name: "pnpm",
        status: "fail",
        detail: "not found on PATH",
        hint: "corepack enable pnpm",
      });
    }
  }

  // 3. better-sqlite3 native ABI (required)
  {
    if (probes.requireNative()) {
      results.push({ name: "better-sqlite3 (native ABI)", status: "ok", detail: "loads ok" });
    } else {
      // Reinstall, never rebuild: a globally installed package has no build
      // step the user can re-run, and `pnpm rebuild` in some unrelated checkout
      // would not touch the copy the harnesses actually spawn (D11).
      results.push({
        name: "better-sqlite3 (native ABI)",
        status: "fail",
        detail: `ERR_DLOPEN_FAILED — NODE_MODULE_VERSION mismatch: this module was built for another Node than the running v${probes.nodeVersion().replace(/^v/, "")}`,
        hint: "reinstall the package under this Node (npm i -g @rubakas/agent-flows); do not try to rebuild it",
      });
    }
  }

  // 3b. Harness reach: is the MCP server registered where each harness looks (FR-032)?
  for (const reach of probes.harnessReach()) {
    results.push(reachResult(reach));
  }

  // 3c. This project's daemon (FR-032)
  {
    const daemon = await probes.projectDaemon();
    const status: CheckStatus =
      daemon.state === "listening" || daemon.state === "not-running" ? "ok" : "warn";
    results.push({
      name: "This project's daemon",
      status,
      detail: daemon.detail,
      hint:
        daemon.state === "stale-record" || daemon.state === "mismatch"
          ? "agent-flows stop  (then let the next tool call start a fresh daemon)"
          : undefined,
    });
  }

  // 4. Active provider + profile role transport prerequisites (required)
  {
    let profileOk = false;
    let profileId = "unknown";
    try {
      const profile = getActiveProfile(probes.env, probes.providers);
      const registry = defaultRegistry(probes.env, probes.providers.models);
      profileId = profile.id;

      const roles = (["reasoner", "worker", "scout"] as const).map((role) => ({
        role,
        modelId: profile.roles[role],
        entry: registry.resolve(profile.roles[role]),
      }));

      const roleStr = roles.map(({ role, modelId }) => `${role}=${modelId}`).join(", ");
      results.push({
        name: "Active provider",
        status: "ok",
        detail: `${profile.id} (${roleStr})`,
      });

      profileOk = true;

      // Check each unique transport required by this profile
      const checkedTransports = new Set<string>();
      for (const { entry } of roles) {
        if (entry.transport === "cli") {
          const bin = entry.cli!.bin;
          const key = `cli:${bin}`;
          if (checkedTransports.has(key)) continue;
          checkedTransports.add(key);

          const found = probes.which(bin);
          if (found) {
            results.push({
              name: `${profile.id}: ${bin} CLI transport`,
              status: "ok",
              detail: found,
            });
          } else {
            results.push({
              name: `${profile.id}: ${bin} CLI transport`,
              status: "fail",
              detail: `${bin} not found on PATH`,
              hint:
                bin === "claude"
                  ? "Install from https://docs.claude.com/en/docs/claude-code"
                  : "npm i -g @openai/codex && codex login",
            });
          }
        } else if (entry.transport === "api") {
          const baseUrl = new URL(entry.api!.endpoint).origin;
          const key = `api:${baseUrl}`;
          if (checkedTransports.has(key)) continue;
          checkedTransports.add(key);

          const ok = await probes.reachable(baseUrl);
          if (ok) {
            results.push({
              name: `${profile.id}: api transport`,
              status: "ok",
              detail: `${baseUrl} reachable`,
            });
          } else {
            results.push({
              name: `${profile.id}: api transport`,
              status: "fail",
              detail: `${baseUrl} unreachable`,
              hint: "Start the API service (e.g. ollama serve)",
            });
          }
        }
      }
    } catch (err) {
      results.push({
        name: "Active provider",
        status: "fail",
        detail: String(err instanceof Error ? err.message : err),
      });
    }

    void profileOk;
    void profileId;
  }

  // 5. claude CLI on PATH + logged in (required — Binding A)
  {
    const allClaudePaths = probes.whichAll("claude");
    const claudeBin = allClaudePaths[0];
    if (!claudeBin) {
      results.push({
        name: "claude CLI",
        status: "fail",
        detail: "not found on PATH",
        hint: "Install from https://docs.claude.com/en/docs/claude-code",
      });
    } else {
      // Fetch CLI version (first line of --version output)
      const versionResult = await probes.exec("claude", ["--version"]);
      const versionLine = versionResult.stdout.split("\n")[0].trim();

      // Detect shadowed installs — multiple distinct real paths in PATH order
      if (allClaudePaths.length > 1) {
        const realPaths = allClaudePaths.map((p) => {
          try {
            return realpathSync(p);
          } catch {
            return p;
          }
        });
        const distinctRealPaths = [...new Set(realPaths)];
        if (distinctRealPaths.length > 1) {
          results.push({
            name: "claude CLI shadowed",
            status: "warn",
            detail: allClaudePaths.join(", "),
            hint: "remove stale installs (e.g. `npm -g uninstall @anthropic-ai/claude-code` under old Node versions); the FIRST one in PATH is what will run",
          });
        }
      }

      // Auth check on the first-in-PATH binary
      const authResult = await probes.exec("claude", ["auth", "status", "--json"]);
      let loggedIn = false;
      if (authResult.code === 0) {
        try {
          const raw: unknown = JSON.parse(authResult.stdout);
          if (typeof raw === "object" && raw !== null && "loggedIn" in raw) {
            loggedIn = (raw as { loggedIn?: unknown }).loggedIn === true;
          }
        } catch {
          // unparseable output — treat as not logged in
        }
      }
      const versionSuffix = versionLine ? ` (${versionLine})` : "";
      if (loggedIn) {
        results.push({ name: "claude CLI", status: "ok", detail: `${claudeBin}${versionSuffix}` });
      } else {
        results.push({
          name: "claude CLI",
          status: "fail",
          detail: `found at ${claudeBin}${versionSuffix} but not logged in`,
          hint: "claude auth login",
        });
      }
    }
  }

  // 6. codex CLI + codex doctor (optional → warn — Binding B visibility)
  {
    const codexBin = probes.which("codex");
    if (!codexBin) {
      results.push({
        name: "codex CLI",
        status: "warn",
        detail: "not found on PATH",
        hint: "npm i -g @openai/codex && codex login",
      });
    } else {
      const doctorResult = await probes.exec("codex", ["doctor"]);
      if (doctorResult.code === 0) {
        results.push({ name: "codex CLI", status: "ok", detail: codexBin });
      } else {
        results.push({
          name: "codex CLI",
          status: "warn",
          detail: `codex doctor exited ${doctorResult.code}`,
          hint: "npm i -g @openai/codex && codex login",
        });
      }
    }
  }

  // 7. Ollama reachable + model qwen2.5:1.5b present (optional → warn)
  {
    const ollamaBase = probes.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const modelName = "qwen2.5:1.5b";
    try {
      const tags = (await probes.fetchJson(`${ollamaBase}/api/tags`)) as {
        models?: { name: string }[];
      };
      results.push({ name: "Ollama", status: "ok", detail: `reachable at ${ollamaBase}` });
      const hasModel = tags.models?.some((m) => m.name === modelName) ?? false;
      if (hasModel) {
        results.push({ name: `Ollama model ${modelName}`, status: "ok", detail: "present" });
      } else {
        results.push({
          name: `Ollama model ${modelName}`,
          status: "warn",
          detail: "not found",
          hint: `ollama pull ${modelName}`,
        });
      }
    } catch {
      results.push({
        name: "Ollama",
        status: "warn",
        detail: `unreachable at ${ollamaBase}`,
        hint: "brew install ollama && brew services start ollama",
      });
      results.push({
        name: `Ollama model ${modelName}`,
        status: "warn",
        detail: "cannot check (Ollama unreachable)",
        hint: `ollama pull ${modelName}`,
      });
    }
  }

  // 8. LiteLLM reachable (optional → warn)
  {
    const litellmBase = probes.env.LITELLM_BASE_URL ?? "http://localhost:4000";
    try {
      await probes.fetchJson(`${litellmBase}/health/liveliness`);
      results.push({ name: "LiteLLM", status: "ok", detail: `reachable at ${litellmBase}` });
    } catch {
      results.push({
        name: "LiteLLM",
        status: "warn",
        detail: `unreachable at ${litellmBase}`,
        hint: "docker compose up -d litellm",
      });
    }
  }

  // 9. Canon: all pipelines load without error (required)
  {
    const canon = probes.loadCanon();
    if (canon.failed.length === 0 && canon.loaded.length > 0) {
      results.push({
        name: "Canon (pipelines)",
        status: "ok",
        detail: `${canon.loaded.length} pipeline(s) loaded: ${canon.loaded.join(", ")}`,
      });
    } else if (canon.failed.length === 0 && canon.loaded.length === 0) {
      results.push({
        name: "Canon (pipelines)",
        status: "warn",
        detail: "no pipeline files found in pipelines/",
        hint: "add at least one .yaml file to pipelines/",
      });
    } else {
      for (const { file, error } of canon.failed) {
        results.push({
          name: "Canon (pipelines)",
          status: "fail",
          detail: `${file}: ${error}`,
        });
      }
      if (canon.loaded.length > 0) {
        results.push({
          name: "Canon (pipelines)",
          status: "ok",
          detail: `${canon.loaded.length} pipeline(s) loaded: ${canon.loaded.join(", ")}`,
        });
      }
    }
  }

  // 11. Layer-0: OPENAI_API_KEY / ANTHROPIC_API_KEY must NOT be in env (required)
  {
    const leaked = (["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const).filter(
      (k) => k in probes.env && Boolean(probes.env[k])
    );
    if (leaked.length === 0) {
      results.push({
        name: "Layer-0 key isolation",
        status: "ok",
        detail: "no provider keys in env",
      });
    } else {
      results.push({
        name: "Layer-0 key isolation",
        status: "fail",
        detail: `${leaked.join(", ")} found in env — keys belong in LiteLLM only`,
        hint: `unset ${leaked.join(" ")}`,
      });
    }
  }

  return results;
}

export function defaultProbes(): DoctorProbes {
  return {
    nodeVersion: () => process.version.slice(1),

    which: (bin) => {
      try {
        const result = execFileSync("which", [bin], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return result || undefined;
      } catch {
        return undefined;
      }
    },

    whichAll: (bin) => {
      try {
        const result = execFileSync("bash", ["-lc", `which -a ${bin}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return result ? result.split("\n").filter(Boolean) : [];
      } catch {
        return [];
      }
    },

    exec: async (cmd, args) => {
      try {
        const result = await execFileAsync(cmd, args, { encoding: "utf8" });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (err: unknown) {
        const e = err as { code?: string | number; stdout?: string; stderr?: string };
        return {
          code: typeof e.code === "number" ? e.code : 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
        };
      }
    },

    fetchJson: async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json() as Promise<unknown>;
    },

    requireNative: () => {
      try {
        const Database = _require("better-sqlite3") as (path: string) => { close(): void };
        const db = Database(":memory:");
        db.close();
        return true;
      } catch {
        return false;
      }
    },

    reachable: async (baseUrl) => {
      try {
        await fetch(baseUrl);
        return true;
      } catch {
        return false;
      }
    },

    loadCanon: () => {
      const pipelinesDir = join(_repoRoot, "pipelines");
      const loaded: string[] = [];
      const failed: { file: string; error: string }[] = [];
      let files: string[];
      try {
        files = listPipelines(pipelinesDir);
      } catch (err) {
        return {
          loaded,
          failed: [{ file: pipelinesDir, error: String(err instanceof Error ? err.message : err) }],
        };
      }
      for (const file of files) {
        try {
          const pipeline = loadPipeline(file);
          loaded.push(pipeline.def.id);
        } catch (err) {
          failed.push({ file, error: String(err instanceof Error ? err.message : err) });
        }
      }
      return { loaded, failed };
    },

    harnessReach: () => harnessReach(resolveSetupEnv()),

    projectDaemon: async () => {
      const projectDir = resolveProjectDir();
      const state = resolveProjectState(projectDir);
      const record = readDaemonRecord(state.dir);
      if (record === undefined) {
        return {
          state: "not-running",
          detail: `not running — no ${join(state.dir, "daemon.json")} (a tool call starts one)`,
        };
      }
      const identity = await probeDaemon(record.port);
      if (identity === undefined) {
        return {
          state: "stale-record",
          detail: `daemon.json records pid ${record.pid} on port ${record.port}, but nothing answers there`,
        };
      }
      const verdict = classifyIdentity(identity, { projectDir, version: packageVersion() });
      if (verdict === "match") {
        return {
          state: "listening",
          detail: `listening on port ${record.port} (pid ${identity.pid}, version ${identity.version})`,
        };
      }
      return {
        state: "mismatch",
        detail:
          verdict === "other-project"
            ? `port ${record.port} serves ${identity.projectDir}, not this project`
            : `port ${record.port} runs agent-flows ${identity.version}, not ${packageVersion()}`,
      };
    },

    env: process.env,
    providers: loadProviders(_repoRoot),
  };
}

export function formatReport(results: CheckResult[]): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`  ${icon[r.status]} ${r.name.padEnd(40)} ${r.detail}`);
    if (r.hint) {
      lines.push(`      hint: ${r.hint}`);
    }
  }
  return lines.join("\n");
}

export function hasFailures(results: CheckResult[]): boolean {
  return results.some((r) => r.status === "fail");
}

// ── Entry point (tsx src/doctor.ts) ──────────────────────────────────────────
const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const results = await runDoctor(defaultProbes());
  console.log(formatReport(results));
  if (hasFailures(results)) process.exit(1);
}
