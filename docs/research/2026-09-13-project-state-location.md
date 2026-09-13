# Where agent-flows should keep its files: project dir vs `~/.agent-flows/projects/<key>`

Research date: 2026-09-13 · Question (owner's words): "I'm not sure it's a good idea to have extra
files of our tool in the project dir; maybe it's better to have it like all other apps do, inside
`~/.agent-flows/projects`." · Compared against `src/bindings/mastra/pipelineLoader.ts`,
`src/runtime/artifactStore.ts`, `src/serve/server.ts`, `src/install/*`, `scripts/*.sh`, `.gitignore`,
and the documentation of twelve other developer tools.

## 0. Method, and what the markers mean

Part 1 is a code read of this checkout at `f966aef` plus `git check-ignore` / `git ls-files` /
`git worktree list` on this machine. Part 2 is a documentation read; where docs were silent, the
tool's own source was read instead. Nothing was executed against a user project.

- **[verified]** — read out of this repo's source (cited `file:line`), local git state, or a primary
  source listed in §4 (official docs or upstream source). Quotations are verbatim.
- **[inferred]** — my deduction from verified facts. An argument, not a fact.
- **[absent]** — searched the primary source for it and did not find it.

No credential file was opened. `~/.agent-flows/` does not exist on this machine [verified].

---

## 1. What agent-flows puts where today

**F1 — Canon: project first, bundled fallback.** [verified] `resolveCanonDir` prefers
`<project>/.agent-flows/pipelines/` "when it exists and contains at least one YAML file", else
`BUNDLED_PIPELINES_DIR` (`src/bindings/mastra/pipelineLoader.ts:57-67`, `:11`). Callers:
`src/bindings/mastra/server.ts:51,66`, `src/serve/server.ts:1713`.

**F2 — Run artifacts are in-project, and the runtime edits the project's ignore rules.** [verified]
`writeRunArtifact` defaults to `<project>/.agent-flows/runs/<runId>/<pipelineId>.json`
(`src/runtime/artifactStore.ts:103-104`) and after each write calls `ensureRunsGitignore` (`:110`),
which creates or appends `runs/` to `<project>/.agent-flows/.gitignore` (`:279-297`). Same default
in `src/runtime/runService.ts:999,1024` and the run-detail route `src/serve/server.ts:1112`.
Rationale, spec 029 FR-008 / Design A: an out-of-project cache dir was rejected because "the
operator cannot version them, share them with teammates, or use git to audit the record"
(`specs/029-stage-handoff/spec.md:41,48`).

**F3 — The tickets db is keyed to `cwd`, and the wrappers make `cwd` the tool's own checkout.**
[verified] Default `join(process.cwd(), "agent-flows.sqlite")` in `startServer`
(`src/serve/server.ts:404`) and the CLI (`:1715`, `--db` override). The Mastra libsql file is
derived from it — strip `.sqlite`/`.db`, append `-mastra.db` (`src/bindings/mastra/paths.ts:10-12`)
— and opened at `src/serve/server.ts:1738-1739`. `scripts/dev-serve.sh`, `mcp-serve.sh` and
`install.sh` each export `AGENT_FLOWS_PROJECT_DIR="${...:-$PWD}"` and then
`cd "$(dirname "$0")/.."` into the tool checkout before `exec`. Consequence [inferred]: steps run in
the user's project while the databases land in the tool checkout — which is why
`agent-flows.sqlite`, `agent-flows-mastra.db`, `-wal`, `-shm` sit in this repo root [verified: `ls`]
— so the tickets/drafts db is today **one global store per install**, not per project. Canon drafts
are rows in it (`src/canon/canonWriter.ts:131-136` reads `canonSource.root`).

**F4 — Project n8n id map is in-project and not ignored.** [verified]
`<project>/.agent-flows/n8n.json` = `{"workflows": {"<pipelineId>": "<n8nWorkflowId>"}}`
(`src/serve/server.ts:108-128`); spec 022 chose it over a db table because it "travels/deletes with
`.agent-flows/`" (`specs/022-template-library-and-n8n-roundtrip/spec.md:58`). `git check-ignore`
matches no rule for it. Ids are specific to one n8n instance; a foreign id 404s and is re-created
(`spec.md:39`), so committing it is harmless but churn-prone [inferred].

**F5 — Home-dir state is three things.** [verified] Templates `~/.agent-flows/templates/`
(`src/serve/server.ts:414-417`, `AGENT_FLOWS_TEMPLATES_DIR`); n8n credentials `~/.agent-flows/n8n.json`
mode 0600 (`src/serve/routes/n8n.ts:20-24,102`), placed there so "it can never be committed with a
project" (`specs/022:37`); read-only host skills at `~/.claude` (`server.ts:412`).

**F6 — Binding outputs go to the project root.** [verified] Binding A regenerates
`<root>/.claude/workflows/<id>.js` on every draft save (`src/canon/canonWriter.ts:141-144`;
`src/bindings/write-cli.ts:15`). Binding C writes `<root>/.n8n-workflows/*.json`
(`src/bindings/n8n/write-cli.ts:19`). Here, five workflow scripts are tracked; `.n8n-workflows/` is
ignored (`.gitignore:18`).

**F7 — `agent-flows install` copies canon, only canon.** [verified] `pipelines/<id>.yaml` plus the
transitive `prompts/*.md` closure into `<project>/.agent-flows/`, skip-if-exists
(`src/install/install.ts:82,105-119`; `run.ts:52`); `listInstalled` reads the same dir (`:132-140`);
bundle import targets the same root with escape checks (`bundle.ts:179`). Two operator files are
read from there too: `providers.yaml` (`src/canon/loadProviders.ts:48`), `config.json`
(`src/serve/server.ts:360`).

**F8 — The runtime already treats `.agent-flows/` as protected config.** [verified]
`**/.agent-flows/**` and its case variant are write-denied so "a write step that rewrites
checkCommand" cannot alter the next run (`src/canon/denyPatterns.ts:174-183`).

**F9 — Ignore rules.** [verified] This repo ignores `*.sqlite`, `*.sqlite-journal`, `mastra.db*`,
`*-mastra.db*`, `.n8n-workflows/` (`.gitignore:10-13,18`); nothing under `.agent-flows/`.
`.claude/worktrees/` is in `.git/info/exclude` and `**/.claude/settings.local.json` in
`~/.config/git/ignore` — Claude Code conventions, not ours. This checkout has no `.agent-flows/`.

### 1.1 Classification

| Path                                                      | Writer                        | Class                                                | Ignored today?                                     |
| --------------------------------------------------------- | ----------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `<project>/.agent-flows/pipelines/*.yaml`, `prompts/*.md` | `install.ts`, bundle, editor  | **(a)** versioned config                             | no — meant to be committed (README:68-70)          |
| `<project>/.agent-flows/providers.yaml`, `config.json`    | operator                      | **(a)** versioned config                             | no                                                 |
| `<project>/.agent-flows/.gitignore`                       | `artifactStore.ts:279` (auto) | **(a)** tool-generated, commit-able                  | no                                                 |
| `<project>/.agent-flows/runs/<runId>/*.json`, `manifest`  | `artifactStore.ts:103`        | **(b)** machine-local state                          | yes, via the auto-appended line                    |
| `<project>/.agent-flows/n8n.json`                         | `server.ts:126`               | **(b)** instance-local state                         | **no** (F4)                                        |
| `<cwd>/agent-flows.sqlite` (tickets, drafts, canon src)   | `server.ts:404,1715`          | **(b)** state                                        | only here (`*.sqlite`); a user project has no rule |
| `<cwd>/agent-flows-mastra.db{,-wal,-shm}`                 | `server.ts:1739`              | **(b)/(c)** engine state, regenerable                | only here (`*-mastra.db*`)                         |
| `<root>/.claude/workflows/*.js`                           | `canonWriter.ts:141`          | **(c)** derived, consumed in-project by the host CLI | no — tracked                                       |
| `<root>/.n8n-workflows/*.json`                            | `n8n/write-cli.ts:19`         | **(c)** derived                                      | yes                                                |
| `~/.agent-flows/templates/*.yaml`                         | `server.ts:1450`              | **(a')** user data                                   | n/a                                                |
| `~/.agent-flows/n8n.json`                                 | `routes/n8n.ts:102`           | **(d)** secret                                       | n/a — already outside every project                |

Net [inferred]: only class (a) has a reason to be in the project. (b)/(c) are there by design
(runs, n8n map) or by accident of `cwd` (both databases), and one (F4) is not ignored. F2's runtime
edit of a file inside the user's tracked tree has no precedent among the tools below.

---

## 2. How other developer tools split project dir vs home dir

Per tool: in-project (committed?) · home dir · per-project key · move / clone / worktree.

**F10 — Claude Code.** [verified] In-project: `CLAUDE.md` ("shared with your team through version
control"); `.claude/settings.json` ("Commit `.claude/settings.json` so everyone who clones the
repository gets the same permissions, hooks…"); `.claude/settings.local.json` — "Claude Code keeps
it out of git when it creates the file" by adding `**/.claude/settings.local.json` to the **global**
git excludes, never to the repo's `.gitignore`; `.claude/worktrees/<name>/` (a _tip_ says to
gitignore it yourself). Home: transcripts at `~/.claude/projects/<project>/<session-id>.jsonl`,
`<project>` being "your working directory path with non-alphanumeric characters replaced by `-`",
truncated to 200 chars plus a hash beyond that. Auto memory at `~/.claude/projects/<project>/memory/`
is instead "derived from the git repository, so all worktrees and subdirectories within the same
repo share one auto memory directory." Two keys: transcripts per directory, memory per repository.
Worktrees: the picker widens with `Ctrl+W`; `/cd` "relocates [the session] to the new directory's
project storage." Moves: new dir; old state ages out via `cleanupPeriodDays` (30 days) or
`claude project purge <path>`. Override: `CLAUDE_CODE_PROJECT_DIR_NAME` + `CLAUDE_CONFIG_DIR`.
Local `~/.claude/projects/-private-tmp-claude-501--Users-en3e-…` confirms the escaping.

**F11 — Codex CLI.** [verified] In-project: `AGENTS.md` walked "from the project root (typically
the Git root) … down to your current working directory"; `.codex/config.toml` "project-scoped
overrides" loaded "only when you trust the project." Home: `CODEX_HOME` (default `~/.codex`) "sets
the root for Codex state, including config, auth, logs, sessions, skills"; `CODEX_SQLITE_HOME`.
Key: cwd — "`codex resume` scopes `--last` to the current working directory unless you pass
`--all`"; "If the current working directory differs from the session's saved directory, Codex asks
which directory to use." Commit guidance for `AGENTS.md` [absent]; every example puts it in the repo.

**F12 — VS Code.** [verified] In-project: `.vscode/settings.json` — "When you add a Workspace
Settings `settings.json` file to your project or source control, the settings for the project will
be shared by all users of that project." Home: `~/Library/Application Support/Code/User/settings.json`
(macOS); per-workspace state under `<userData>/User/workspaceStorage/` (source:
`workspaceStorageHome = joinPath(this.appSettingsHome, 'workspaceStorage')`). Key (source,
`workspaces.ts`): `createHash('md5').update(folderUri.fsPath).update(ctime…)` — path **plus**
birthtime (macOS) / inode (Linux), so "folders getting recreated result in a different identifier."
A moved or re-cloned folder gets fresh state [inferred]. Override: `--user-data-dir`.

**F13 — git.** [verified] Linked worktree: a `.git` _file_ "containing
`gitdir: /path/main/.git/worktrees/<id>`"; `$GIT_DIR` is that private dir, `$GIT_COMMON_DIR` points
"back to the main worktree's `$GIT_DIR`." Per-worktree: `HEAD`, `index`, `logs/HEAD`,
`config.worktree`; shared: `objects`, `refs`, `config`, `hooks`. Moves: "If you manually move a
linked worktree, you need to update the `gitdir` file … Better yet, run `git worktree repair`";
stale entries are pruned unless `locked`. State next to the tree, shared state in one place,
explicit repair on move [inferred].

**F14 — direnv.** [verified] In-project: `.envrc`; layouts default to `$PWD/.direnv`
(`direnv_layout_dir()` in `stdlib.sh`). Home: "`$XDG_DATA_HOME/direnv/allow`: Records which `.envrc`
files have been `direnv allow`ed." Key (source, `rc.go`): `sha256(path + "\n" + content)`, file
named by the hash. Editing `.envrc` or moving the directory forces a fresh `direnv allow` — by
design, since "any git repo that you pull … would be able to wipe your hard drive once you `cd` into
it" [quote verified; consequence inferred].

**F15 — Terraform.** [verified] In-project: `.terraform/` ("cached provider plugins and modules …
which workspace is currently active … the last known backend configuration"; "automatically managed
by Terraform") and `.terraform.lock.hcl` ("You should include this file in your version control
repository"). `TF_DATA_DIR` relocates `.terraform` but "must be set consistently throughout all of
the Terraform workflow commands." Home: `plugin_cache_dir = "$HOME/.terraform.d/plugin-cache"` in
`~/.terraformrc`. Gitignoring `.terraform/` is not stated on the pages read [absent].

**F16 — pre-commit.** [verified] In-project: "Add a file called `.pre-commit-config.yaml` to the
root of your project." Home: "pre-commit by default places its repository store in
`~/.cache/pre-commit`", or `PRE_COMMIT_HOME` / `$XDG_CACHE_HOME/pre-commit`; `pre-commit gc` prunes.
Key: none — the cache is per hook repo, not per project.

**F17 — mise / asdf.** [verified] mise in-project: `mise.toml`, `.tool-versions` (committed),
`mise.local.toml` ("should not be committed to source control"); found by walking parents. Home,
XDG-split: `~/.config/mise`, `~/.cache/mise`, `~/.local/state/mise` ("trust records, tracked
configuration paths"), `~/.local/share/mise` ("tool installations, plugins, shims"). Trust keying
[absent]. asdf: `.tool-versions` per directory; `ASDF_DATA_DIR` default `$HOME/.asdf`.

**F18 — Docker Compose.** [verified] "By default, Compose assigns the project name based on the
name of the directory that contains the Compose file." Precedence: `-p`, `COMPOSE_PROJECT_NAME`,
`name:`, directory basename. "Compose uses a project name to isolate environments from each other."
Two same-named checkouts collide unless overridden [inferred].

**F19 — XDG Base Directory Specification.** [verified] `$XDG_CONFIG_HOME` (`~/.config`):
"user-specific configuration files." `$XDG_DATA_HOME` (`~/.local/share`): "user-specific data
files." `$XDG_STATE_HOME` (`~/.local/state`): "actions history (logs, history, recently used files,
…)" and "current state of the application that can be reused on a restart." `$XDG_CACHE_HOME`
(`~/.cache`): "user-specific non-essential (cached) data." Mapped onto §1.1: runs, manifests and
tickets are _state_; templates are _data_; mastra snapshots and binding outputs are _cache_ [inferred].

**F20 — Apple File System Programming Guide.** [verified] `~/Library/Application Support/<bundle-id>/`:
"all app-specific data and support files … that your app creates and manages on behalf of the user."
`~/Library/Caches/<bundle-id>/`: "cached data that can be regenerated as needed. Apps should never
rely on the existence of cache files."

**F21 — n8n.** [verified] "n8n saves user-specific data like the encryption key, SQLite database
file, and the ID of the tunnel (if used) in the subfolder `.n8n` of the user who started n8n."
`N8N_USER_FOLDER`: "Provide the path where n8n will create the `.n8n` folder." No project notion.

**F22 — Mastra.** [verified] `mastra dev`/`build` write `.mastra/output` in the project
(`MASTRA_DEV_NO_CACHE=1` rebuilds "the cached assets under `.mastra/`"). LibSQL `file:./mastra.db`;
"Relative paths like `file:./mastra.db` resolve based on each process's working directory, which
may differ" — absolute paths recommended. Gitignore guidance [absent]. Same cwd trap as F3 [inferred].

### 2.1 The pattern

[inferred from F10-F22] Every tool draws one line: **what a teammate needs to reproduce behaviour
is in the project and committed** (`.claude/settings.json`, `AGENTS.md`, `.vscode/settings.json`,
`.envrc`, `.terraform.lock.hcl`, `.pre-commit-config.yaml`, `mise.toml`, `compose.yaml`); **what
only this machine produced is under the home dir, keyed per project** (Claude Code transcripts and
memory, Codex sessions, VS Code workspaceStorage, direnv allow, pre-commit cache, mise state). Four
tools keep some machine-local state in-project (`.terraform/`, `.direnv/`, `.claude/worktrees/`,
`.mastra/`); each documents an env var to move it or tells the user to gitignore it — none appends
to the user's `.gitignore` at runtime. Claude Code, the nearest precedent for a runtime-managed
ignore, writes the _global_ excludes file.

Keys seen: escaped absolute path (Claude Code), cwd equality (Codex), path + inode/birthtime hash
(VS Code), path + content hash (direnv), git repository (Claude Code memory), directory basename
(Compose), explicit name (`CLAUDE_CODE_PROJECT_DIR_NAME`, `COMPOSE_PROJECT_NAME`, `TF_DATA_DIR`).
None keys on the remote URL.

---

## 3. Options for agent-flows

### O1 — Status quo

- Keeps spec 029 Design A: an operator can un-ignore `runs/` and commit an audit trail (F2).
- Keeps F3: one tickets db per install, shared by every project served, living in the tool
  checkout; launched without the wrappers it would land in a user project with no ignore rule
  [inferred].
- Keeps F4: `.agent-flows/n8n.json` committed by default.
- Keeps the one behaviour with no precedent in §2: a runtime write into the user's tracked tree.

### O2 — Wholesale move to `~/.agent-flows/projects/<key>/`, pipelines included

- Canon (F1) stops being versioned with the repo: no review or blame of a pipeline change, no
  teammate or clone receives it, and a second worktree runs whatever canon the key resolves to
  [inferred].
- Contradicts three standing positions [verified quotes, consequence inferred]: spec 013
  ("provider portability is the product's core property"); ADR-0011 (pipelines "are DATA under CRUD
  (edited as files in chat)" — the chat's cwd is the repo, not `~`); README:68 ("The files are
  yours to edit — that's the entire point").
- `install`/`list` (F7) become per-machine; F8's deny needs a home-dir twin (the codex profile
  already denies `$HOME`, `src/canon/workspace/codexProfile.ts:85`).
- No surveyed tool moves its _shared_ config out of the project (§2.1).

### O3 — Split: versioned canon in-project, machine-local state under `~/.agent-flows/projects/<key>/`

Stays in `<project>/.agent-flows/`: `pipelines/`, `prompts/`, `providers.yaml`, `config.json` —
the class (a) rows of §1.1, the shape of `.claude/` and `.vscode/`.

Moves to `~/.agent-flows/projects/<key>/`: `runs/<runId>/` and manifests (F2); `agent-flows.sqlite`
and the derived `-mastra.db` (F3 — `--db` default and `mastraDbPath` follow); `n8n.json` (F4); plus
a small `project.json` recording the resolved project path and creation time, so an orphaned key
dir after a move is self-describing (git's `worktrees/<id>/gitdir`, F13). Drafts are rows in the
sqlite db (F3) and move with it. Templates stay at `~/.agent-flows/templates/` (data, not
per-project); the credential stays at `~/.agent-flows/n8n.json` (F5).

Unchanged in the project root: `.claude/workflows/*.js` — Claude Code discovers workflow scripts in
the repo's `.claude/`, so that placement is host-owned (F6). `.n8n-workflows/` is an already-ignored
build artefact of a CLI that runs in the tool checkout (F9); it may follow later.

Consequences:

- `ensureRunsGitignore` is deleted; nothing in `<project>` is written at run time. Spec 029 FR-008 /
  Design A is superseded: "commit selected artifacts for audit" becomes an explicit
  `agent-flows runs export <runId> <dir>` — the trade Claude Code makes with `/export` versus
  `~/.claude/projects` (F10) [inferred].
- The tickets db becomes per-project instead of per-install (F3) — a fix, since ticket ids from
  unrelated repos share one table today [inferred]. `--db` stays for anyone who wants sharing.
- `.agent-flows/n8n.json` stops being committed (F4); two clones on one n8n instance each create
  their own workflow copy — already the two-machine behaviour today.
- One root to purge (`agent-flows project purge <path>`, cf. `claude project purge`, F10) and to
  sweep by age without touching the repo [inferred].
- Caches (mastra snapshots, future compiled bindings) can sit under the same key or under
  `~/.cache/agent-flows/<key>/` per F19; one root is simpler and sufficient at this scale [inferred].

### 3.1 Project key

| Scheme                                    | Repo moved                       | Second clone     | git worktree                | Two checkouts of one repo | Precedent                                              |
| ----------------------------------------- | -------------------------------- | ---------------- | --------------------------- | ------------------------- | ------------------------------------------------------ |
| Escaped absolute path                     | new key; old dir orphaned        | separate         | separate per worktree       | separate                  | Claude Code transcripts (F10)                          |
| `sha256(path)`                            | as above, but opaque             | separate         | separate                    | separate                  | VS Code adds inode (F12)                               |
| Resolved `git rev-parse --git-common-dir` | new key when main checkout moves | separate         | **shared** across worktrees | separate                  | Claude Code memory (F10)                               |
| Remote URL                                | stable                           | **collides**     | shared                      | **collides**              | none (§2.1)                                            |
| Explicit `AGENT_FLOWS_PROJECT_KEY`        | stable                           | operator decides | operator decides            | operator decides          | `CLAUDE_CODE_PROJECT_DIR_NAME`, `COMPOSE_PROJECT_NAME` |

[inferred] Runs describe one tree — the files a step read and wrote in one checkout — and
`AGENT_FLOWS_PROJECT_DIR` (`src/bindings/mastra/projectDir.ts:22`) already names a directory, not a
repository; per-checkout keying is the natural unit, and a "show all worktrees" widening (Claude
Code's `Ctrl+W`) can be layered on by matching common dirs recorded in `project.json`. Remote-URL
keying is used by no surveyed tool and collides on the ordinary two-checkouts case. The common-dir
scheme needs git, which `resolveProjectDir` does not (`projectDir.ts:22-36`), and it changes meaning
when the main checkout moves. A readable escaped path is browsable and greppable; Claude Code's
200-char truncate-plus-hash rule covers the length edge.

### 3.2 Migration

- On start, if `<project>/.agent-flows/runs/` exists and `<key>/runs/` does not: move it (rename;
  copy-then-delete across filesystems) and print one line naming both paths. Leave
  `<project>/.agent-flows/.gitignore` alone — it is the operator's file now; `doctor` may suggest
  removing it when it holds only the generated line.
- If both exist: legacy dir is read-only for listing, never written again.
- `agent-flows.sqlite` in a cwd: never auto-moved (it may be a deliberate shared `--db`); `doctor`
  reports it with the new default. An explicit `--db` is honoured unchanged.
- Back-compat window: one minor version of legacy reads, then the fallback is removed.

### 3.3 Recommendation

**O3 with the escaped-absolute-path key** (`realpath`-resolved, 200-char truncation plus a short
hash beyond that, `project.json` inside the key dir, `AGENT_FLOWS_PROJECT_KEY` as the explicit
override). In order of weight:

1. It is the line every surveyed tool draws (§2.1). The owner's instinct is right for classes
   (b)/(c) and wrong for class (a); O3 applies it to exactly the rows where it holds.
2. It removes two live defects — F3 (db keyed to the tool checkout, globally shared) and F4
   (instance-local ids committed) — and the one unprecedented behaviour (runtime append to a tracked
   `.gitignore`), without touching canon semantics, spec 013 portability, ADR-0011, or install/list.
3. The key matches the unit the runtime already uses (a directory) and the precedent with the most
   tooling around it (Claude Code's purge, retention sweep, cross-worktree widening). It degrades
   to an orphan `doctor` can list, never to a collision that mixes two projects' runs.

Files that would change (paths only):

- `src/bindings/mastra/projectDir.ts` (or new `src/runtime/projectState.ts`) — key derivation,
  `resolveProjectStateDir()`
- `src/runtime/artifactStore.ts` — default artifact dir; delete `ensureRunsGitignore`
- `src/runtime/runService.ts:999,1024` — artifact dir fallback
- `src/serve/server.ts:108-128,404,1112,1715` — n8n map path, db default, run route, CLI default
- `src/doctor.ts` — report state dir, legacy dirs, orphaned keys
- `src/canon/denyPatterns.ts` — add the state root to the write-deny list
- `scripts/dev-serve.sh`, `scripts/mcp-serve.sh` — no change (already export `AGENT_FLOWS_PROJECT_DIR`)
- Tests: `src/runtime/artifact.test.ts`, `src/serve/server.test.ts`, `src/serve/routes/n8n.test.ts`,
  `src/bindings/mastra/build.test.ts`
- Docs: `README.md:68-70,274,282`; `specs/029-stage-handoff/spec.md` FR-008 / Design A superseded;
  `specs/022-template-library-and-n8n-roundtrip/spec.md` FR-006; a new ADR for the split and key.

Not settled here: per-worktree vs per-repository default for the runs list; whether
`.n8n-workflows/` follows; whether runs get a retention sweep at all (they are audit material).

---

## 4. Sources consulted

**Primary — this repository at `f966aef`, and local git state.**

- `src/bindings/mastra/pipelineLoader.ts`, `projectDir.ts`, `paths.ts`, `server.ts`, `smoke.ts`;
  `src/runtime/artifactStore.ts`, `runService.ts`; `src/serve/server.ts`, `src/serve/routes/n8n.ts`;
  `src/install/install.ts`, `bundle.ts`, `run.ts`; `scripts/install.sh`, `dev-serve.sh`, `mcp-serve.sh`;
  `src/canon/canonWriter.ts`, `loadProviders.ts`, `denyPatterns.ts`, `workspace/codexProfile.ts`;
  `src/bindings/write-cli.ts`, `src/bindings/n8n/write-cli.ts`; `src/db/index.ts`
- `.gitignore`, `.git/info/exclude`, `~/.config/git/ignore` (ignore rules only), `git ls-files`,
  `git check-ignore -v`, `git worktree list`, `ls ~/.claude/projects`
- `specs/029-stage-handoff/spec.md`, `specs/022-template-library-and-n8n-roundtrip/spec.md`,
  `specs/013-provider-portable-templates/spec.md`, `docs/decisions/0011-chat-first-canon-and-bindings.md`,
  `docs/decisions/0003-spec-is-git-backed-sdd.md`, `README.md`

**Primary — official documentation and upstream source, fetched 2026-09-13.**

- Claude Code settings — https://code.claude.com/docs/en/settings
- Claude Code memory — https://code.claude.com/docs/en/memory
- Claude Code sessions (transcript path, `<project>` derivation) — https://code.claude.com/docs/en/sessions
- Claude Code `.claude` directory (application data, retention, purge) — https://code.claude.com/docs/en/claude-directory
- Claude Code worktrees — https://code.claude.com/docs/en/worktrees
- Claude Code data usage — https://code.claude.com/docs/en/data-usage
- Codex config reference — https://learn.chatgpt.com/docs/config-file/config-reference.md
- Codex config basics — https://learn.chatgpt.com/docs/config-file/config-basic.md
- Codex environment variables — https://learn.chatgpt.com/docs/config-file/environment-variables.md
- Codex AGENTS.md — https://learn.chatgpt.com/docs/agent-configuration/agents-md.md
- Codex CLI commands — https://learn.chatgpt.com/docs/developer-commands.md?surface=cli
- VS Code settings — https://code.visualstudio.com/docs/configure/settings
- VS Code workspaces — https://code.visualstudio.com/docs/editor/workspaces/workspaces
- VS Code extension data storage — https://code.visualstudio.com/api/extension-capabilities/common-capabilities
- VS Code CLI — https://code.visualstudio.com/docs/configure/command-line
- VS Code source, workspace id hashing — https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/workspaces/node/workspaces.ts
- VS Code source, `workspaceStorageHome` — https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/environment/common/environmentService.ts
- git-worktree — https://git-scm.com/docs/git-worktree
- gitrepository-layout — https://git-scm.com/docs/gitrepository-layout
- direnv manual — https://direnv.net/man/direnv.1.html
- direnv stdlib — https://direnv.net/man/direnv-stdlib.1.html
- direnv source, allow hash — https://raw.githubusercontent.com/direnv/direnv/master/internal/cmd/rc.go
- direnv source, `direnv_layout_dir` — https://raw.githubusercontent.com/direnv/direnv/master/stdlib.sh
- Terraform environment variables — https://developer.hashicorp.com/terraform/cli/config/environment-variables
- Terraform init — https://developer.hashicorp.com/terraform/cli/init
- Terraform dependency lock file — https://developer.hashicorp.com/terraform/language/files/dependency-lock
- Terraform CLI config — https://developer.hashicorp.com/terraform/cli/config/config-file
- pre-commit — https://pre-commit.com/
- mise directories — https://mise.jdx.dev/directories.html
- mise configuration — https://mise.jdx.dev/configuration.html
- mise trust — https://mise.jdx.dev/cli/trust.html
- asdf configuration — https://asdf-vm.com/manage/configuration.html
- Docker Compose project name — https://docs.docker.com/compose/how-tos/project-name/
- XDG Base Directory Specification — https://specifications.freedesktop.org/basedir/latest/
- Apple File System Programming Guide — https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html
- n8n deployment environment variables — https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/deployment.md
- n8n user folder — https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/configuration-examples/specify-user-folder-path.md
- Mastra storage — https://mastra.ai/en/docs/server-db/storage
- Mastra LibSQL reference — https://mastra.ai/en/reference/storage/libsql
- Mastra CLI — https://mastra.ai/en/reference/cli/mastra

**Secondary:** none used.

**Attempted and unreachable:** `docs.anthropic.com/en/docs/claude-code/*` (301 to `code.claude.com`),
`developers.openai.com/codex/*` (308 to `learn.chatgpt.com`), `docs.n8n.io/hosting/configuration/*`
(404; found via `docs.n8n.io/sitemap.md`), `mastra.ai/en/reference/cli/build` (404).
