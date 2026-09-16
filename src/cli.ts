#!/usr/bin/env node
// Verb router for the agent-flows CLI.
//
// Usage:
//   agent-flows <verb> [args...]
//   agent-flows --help | -h
//
// Verbs:
//   doctor               run preflight checks
//   serve [--port N] [--db PATH]
//                        start the HTTP daemon
//   stop [--all]         stop this project's daemon (or every project's)
//   mcp                  start the MCP server
//   list                 list installed/available workflows
//   install [--overwrite-installed] [<id>...]
//                        install workflows into the project directory
//   validate             validate the canon pipelines
//   generate claude      generate Claude Code workflow bindings

// Each verb delegates to an existing module entry point rather than re-importing
// and wiring modules itself — this keeps the router thin and ensures the
// behaviour of each subcommand stays co-located with its implementation.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// When running through tsx (source mode), __filename ends in .ts; when running
// compiled output it ends in .js.  Use the same extension for all sibling
// module paths so both modes resolve to a file that actually exists.
const _ext = __filename.endsWith(".ts") ? ".ts" : ".js";

function src(...parts: string[]): string {
  const last = parts[parts.length - 1];
  const base = last.replace(/\.[tj]s$/, "");
  return join(__dirname, ...parts.slice(0, -1), base + _ext);
}

const VALID_VERBS = [
  "doctor",
  "serve",
  "stop",
  "mcp",
  "list",
  "install",
  "validate",
  "generate",
] as const;
const VALID_GENERATE_TARGETS = ["claude"] as const;

function usage(): void {
  console.log("Usage: agent-flows <verb> [args...]");
  console.log("");
  console.log("Verbs:");
  console.log("  doctor                        run preflight checks");
  console.log("  serve [--port N] [--db PATH]  start the HTTP daemon");
  console.log("  stop [--all]                  stop this project's daemon (or every project's)");
  console.log("  mcp                           start the MCP server");
  console.log("  list                          list installed/available workflows");
  console.log("  install [--overwrite-installed] [<id>...]");
  console.log("                                install workflows into the project");
  console.log("  validate                      validate the canon pipelines");
  console.log("  generate claude               generate Claude Code workflow bindings");
}

// Run a module as its own process, forwarding remaining args and inheriting
// stdio so that the subcommand controls its own output and exit code.
//
// Spawning, never importing (spec 038 D4): src/serve/server.ts and src/doctor.ts
// only act when they are the process entry point, and src/bindings/mastra/server.ts
// starts its stdio transport at import time — an in-process import would break
// serve, doctor and mcp in three different ways.
//
// Under tsx (source mode) the child needs the tsx ESM loader to read .ts; the
// compiled build is plain JavaScript and must be run without it, since tsx is a
// devDependency that an installed package does not have.
function runModule(modulePath: string, args: string[] = []): void {
  const loader = _ext === ".ts" ? ["--import", "tsx/esm"] : [];
  const child = spawn(process.execPath, [...loader, modulePath, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

const [, , verb, ...rest] = process.argv;

if (!verb || verb === "--help" || verb === "-h") {
  usage();
  process.exit(0);
}

switch (verb) {
  case "doctor":
    runModule(src("doctor.ts"));
    break;

  case "serve":
    runModule(src("serve", "server.ts"), rest);
    break;

  case "stop":
    runModule(src("serve", "stop.ts"), rest);
    break;

  case "mcp":
    runModule(src("bindings", "mastra", "server.ts"), rest);
    break;

  case "list":
    runModule(src("install", "run.ts"), ["list", ...rest]);
    break;

  case "install":
    runModule(src("install", "run.ts"), ["install", ...rest]);
    break;

  case "validate":
    runModule(src("canon", "validate-cli.ts"), rest);
    break;

  case "generate": {
    const target = rest[0];
    if (!target || target === "--help" || target === "-h") {
      console.error(
        `agent-flows generate: target required. Valid targets: ${VALID_GENERATE_TARGETS.join(", ")}`
      );
      process.exit(1);
    }
    if (target === "claude") {
      runModule(src("bindings", "write-cli.ts"), rest.slice(1));
    } else {
      console.error(
        `agent-flows generate: unknown target "${target}". Valid targets: ${VALID_GENERATE_TARGETS.join(", ")}`
      );
      process.exit(1);
    }
    break;
  }

  default:
    console.error(`agent-flows: unknown verb "${verb}". Valid verbs: ${VALID_VERBS.join(", ")}`);
    process.exit(1);
}
