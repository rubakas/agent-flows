# 038. Global package and harness reach

| Field        | Value                            |
| ------------ | -------------------------------- |
| Feature Name | Global package and harness reach |
| Branch       | `feat/038-global-package`        |
| Status       | Draft                            |
| Created      | 2026-09-16                       |

## Context

Owner ask, verbatim (2026-09-16): "we need to complete the install/uninstall process ... we need to
somehow get the agent-flows from any harness claudecode,codex,opencode,t3code so we need to solve
the question - how to do this without explicit copy to each .claude .codex, etc folder, we need to
have a single source of agent-flows that can be reach by harness by default when starting it or via
chat".

`docs/research/2026-09-16-harness-discovery-mechanisms.md` answers the "how" for three of the four
harnesses (Claude Code, Codex CLI, OpenCode support user-scope MCP registration and skill symlinks;
T3 Code has none of its own and inherits whichever of those three it wraps) and
`docs/decisions/0018-one-global-install-harnesses-hold-pointers.md` records the resulting decision:
one global install, pointers not copies.

**Second owner decision, same day, changing the model further.** Owner's words, verbatim: "since we
will use a single source of installation there no need for install/uninstall of workflows. all
bundled workflows already installed. so we should be able to maybe enable or disable them, so they
are visible or invisible by harness chat. export or import custom one". With one global installation
there is no per-project install step any more: everything bundled is already present everywhere.
What replaces install is layering (D13), forking instead of installing to edit (D14), a visibility
toggle instead of an install/uninstall toggle (D15), and export/import as the only way workflows
move between machines (D16).

**Facts about the current state**, verified against the tree at `a1147cf` on branch
`feat/038-global-package` (2026-09-16):

- `bin/agent-flows` captures `$PWD` into `AGENT_FLOWS_PROJECT_DIR`, resolves its own symlink chain
  by hand, `cd`s to the resolved repo root, sources nvm and forces Node 22, then
  `exec ./node_modules/.bin/tsx src/cli.ts "$@"` (`bin/agent-flows:12-29`). It therefore requires a
  source checkout with installed `node_modules`. The file's own comment names the reason:
  better-sqlite3 is built for Node 22 (NODE_MODULE_VERSION 127) and the host's default node is 20,
  which fails with an ABI mismatch (`bin/agent-flows:1-4`).
- `scripts/mcp-serve.sh` and `scripts/install.sh` follow the same shape but
  `cd "$(dirname "$0")/.."` without symlink resolution, and exec `src/bindings/mastra/server.ts` and
  `src/install/run.ts` through the same local `tsx`.
- `package.json`: `"private": true` (`:3`) blocks publishing; `bin` maps `agent-flows` to
  `bin/agent-flows` (`:9-11`); there is no `files` field, and `.gitignore:2` is `dist/`, so `npm
pack` today falls back to git-tracked files and would ship a tarball with no `dist/` in it at all,
  silently; `tsx` is a devDependency (`:49`) although every entry point execs it at runtime;
  `engines.node >= 22` (`:6-8`); `pnpm.onlyBuiltDependencies: ["better-sqlite3"]` (`:53-57`) — a
  native module, and a pnpm-specific field that does nothing under `npm i -g`.
- `tsconfig.json` sets `outDir: "dist"`, `rootDir: "src"`, module/moduleResolution NodeNext, and no
  `allowJs` (`tsconfig.json:2-12`). `pnpm build` is bare `tsc`. `tsc` alone ships nothing that
  matters at runtime: the page is four hand-written ESM modules with `.d.ts` siblings
  (`src/serve/ui-route.js`, `ui-graph.js`, `ui-log.js`, `ui-tables.js`) plus `src/serve/ui.html`,
  none of which `tsc` emits without `allowJs`; `server.ts:651` reads the page as
  `join(__dirname, "ui.html")` and `:898` serves each static module as
  `join(dirname(ctx.uiPath), moduleName)` from the `STATIC_MODULES` map (`:131-136`) — under
  `dist/serve/` none of those five files would exist, so `GET /` and every module route would
  return 503. `pipelines/*.yaml` and `prompts/*.md` live outside `src` entirely and `tsc` never
  touches them either.
- `resolveCanonDir` (`src/bindings/mastra/pipelineLoader.ts:57-68`) returns the project's
  `.agent-flows/pipelines` when it exists and holds a YAML file, else `BUNDLED_PIPELINES_DIR` =
  `join(__dirname, "..", "..", "..", "pipelines")` computed from `import.meta.url`
  (`pipelineLoader.ts:7-11`). That depth is correct for `src/bindings/mastra/` and wrong for a
  compiled `dist/bindings/mastra/` unless the build preserves depth or the resolution changes. This
  same function is the "exclusive flip" D13 retires: one project YAML hides every bundled workflow.
- `src/install/run.ts:20-22` computes its own bundled dir independently: `repoRoot =
join(__dirname, "..", "..")`, duplicating the pattern.
- `src/bindings/write-cli.ts:17` calls `mkdirSync(join(repoRoot, ".claude", "workflows"), {recursive:
true})` at module load, before any argument is parsed, where `repoRoot` is the tool's own directory
  (`:12`); line 19 also calls `loadProviders(repoRoot)`, reading the tool's own provider profile
  rather than the project's.
- `resolveProjectDir()` (`src/bindings/mastra/projectDir.ts:21-36`) =
  `process.env.AGENT_FLOWS_PROJECT_DIR ?? process.cwd()`, throws when the resolved directory does
  not exist.
- The MCP server (`src/bindings/mastra/server.ts:220-232`) constructs `new MCPServer({id, name,
version, tools})` with six tools (`list_pipelines`, `run_pipeline`, `approve`, `get_run`,
  `cancel_run`, `decide_entry_point`) and passes no `instructions` field; `server.ts:234` calls
  `await server.startStdio()` at module top level with no guard.
- The MCP process never spawns the daemon; every tool reaches it over HTTP at
  `http://127.0.0.1:${AGENT_FLOWS_PORT ?? 7411}` (`src/bindings/mastra/daemonTools.ts:14`). With no
  daemon listening, every chat tool call fails immediately with
  `"agent-flows MCP: cannot reach daemon at ... — start it with \"agent-flows serve\" before using
run tools."` (`daemonTools.ts:24-29`; README.md:74 documents the same requirement).
- The daemon is per-project, not per-machine, and nothing in it identifies which project it is
  serving from the outside today. `server.ts:2349` resolves the project once at process start via
  `resolveProjectDir()` and threads it into `ctx.projectDir`; every handler that needs the project
  reads that field (`server.ts:1557, :1751, :2081, :2138, :2146, :2205, :2325`) — none derives a
  project from the request. The full route table has no `/health`, `/healthz`, `/status` or
  `/version` route (confirmed: none of those path literals appear in `server.ts`), and `GET /`
  returns 503 whenever the page assets are missing, so today nothing can serve as a probe. The
  `process.argv[1] === __filename` guard (`server.ts:2345`) and the equivalent in
  `src/doctor.ts:493-495` (`fileURLToPath(import.meta.url) === resolve(process.argv[1])`) are both
  false when the module is imported rather than run as the process entry point, so an import
  silently no-ops instead of starting the server.
- `GET /api/pipelines/:id/prompts` and `PUT /api/pipelines/:id/prompts/:stepId` both compute the
  prompts directory from the loaded pipeline's `filePath` (`server.ts:1069`, `:1141`), which in
  bundled mode points inside the installed package rather than a project directory; the PUT route
  already 403s when `resolve(ctx.pipelinesDir) === resolve(ctx.bundledPipelinesDir)`
  (`server.ts:1103`) before it reaches that computation — whether the GET (read) route carries the
  same guard is unconfirmed and is a Ship 1 verification item (FR-008), not an assumed fact. D14
  (fork) is the durable fix for the underlying risk; FR-008 is a stopgap for Ship 1, before D14
  lands in Ship 3.
- `src/canon/nest.ts` expands `kind: "pipeline"` steps and resolves `kind: "loop"` bodies through a
  `resolve: (pipelineId: string) => LoadedPipeline` callback supplied by its caller
  (`nest.ts:40-51`); today every caller backs that callback with a single directory's catalog. D13
  requires the callback to resolve against the three-layer merged view instead.
- `computeClosure` (`src/install/install.ts:36-60`) walks a pipeline's transitive closure of nested
  `pipeline`/`loop` steps and prompt references from one `bundledPipelinesDir`; it is called by
  `installWorkflow` (`install.ts:75-122`, used by `POST /api/install` at `server.ts:2053` and by the
  `install` CLI verb in `src/install/run.ts`) and, independently, by `exportBundle`
  (`src/install/bundle.ts:25,57`, used by `GET /api/export/:id` at `server.ts:2168-2188`). Deleting
  `installWorkflow` does not remove `computeClosure` — `exportBundle` still needs it.
- `POST /api/import` (`server.ts:2190-...`) calls `importBundle`, which carries the guards spec 037
  added: a path allowlist restricted to `pipelines/*.ya?ml`, `prompts/**` and `providers.yaml`
  entries, a normalisation gate rejecting any entry where `raw !== normalize(raw)`, and realpath
  containment after resolving the deepest existing ancestor (spec 037 FR-016). None of these guards
  change under this spec.
- `agent-flows generate claude` (`src/bindings/write-cli.ts:10-15`) derives `repoRoot` from its own
  module location and writes into `<checkout>/.claude/workflows/`, i.e. into the tool's own
  checkout, never into the target project.
- CLI verbs today (`src/cli.ts:41`): `doctor, serve, mcp, list, install, validate, generate`, with
  `list`/`install` both dispatching into `src/install/run.ts` (`cli.ts:94-100`). No
  init/setup/uninstall/stop/fork/enable/disable verb exists. `runModule()` (`src/cli.ts:60-72`)
  spawns `process.execPath --import tsx/esm <module>`, a second `tsx` layer on top of the wrapper
  script's own.
- README.md:118-144 documents MCP registration as a hand-written per-repository `.mcp.json` holding
  an absolute path to the checkout; README.md's Quickstart (roughly `:43-68`) walks through
  `agent-flows list` showing `[not installed]` per pipeline and `agent-flows install <id>` copying it
  into `<repo>/.agent-flows/` — the exact flow this spec's second amendment retires.
- There is no `skills/` directory and no `SKILL.md` file anywhere in the repository outside
  `node_modules`. Per D17, authoring one is out of scope for this spec: the owner's `agent-notes`
  project (source `/Users/en3e/code/rubakas/agent-notes`, remote
  `git@github.com:rubakas/agent-notes.git`, installed at 2.33.1) already owns every harness
  dot-directory — it writes `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `~/.claude/agents/`,
  `~/.claude/skills/<name>/`, and hook/permission entries in `~/.claude/settings.json`, across a CLI
  registry of four harness data directories (`~/.claude`, `~/.codex`, `~/.config/opencode`,
  `~/.github`) plus a universal mirror at `~/.agents/skills/`. It installs its own 24 skills as
  symlinks from its packaged `dist/skills/` by default. It manages no MCP servers at all (a search
  for `mcpServers`, `mcp add`, and `.mcp.json` across the installed package returned zero matches),
  and it has no third-party registration mechanism — its plugin system reads only from a directory
  inside its own package, so a foreign tool can only be added by editing `agent-notes` itself. A
  differently-named directory placed in `~/.claude/skills/` survives its install, regenerate, and
  default uninstall (removal only unlinks symlinks it recognises by name) — except that an install
  originally made in its copy mode, followed by its uninstall, deletes every entry in that directory
  indiscriminately, which is a second reason agent-flows does not place anything there.
- Env vars read anywhere in `src`: `AGENT_FLOWS_PROJECT_DIR`, `AGENT_FLOWS_PORT`,
  `AGENT_FLOWS_PROVIDER`, `AGENT_FLOWS_HOME`, `AGENT_FLOWS_PROJECT_KEY`, `AGENT_FLOWS_SKILLS_DIR`
  (`serve/server.ts:655`, defaults to `~/.claude`), `AGENT_FLOWS_TEMPLATES_DIR`,
  `AGENT_FLOWS_EVAL_OUT`, `AGENT_FLOWS_LIVE_TESTS`. `~/.agent-flows/workflows` (D13's user library)
  is a new directory, distinct from the existing `~/.agent-flows/templates`
  (`AGENT_FLOWS_TEMPLATES_DIR`) that spec 037's "Yours" template bundles already use — the two are
  not the same thing and this spec does not merge them.
- `resolveProjectState` (`src/runtime/projectState.ts:113-`) returns `{dir, runsDir, ...}` for the
  current project's per-project state directory; `dir` is where D15's `visibility.json` and D8's
  `daemon.json` both live.
- Existing install tests: `src/install/install.test.ts`, `src/install/paths.test.ts`,
  `src/install/installScript.test.ts`, `src/install/bundle.test.ts`, `src/cli.test.ts` (the last one
  asserts `bin/agent-flows` symlink resolution and that the bin is committed and wired). Fourteen
  test files derive a repo root from `import.meta.url` with fixed `..` hops,
  `src/serve/ui-style.test.ts:18-22` reads the page assets by filesystem path, and
  `src/cli.test.ts:310-344` spawns the real bin through a symlink and asserts exit 0 — the suite is
  structurally coupled to the layout this spec replaces, and migrating those tests onto the FR-004
  package-root helper is a Ship 1 work item (FR-009), not a surprise found later.

### Challenged and corrected

A devil pass attacked the first draft of this spec and an explorer pass confirmed every finding
against the code before this draft was written. Three ideas from the first draft were rejected:

- **Port-probe-only daemon auto-start was rejected.** The daemon is per-project (facts above); a
  port being open says nothing about which project's daemon is listening, so probing a port and
  reusing whatever answers would let a chat in project B silently run steps and write artifacts
  into project A's tree the moment both had ever used the same default port. D8 replaces the probe
  with an identity check.
- **In-process import of the CLI's verb modules (instead of spawning a child process) was
  rejected.** Two existing guards — `server.ts:2345` and `doctor.ts:493-495` — are false whenever
  their module is imported rather than run as the process entry point, so `serve`/`doctor` would
  exit 0 having done nothing; `mastra/server.ts:234` calls `startStdio()` unconditionally at import
  time, so importing it would hijack the CLI's own stdio. D4 keeps `runModule()` spawning a child
  process.
- **A `tsc`-only build was rejected.** `tsc` without `allowJs` never emits the four hand-written page
  modules, `ui.html`, or anything under `pipelines/`/`prompts/` — a `dist/`-only ship would 503 on
  every page route on first request. D2 adds an explicit copy step alongside `tsc`.

A second round on visibility design (D15) was scoped down by explicit owner instruction after an
initial, richer proposal (two scopes, re-enable across scopes, refusing a run whose entry point is
hidden): "don't overcomplicate for now with visibility." D15 as written below is the minimal version
that survived; the cut pieces are recorded as deferred, not rejected, in Risks and out of scope.

## Decisions

**D1 — One global source.** The package is the only copy of pipelines and prompts. Harnesses hold a
pointer — one MCP registration each (D10) — never a copy. Per ADR-0018; per D17, distributing a
skill is explicitly out of scope for this spec and belongs to `agent-notes` instead.

**D2 — The package ships compiled JavaScript plus a copied asset set.** `pnpm build` runs `tsc`, then
copies `src/serve/ui.html` and the four `ui-*.js` page modules verbatim into `dist/serve/` — they
stay hand-written JavaScript, never compiled, so the browser and the unit tests load the identical
bytes whether the suite runs from `src/` or `dist/`. `bin/agent-flows` runs the compiled `dist/`
output directly with a plain `#!/usr/bin/env node` shebang: no `tsx`, no `nvm` sourcing. The
`engines.node` floor of 22 is the contract; the bin checks `process.versions.node`'s major version
and, when it is below 22, re-execs itself under a compatible interpreter rather than refusing —
harnesses spawn the registered MCP command with their own PATH, which is commonly an older default
node, so refusing there would put the command out of reach of every harness. The search order is
`AGENT_FLOWS_NODE`, then any `node` on PATH other than the running one, then
`${NVM_DIR:-~/.nvm}/versions/node/v*` (exact major 22 first, then ascending majors above it), then
`/opt/homebrew/bin/node` and `/usr/local/bin/node`. A candidate qualifies only by running it: its
major version comes from `-p process.versions.node`, never from its path name, and it must then open
an in-memory database with the package's `better-sqlite3`. The version alone is not evidence — this
machine's Node 24.20.0 clears the floor of 22 and still fails `ERR_DLOPEN_FAILED` on a module built
for Node 22, which would break `serve` at its first query — so a highest-version-wins heuristic is
rejected in favour of the load probe, and the candidate order is only an optimisation. An explicitly
set `AGENT_FLOWS_NODE` that fails either test fails loudly naming it and the reason instead of
falling through to the search, a marker in the child's environment stops a second re-exec from
looping, and the success path prints nothing. Only when no interpreter qualifies does the bin exit
with a clear message, naming where it looked and, when that is what happened, saying that it found
Node 22+ interpreters but none of them could load the database module.

**D3 — Packaging allowlist.** `package.json`'s `files` field becomes the single enumerated allowlist
that decides what `npm pack` ships: `dist`, `pipelines`, `prompts`, `bin`, `README.md`, `LICENSE`.
This replaces today's silent fallback to `.gitignore`, which would ship a tarball with no `dist/` in
it at all.

**D4 — CLI verbs keep spawning a child process.** `runModule()` in `src/cli.ts` continues to `spawn`
each verb's compiled module as its own process (no `tsx` under the compiled build, but still a
`spawn`, never a direct `import`). Rationale: `server.ts:2345`'s and `doctor.ts:493-495`'s
"am I the process entry point" guards are both false on import, and `mastra/server.ts:234` starts
its stdio transport unconditionally at import time — switching to in-process import would silently
break `serve`, `doctor`, and `mcp` in three different ways.

**D5 — Asset resolution by package root, asserted.** A single helper resolves the package root by
walking up from `import.meta.url` to the nearest directory holding `package.json`, and every bundled
asset path (pipelines, prompts) derives from it; this is correct under `pnpm link`, `npm i
-g`, and the pnpm store layout, and works identically whether the caller runs under `tsx` (`src/`)
or compiled (`dist/`). The helper asserts the resolved root also contains both a `pipelines/` and a
`prompts/` directory, and throws a named error at startup otherwise — a `package.json` ever
appearing inside `dist/` would otherwise resolve silently to the wrong root. `pipelineLoader.ts`,
`install/run.ts`, and `write-cli.ts` (D12) all call it; each module's independently-computed
`repoRoot` is deleted.

**D6 — Package name `@rubakas/agent-flows`** (ASSUMPTION — matches github.com/rubakas/agent-flows;
the owner did not choose a name during this session, and this is reversible with a one-field
change). Not published to the public registry in this spec: install is `npm i -g <tarball>` or from
the git URL.

**D7 — The MCP `instructions` string is scoped to the project.** Built at MCP-process startup from
the layer resolution D13 replaces `resolveCanonDir` with: a short pointer (a few hundred bytes) when
the merged view is only the bundled layer (the common, unmodified case), the full text once the
project has been customized — a non-empty user library or a repository canon. _Amended by D13_:
the original condition was `resolveCanonDir`'s project/bundled flip (`source: "bundled"` vs
`source: "project"`); D13 retires that flip because the bundled set is now always visible, so the
short-pointer condition moves to "has anything beyond the bundled layer been added" instead — the
same motivation (pay for the fuller context only once a project has been customized) still holds.
The full text is tested under 2048 bytes (Claude Code's cap) with its first 512 bytes ending at a
sentence boundary and naming `decide_entry_point` as the first tool to call (Codex's guidance) —
content: what agent-flows is, that pipelines are long-running multi-step workflows over the user's
repo, which tool to call first, that `list_pipelines` enumerates what is installed, that runs are
durable and resumable, and that the human is asked to approve at gates.

**D8 — Daemon identity and per-project auto-start** (ASSUMPTION — the lead's recommendation, because
"reachable by default" is false if a chat tool call fails whenever the daemon is down; this replaces
a port-probe-only design rejected above for the wrong-project write risk it created). Shape:

- A new route `GET /api/daemon` returns `{projectDir, version, pid, startedAt}`. This one route is
  simultaneously the health probe, the identity handshake, and the version handshake — there is
  nothing else in the route table it could reuse (facts above).
- The daemon writes `<stateDir>/daemon.json` at listen time, mode 0600, holding the same fields plus
  `port`, and removes it on graceful exit. `<stateDir>` is the per-project state directory from
  `src/runtime/projectState.ts`.
- Port selection for `agent-flows serve` stays `--port`, then `AGENT_FLOWS_PORT`, then 7411 when
  free, then an OS-assigned ephemeral port. An auto-started daemon (no explicit `--port` or
  `AGENT_FLOWS_PORT`) always takes an ephemeral port, so it never collides with a human-launched
  daemon on the conventional port.
- The MCP process resolves its own project, reads that project's `daemon.json`, probes
  `GET /api/daemon`, and reuses the daemon only when the reported `projectDir` realpath equals its
  own **and** the reported `version` equals the package version. Anything else — a different
  project, a different version, no daemon.json, a probe that fails — is treated as "not our daemon."
- When there is no usable daemon, the MCP process spawns `agent-flows serve` detached, with
  `AGENT_FLOWS_PROJECT_DIR` set to its own project and stdio ignored, then polls
  `GET /api/daemon` until it matches or a bounded timeout elapses. A lock file in the state dir,
  created with `O_EXCL` and treated as stale after a timeout, stops two harnesses racing to start
  two daemons for the same project.
- A port already held by something that does not answer `GET /api/daemon` with a matching identity
  is never touched — not killed, not reused; the daemon being started simply takes a different
  (ephemeral) port. A running daemon reporting a different version is never killed and never
  silently used; the tool reports the running version and the expected one and tells the user to
  stop it (D9).
- `daemonTools.ts:14`'s hardcoded `AGENT_FLOWS_PORT ?? 7411` fallback is replaced by this
  resolution.

**D9 — `agent-flows stop`.** `stop` reads `daemon.json` for the current project, verifies the
identity of the process at that port via `GET /api/daemon`, terminates it, and removes the file.
`stop --all` performs the same for every project state directory under
`${AGENT_FLOWS_HOME ?? ~/.agent-flows}/projects/`. Without this, D8's auto-started daemons are
processes nobody can account for: they outlive the chat that started them, hold an open sqlite
handle, and after an upgrade keep serving old code forever.

**D10 — `agent-flows setup` registers the MCP server and nothing else; `agent-flows setup --remove`
reverses exactly those entries.** Per harness: Claude Code and Codex CLI through their own documented
CLIs (`claude mcp add <name> --scope user -- <cmd>`, `codex mcp add <name> -- <cmd>`) when that
binary is on PATH; OpenCode by a merge-edit of `~/.config/opencode/opencode.json` (its `mcp add` has
no documented non-interactive form) writing only the `mcp["agent-flows"]` key, after copying the file
to `<path>.bak` once. Before editing, `setup` detects whether the user's OpenCode configuration
actually lives in `opencode.jsonc` or `config.json` rather than `opencode.json`; if so it refuses to
create a second `opencode.json` that OpenCode would also load, and says so, rather than guessing at a
round-trip it cannot safely perform. T3 Code needs nothing of its own because it inherits its
provider's configuration.

Per D17, `setup` never writes into `~/.claude/skills`, `~/.agents/skills`, `~/.claude/agents`,
`~/.claude/rules`, `CLAUDE.md`, `AGENTS.md`, or any harness settings file — those directories belong
to `agent-notes`, and touching them would both duplicate what that tool already owns and risk being
swept by its own uninstall (D17).

Setup is idempotent: running it twice changes nothing and reports "already registered" per harness
it already touched. `agent-flows doctor` (D11) reports a registered MCP entry whose command is not
currently resolvable on PATH as stale — uninstalling the package without first running
`setup --remove` leaves every harness session reporting a failed MCP server forever, and this is the
detection path for that state; the README states the `setup --remove`-before-uninstall order
explicitly.

**D11 — `doctor` reports reach.** It prints, per harness, whether the binary is on PATH, whether our
MCP entry is registered and where, and whether that registration is stale (D10); plus, for the
current project, whether its daemon is listening (D8). It also checks `better-sqlite3` for an ABI
mismatch (a node version switch after install, e.g. via `nvm`, breaks the prebuilt native binary with
`ERR_DLOPEN_FAILED`/a `NODE_MODULE_VERSION` mismatch) and tells the user to reinstall the package
rather than attempting a rebuild. This is how the owner verifies an install without launching four
harnesses.

**D12 — `generate claude` targets the project, not the checkout, and does no filesystem work at
import time.** `write-cli.ts`'s top-level `mkdirSync` and `loadProviders(repoRoot)` (facts above)
both move behind argument parsing: the output directory resolves from `resolveProjectDir()` and the
provider profile loads from the project directory, not the package's own install location. Under a
global install with a root-owned prefix, the current top-level `mkdirSync` is an EACCES on every
invocation, including `--help`. The bundled pipelines it reads from still come from the package root
(D5).

**D13 — Three layers, later wins.** The visible set of workflows is the merge of three layers, in
this order, with a later layer winning on an id collision:

1. **bundled**, `<packageRoot>/pipelines` with its sibling `prompts`, always present, always
   read-only;
2. **user library**, `~/.agent-flows/workflows` (honouring `AGENT_FLOWS_HOME`), personal and
   machine-wide, distinct from the existing `~/.agent-flows/templates` bundle store;
3. **repository canon**, `<project>/.agent-flows/pipelines`, committed and shared with the team,
   when the project has one.

This replaces the exclusive flip in `resolveCanonDir` (`pipelineLoader.ts:57-68`), where the
presence of one project YAML hides every bundled workflow. That flip is exactly what made an install
step necessary in the first place, and it is what makes a package upgrade invisible to any project
that ever installed anything — the new bundled workflow simply never appears, because the project
layer alone still answers every query. Consequences:

- Prompts resolve within the layer that owns the pipeline, since the loader already takes the
  prompts directory as the sibling of the pipelines directory (facts above). A repo-layer pipeline
  never reads a bundled prompt by accident.
- Nested pipelines — the `pipeline` and `loop` step kinds — must resolve against the merged view
  rather than within a single layer, otherwise a forked parent in the repo layer cannot mount a
  bundled child. `nest.ts`'s `resolve` callback (facts above) and its caller in the loader take a
  directory today; this becomes a resolver over the merged view. This is the hardest part of the
  ship; FR-019 requires a test where a repo-layer pipeline mounts a bundled child and a
  user-library child.
- Id collisions are resolved silently by precedence, but `list` and the page show which layer each
  workflow came from and mark a bundled one that is shadowed by a same-id workflow in a later
  layer.

**D14 — Editing forks; the package is never written.** There is no install. Editing a bundled
workflow copies it, with its own prompt files and nothing else — not its transitive closure of
nested pipelines, since D13 already resolves nested mounts against the merged view — into a writable
layer, and the edit applies to the copy. The target layer is chosen by the caller: the repository
when the project has a canon directory or the user asks for it, otherwise the user library. A new
verb `agent-flows fork <id> [--to user|repo]` does this from the command line, and the editor's Save
on a bundled workflow does it on the page after asking which layer. The package directory is never a
write target under any code path. This is also the durable answer to the bundled-prompt write risk
flagged for Ship 1 (FR-008): FR-008 is a stopgap guard that ships before D14 lands.

**D15 — Visibility is one per-project list, minimal by owner instruction.** A single file
`<stateDir>/visibility.json` in the existing per-project state directory from
`src/runtime/projectState.ts`, holding `{"hidden": ["<id>", ...]}`, mode 0600, created on first
write. Absent means nothing is hidden. Unknown ids are ignored rather than an error, because a
workflow can disappear when a layer changes. Verbs `agent-flows enable <id>` and
`agent-flows disable <id>`; `agent-flows list` marks hidden rows.

It filters exactly two things: the MCP `list_pipelines` tool and the page's workflow list. It does
nothing else. It does not block running a workflow named explicitly by id, and it does not affect
nested `pipeline` or `loop` mounts. **Hiding is decluttering the chat surface, not access control —
no code path may later treat a hidden id as refused, only as unlisted.**

Explicitly cut from an earlier, richer proposal, and recorded here as deferred rather than rejected
so the reasoning is not lost (owner: "don't overcomplicate for now with visibility"): a
machine-wide scope, re-enable semantics across two scopes, and refusing a run whose entry point is
hidden. A global scope could be added later as a second file without changing this one.

**D16 — Import and export replace install.** `exportBundle` and `importBundle`
(`src/install/bundle.ts`), with the routes `GET /api/export/:id` and `POST /api/import`, become the
only way workflows move between machines and layers. Import gains a target layer parameter,
defaulting to the user library. Every guard spec 037 added to `importBundle` — the path allowlist,
the normalisation gate, the realpath containment (facts above, spec 037 FR-016) — applies unchanged.
`GET /api/export/:id` must resolve which layer owns the requested id via the D13 merged view before
calling `exportBundle`, rather than always passing the single `ctx.pipelinesDir` it uses today — once
three layers can each own different ids, "the" pipelines directory is no longer well-defined for an
arbitrary id.

**D17 — The two tools divide the machine.** `agent-flows` owns the package, the daemon, the
workflows, and the MCP server. `agent-notes` owns what lands in each harness's dot-directory. The two
do not overlap: `agent-notes` manages no MCP registration (facts above), and `agent-flows` installs
no skills, agents, or rules. Discovery from chat therefore rests entirely on the MCP `instructions`
string (D7), which every harness injects at session start and which `agent-notes` does not touch. If
a skill for `agent-flows` is wanted later, it belongs in `agent-notes`, which already distributes
skills to four harnesses; the natural shape is that `agent-flows`' package carries the skill text as
content and `agent-notes` installs it — that needs a change in `agent-notes` and is out of scope
here. Putting a foreign directory into `~/.claude/skills` would also be swept by an `agent-notes`
uninstall performed in its copy mode (facts above), which is a second, independent reason not to.

### What this removes

The `install` verb goes from `src/cli.ts:41,94-100`, and `POST /api/install` goes from the daemon
(`server.ts:2052-2089`); `src/install/run.ts` loses its `install` subcommand. `installWorkflow`
(`install.ts:75-122`) is deleted along with its only two callers and its test coverage in
`install.test.ts`. `computeClosure` (`install.ts:36-60`) is **kept** — `exportBundle` still calls it
(facts above) — so this is a partial deletion of `install.ts`, not a file removal. The README's
install-a-workflow walkthrough goes with it.

### What this supersedes

Spec 037 is already shipped. Its D3 ("Workflows view = the effective set the daemon runs") built the
Workflows page around the `resolveCanonDir` exclusive flip, with `Install`/`Install all` actions and
a two-radio install dialog for the bundled catalogue (spec 037 D3, D4). Under D13 the Workflows and
Templates views merge into one list of every workflow across all three layers, with a layer/source
badge and a per-row visibility toggle (D15) in place of the install actions; Templates becomes
import/export only, per D16. The shipped install dialog and the `POST /api/install` route (spec 037
FR-014) are removed, not left dead. This is noted in spec 037's own ledger and in the 027 handoff
(both cross-referenced below).

## Delivery

Five ships, in order:

- **Ship 1 — real package.** D1, D2, D3, D4, D5, D6, D12. FRs: FR-001–FR-009. Done means:
  `pnpm build` produces a `dist/` that `bin/agent-flows` runs directly with no `tsx`/`nvm` in the
  path and with `dist/serve/ui-*.js` byte-identical to `src/serve/`; `npm pack` produces a tarball
  whose contents match the D3 allowlist exactly and that installs globally into a temp prefix and
  runs `agent-flows list`/`doctor`/`serve` from a temp project containing no agent-flows checkout;
  `generate claude` writes into the target project and does no filesystem work before its arguments
  are parsed; the whole test suite runs unchanged against both `src/` and a built `dist/`.
- **Ship 2 — reachable by default.** D7, D8, D9. FRs: FR-010–FR-016. Done means: the MCP server's
  `instructions` string is scoped and passes its size/shape test; a chat tool call succeeds on a
  machine where the daemon for that project was not already running, with no manual
  `agent-flows serve` step; two harnesses starting at once for the same project do not race two
  daemons onto two ports; a daemon for a different project or a different version is never reused
  and never killed; `agent-flows stop`/`stop --all` account for every auto-started daemon.
- **Ship 3 — layers and visibility.** D13, D14, D15, D16. FRs: FR-017–FR-029. Done means: a project
  with no canon of its own sees the full bundled catalogue with no install step; a project with a
  repo canon sees its own workflows shadowing same-id bundled ones and everything else from bundled
  and the user library; `agent-flows fork` and the editor's Save-on-bundled both copy into a chosen
  layer and never touch the package directory; `agent-flows enable`/`disable` hide and unhide rows in
  `list_pipelines` and the page without affecting direct runs or nested mounts; export/import are the
  only cross-machine path and keep every spec 037 guard.
- **Ship 4 — setup/remove/doctor.** D10, D11, D17. FRs: FR-030–FR-032. Done means:
  `agent-flows setup` registers the MCP server with every installed harness and nothing else, and is
  idempotent; `agent-flows setup --remove` leaves each harness's config exactly as it was before
  setup ran, with no other harness-directory footprint to clean up; `agent-flows doctor` prints a
  per-harness reach report, flagging stale registrations and ABI mismatches.
- **Ship 5 — docs.** README and any other user-facing doc updated to describe global install +
  `setup`/`stop`/`fork`/`enable`/`disable` instead of the per-repository `.mcp.json` and
  install/uninstall walkthrough, and to state the `setup --remove`-before-uninstall order. No FRs of
  its own; gated on Ships 1-4 landing.

## Functional Requirements

- **FR-001.** `pnpm build` runs `tsc` and then copies `src/serve/ui.html` and the four `ui-*.js`
  page modules into `dist/serve/`; a test asserts each copied file in `dist/serve/` is byte-identical
  to its `src/serve/` source after a build (D2).
- **FR-002.** `bin/agent-flows` runs the compiled `dist/` output with a `#!/usr/bin/env node`
  shebang and requires neither `tsx` nor `nvm` sourcing (D2).
- **FR-003.** `bin/agent-flows` checks `process.versions.node`'s major version at startup; when it
  is below 22 it re-execs itself under the first qualifying interpreter it finds — `AGENT_FLOWS_NODE`,
  then PATH, then the nvm installs (exact major 22 first, then ascending majors above it), then
  `/opt/homebrew/bin/node` and `/usr/local/bin/node` — forwarding every argument and the environment,
  inheriting stdio and exiting with the child's status, and printing nothing on that path. An
  interpreter qualifies by being run, not by its version string: `-p process.versions.node` for the
  major, and then opening an in-memory database with the package's `better-sqlite3`, because a Node
  24 install passes the floor and still cannot load a module built for Node 22. When that module is
  not present under the package root there is nothing to probe and the version check stands alone.
  An `AGENT_FLOWS_NODE` that fails either test exits non-zero naming it and the reason rather than
  falling through, a re-exec marker in the child's environment prevents a second re-exec, and with
  nothing qualifying the bin exits non-zero with a message naming the required version (22), the
  version found, where it looked, and — when interpreters were found but none could load the module
  — that this is what happened (D2).
- **FR-004.** The package-root helper resolves the same logical root — the directory containing
  `package.json` — whether the caller is running under `tsx` (`src/`) or compiled (`dist/`), and
  throws a named error at startup if that root's directory does not also contain both `pipelines/`
  and `prompts/`; `pipelineLoader.ts`, `install/run.ts`, and `write-cli.ts` all call it, and each of
  their independent `repoRoot` computations is deleted (D5).
- **FR-005.** `package.json`'s `files` field ships exactly `dist/`, `pipelines/`, `prompts/`, and
  `bin/`, plus `README.md` and `LICENSE`, and nothing else (no `src/`, no test files, no
  `scripts/`); `name` is `@rubakas/agent-flows`; a packed tarball is asserted to contain
  `dist/serve/ui.html`, all four `dist/serve/ui-*.js`, every `pipelines/*.yaml`, and every
  `prompts/*.md`, and to contain no `specs/`, `docs/`, `src/`, or test file (D3, D6).
- **FR-006.** `runModule()` in `src/cli.ts` continues to `spawn` each verb's module as a separate
  process against the compiled build (no `tsx`); a regression test documents why by asserting that
  directly importing `src/serve/server.ts` or `src/bindings/mastra/server.ts` does not start a
  listener or an stdio transport, i.e. that the existing entry-point guards stay load-bearing (D4).
- **FR-007.** `agent-flows generate claude` does no filesystem work before its arguments are parsed
  (no top-level `mkdirSync`), resolves its output directory from `resolveProjectDir()` and writes
  `<project>/.claude/workflows/`, and loads its provider profile from the project directory rather
  than the package's own install location; the pipelines it reads still come from the package root
  via the FR-004 helper (D12).
- **FR-008.** Ship 1 includes a test proving whether `GET /api/pipelines/:id/prompts` is refused in
  bundled mode by the same `resolve(ctx.pipelinesDir) === resolve(ctx.bundledPipelinesDir)` guard
  family the `PUT` route already has at `server.ts:1103`; if the guard is absent on the `GET` route,
  Ship 1 adds it. Under a global install, "bundled" means the one shared package directory on the
  machine, so an unguarded write path here would let one project's edit change every project's
  prompts. This is a Ship 1 stopgap; D14 (Ship 3) is the durable fix once forking exists.
- **FR-009.** Ship 1 migrates the fourteen test files that derive a repo root from `import.meta.url`
  with fixed `..` hops, plus `src/serve/ui-style.test.ts` (page-asset path) and `src/cli.test.ts`
  (bin symlink + real spawn), onto the FR-004 package-root helper, so the suite passes unchanged
  whether it runs against `src/` (via `tsx`) or a built `dist/`.
- **FR-010.** The MCP server's `instructions` string is built at startup from the current merged
  view (D13): a short pointer when it is only the bundled layer, the full text once the project has
  anything beyond it; the full text is tested under 2048 bytes with its first 512 bytes ending at a
  sentence boundary and naming `decide_entry_point` (D7).
- **FR-011.** `GET /api/daemon` returns `{projectDir, version, pid, startedAt}`; the daemon writes
  `<stateDir>/daemon.json` (mode 0600) with those fields plus `port` at listen time and removes it on
  graceful exit (D8).
- **FR-012.** Port selection for `agent-flows serve` is `--port`, then `AGENT_FLOWS_PORT`, then
  7411 if free, then an OS-assigned ephemeral port; an auto-started daemon (no explicit `--port` or
  `AGENT_FLOWS_PORT`) always takes an ephemeral port (D8).
- **FR-013.** The MCP process resolves its own project, reads that project's `daemon.json`, probes
  `GET /api/daemon`, and reuses the daemon only when the reported `projectDir` realpath equals its
  own AND the reported `version` equals the package version; `daemonTools.ts`'s hardcoded
  `AGENT_FLOWS_PORT ?? 7411` fallback is replaced by this resolution (D8).
- **FR-014.** When no usable daemon is found, the MCP process spawns `agent-flows serve` detached
  with `AGENT_FLOWS_PROJECT_DIR` set to its own project and stdio ignored, then polls
  `GET /api/daemon` until it matches or a bounded timeout elapses; a lock file in the state dir,
  created with `O_EXCL` and treated as stale after a timeout, serializes two harnesses racing to
  start the daemon for the same project (D8).
- **FR-015.** A port already held by a process that does not answer `GET /api/daemon` with a
  matching identity is never touched; the daemon being started takes a different port instead. A
  running daemon reporting a different version is never killed and never silently reused — it is
  reported to the user by name and version (D8).
- **FR-016.** `agent-flows stop` reads the current project's `daemon.json`, verifies the identity of
  the process at the recorded port via `GET /api/daemon`, terminates it, and removes the file;
  `agent-flows stop --all` performs the same for every project state directory under
  `AGENT_FLOWS_HOME` (D9).
- **FR-017.** The merged view resolves the three D13 layers in precedence order (bundled < user
  library < repository canon), a later layer winning on an id collision; this replaces
  `resolveCanonDir`'s exclusive flip everywhere it is consumed (`GET /api/pipelines`, MCP
  `list_pipelines`, run entry resolution); an upgrade that adds a new bundled workflow becomes
  visible in a project that already has its own repository canon — the exact case the old exclusive
  flip broke (D13).
- **FR-018.** Prompts resolve as the sibling `prompts/` directory of the layer that owns the
  pipeline; a repository-layer pipeline never reads a bundled or user-library prompt file, and vice
  versa (D13).
- **FR-019.** `nest.ts`'s `resolve` callback and its caller in the loader take a resolver over the
  merged view rather than a single directory's catalog; a test proves a repository-layer pipeline can
  mount a bundled child and a user-library child as nested `pipeline`/`loop` steps in the same run
  (D13).
- **FR-020.** `agent-flows list` and the page's workflow list show the owning layer for every row and
  mark a bundled workflow that is shadowed by a same-id workflow in a later layer (D13).
- **FR-021.** `agent-flows fork <id> [--to user|repo]` copies exactly the named pipeline's YAML and
  its own prompt files (not its transitive closure of nested pipelines) into the target layer; the
  target defaults to the repository canon when the project has one, otherwise the user library
  (D14).
- **FR-022.** The editor's Save action on a bundled (or otherwise read-only) workflow first asks
  which layer to fork into, performs the fork, and then edits the copy — it never writes the source
  workflow in place (D14).
- **FR-023.** No code path writes into the package directory under any circumstance; a test asserts
  this against the FR-004 package-root resolution directly, pairing the Ship 1 assertion (a
  `package.json` inside `dist/` is rejected) with a Ship 3 assertion (nothing under the resolved
  package root is ever opened for writing) (D14).
- **FR-024.** `<stateDir>/visibility.json` holds `{"hidden": ["<id>", ...]}`, mode 0600, created on
  first write; its absence means nothing is hidden; an id in the file that does not exist in the
  current merged view is ignored, not an error (D15).
- **FR-025.** `agent-flows enable <id>` and `agent-flows disable <id>` edit the current project's
  `visibility.json`; `agent-flows list` marks a hidden row (D15).
- **FR-026.** Visibility filters exactly two surfaces — the MCP `list_pipelines` tool and the page's
  workflow list — and nothing else: a hidden workflow still runs when named explicitly by id, and a
  hidden workflow mounted as a nested `pipeline`/`loop` step by an enabled parent still executes
  (D15).
- **FR-027.** `POST /api/import` accepts an optional target layer, defaulting to the user library;
  every guard `importBundle` already enforces — the path allowlist, the normalisation gate, the
  realpath containment (spec 037 FR-016) — applies unchanged regardless of target layer (D16).
- **FR-028.** The `install` CLI verb, `POST /api/install`, and `installWorkflow` are removed, along
  with their dedicated test coverage; `computeClosure` is kept, with a test asserting `exportBundle`
  still depends on it, so its removal is never attempted by a future cleanup pass without noticing
  (D16).
- **FR-029.** `GET /api/export/:id` resolves which of the three layers owns the requested id via the
  D13 merged view before calling `exportBundle` with that layer's pipelines directory, rather than
  always using `ctx.pipelinesDir` (D16).
- **FR-030.** `agent-flows setup` registers Claude Code and Codex CLI via their own CLIs when the
  respective binary is on PATH, and OpenCode via a merge-edit of `~/.config/opencode/opencode.json`
  that touches only the `mcp["agent-flows"]` key, after writing a one-time `.bak` copy of that file;
  before editing, `setup` detects an existing `opencode.jsonc` or `config.json` and refuses with a
  clear message rather than creating a second config file that would also load; running `setup` a
  second time makes no further changes and reports "already registered" for every harness it already
  touched; `setup` writes to no other path — a test asserts it touches none of
  `~/.claude/skills`, `~/.agents/skills`, `~/.claude/agents`, `~/.claude/rules`, `CLAUDE.md`,
  `AGENTS.md`, or any harness settings file (D10, D17).
- **FR-031.** `agent-flows setup --remove` reverses exactly what `setup` wrote for each harness —
  the `claude mcp remove` / `codex mcp remove` equivalent, and deleting only the
  `mcp["agent-flows"]` key from the OpenCode config — leaving every other key in each harness's
  config unchanged (D10).
- **FR-032.** `agent-flows doctor` prints, per harness (Claude Code, Codex CLI, OpenCode, T3 Code):
  whether the harness's binary is on PATH, whether the `agent-flows` MCP entry is registered and at
  which config path, and whether that registration is stale (command not currently resolvable on
  PATH); separately, whether the current project's daemon is listening (via `daemon.json` +
  `GET /api/daemon`), and whether `better-sqlite3` shows a `NODE_MODULE_VERSION` mismatch against the
  running node, with a message to reinstall rather than rebuild (D11).

## Verification

- **V1.** `pnpm check` green.
- **V2.** Unit tests per FR: FR-001 (byte-identity after build), FR-002/FR-003 (bin shebang and
  version-gate), FR-004 (package-root helper resolved identically from a `src`-mode fixture and a
  `dist`-mode fixture, plus the missing-`pipelines/`-or-`prompts/` failure), FR-005 (`npm pack
--dry-run` file list matches exactly the allowed set), FR-006 (import-does-not-start regression),
  FR-007 (`generate claude` output directory, provider-profile source, no filesystem access before
  argument parsing), FR-008 (prompts GET route bundled-mode guard), FR-009 (migrated tests pass
  against both a `src` run and a built `dist` run), FR-010 (`instructions` size/shape and the
  bundled-vs-customized pointer switch), FR-011/FR-012 (`GET /api/daemon`, `daemon.json` contents and
  permissions, port-selection order), FR-013/FR-014 (identity match/mismatch against a fake
  `daemon.json`, spawn/poll/lock), FR-015 (foreign-port and foreign-version refusals), FR-016
  (`stop`/`stop --all` against fixture state dirs), FR-017 through FR-020 (layer precedence, prompt
  isolation, nested cross-layer resolution, layer/shadow display — see V6 for the live-shaped
  proofs), FR-021/FR-022 (fork verb and editor-fork payload), FR-023 (no-write-to-package-root),
  FR-024/FR-025 (visibility file shape and enable/disable verbs), FR-026 (see V6), FR-027 (import
  target layer plus unchanged guards), FR-028 (install removal plus the `computeClosure`
  still-needed assertion), FR-029 (export layer resolution), FR-030/FR-031 (setup/remove per harness
  against a temp `HOME`, including the idempotence case, the `.bak` write, the `.jsonc` refusal, and
  the no-other-path-touched assertion), FR-032 (`doctor`'s report against a temp `HOME` with a subset
  of harnesses "installed", and against a forced ABI-mismatch fixture).
- **V3.** A packaging proof executed by hand and recorded in the ledger: `npm pack`, install the
  tarball into a temp prefix, run `agent-flows doctor`, `agent-flows list`, `agent-flows serve` and
  one `agent-flows mcp` handshake from a temp project directory that contains no agent-flows
  checkout (FR-002 through FR-005, FR-007).
- **V4.** A harness proof recorded in the ledger: at least one harness started in a temp project
  shows the agent-flows tools and its scoped `instructions` block, and a chat tool call in that
  project auto-starts the daemon with no manual `agent-flows serve` step (FR-010, FR-013, FR-014,
  FR-030).
- **V5.** Mutation proofs for the new gates: neuter each new check — the Node-version gate, the
  `instructions` size assertion, the `files` allowlist, the package-root assertion, the daemon
  identity match, the lock file, the setup idempotence check, the `.bak` write, the `.jsonc` refusal,
  the stale-registration flag, the ABI-mismatch check, the FR-008 bundled-prompts guard, the layer
  precedence order, and the visibility filter — one at a time, confirm its own test goes red, then
  restore and confirm green.
- **V6.** Layering and visibility proofs, run live against a fixture project tree with all three
  layers populated: a merge test proving precedence across all three layers and the shadowed-bundled
  marker (FR-017, FR-020); a nesting test proving cross-layer mounts in both directions — a
  repository-layer parent mounting a bundled child, and a bundled parent mounting a user-library
  child (FR-019); a test that a disabled id is absent from `list_pipelines` and from the page's
  workflow list (FR-026); a test that the same id still runs when named explicitly despite being
  disabled (FR-026); a test that a hidden child still runs under an enabled parent (FR-026); a test
  that no code path writes into the package directory, paired with the FR-004 package-root assertion
  (FR-023); a test that an upgrade adding a new bundled workflow becomes visible in a project that
  already has its own repository canon (FR-017).

## Risks and out of scope

- `better-sqlite3` is native and must resolve a prebuilt binary or compile at global-install time —
  V3 proves it works or the spec records the fallback that was needed. A node version switch after
  install (e.g. via `nvm`) breaks the installed native binary with an ABI mismatch;
  `pnpm.onlyBuiltDependencies` is pnpm-specific and does nothing under `npm i -g` — D11's
  ABI-mismatch check in `doctor` is the mitigation, not a rebuild. FR-003's re-exec crosses that same
  boundary, so it proves a candidate by loading `better-sqlite3` rather than by its version: verified
  on the development machine, Node 24.20.0 fails `ERR_DLOPEN_FAILED` on the module built under Node
  22 while 22.17.1 loads it, so the highest-version heuristic would have handed every harness a
  `serve` that dies at its first query. `doctor`'s ABI check stays the diagnosis when no interpreter
  on the machine can load the module at all.
- OpenCode's non-interactive `mcp add` is undocumented (research §3.1, P18: "its flags/non-interactive
  form are not documented → UNVERIFIED"), so `setup` edits OpenCode's config as JSON directly rather
  than shelling out to `opencode mcp add`; if the user's OpenCode config is `opencode.jsonc` or
  `config.json`, `setup` refuses rather than guessing at a round-trip (D10).
- A stale MCP registration left behind by uninstalling the package without running
  `setup --remove` first makes every session of every harness that had it registered report a
  failed MCP server; per D17 this is the only footprint `agent-flows` leaves in any harness's
  configuration — no skill, no agent, no rule file — so it is also the only thing that can go stale.
  FR-032's stale-registration flag in `doctor` and the README's documented order are the mitigation,
  not a guarantee — nothing currently removes an entry automatically on uninstall.
- **Deferred from D15, not rejected** (owner: "don't overcomplicate for now with visibility"): a
  machine-wide visibility scope; re-enable semantics across two scopes (global list hides, project
  list re-shows); refusing a run whose entry point is hidden. A global scope can be added later as a
  second file (e.g. `~/.agent-flows/visibility.json`) without changing the per-project file's shape.
- Publishing to the public npm registry is out of scope; install is from a tarball or a git URL.
- T3 Code is verified only through whichever one provider is available in this environment — its own
  mechanism is "inherit the provider's configuration" (research §4), so there is no T3-specific
  registration to test beyond that provider's.
- Retiring the per-project `.mcp.json` from this repository is out of scope for this spec; D10 makes
  it optional, not forbidden.
- The D13 merged-view resolver touching `nest.ts` is the highest-risk code change in this spec — it
  changes how every existing pipeline's nested `pipeline`/`loop` steps resolve, not just newly forked
  ones; FR-019's cross-layer nesting test is the acceptance bar, not a nice-to-have.

## Delivery ledger

| Ship | Decisions     | FRs           | Commits |
| ---- | ------------- | ------------- | ------- |
| 1    | D1-D6, D12    | FR-001–FR-009 |         |
| 2    | D7-D9         | FR-010–FR-016 |         |
| 3    | D13-D16       | FR-017–FR-029 |         |
| 4    | D10, D11, D17 | FR-030–FR-032 |         |
| 5    | docs          | —             |         |
