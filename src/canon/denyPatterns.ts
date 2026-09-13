// Project-wide credential and build-config deny patterns, plus the operator's own
// settings deny rules. Extracted from runStep.ts (spec 031 D1) so the provider
// adapters and the canon loader can share them without importing the executor.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Files a workspace step may never read OR write, even when
 * `permissions.contents` is granted. Applied via `--disallowedTools` as
 * `Read(pattern)`, `Grep(pattern)` and `Edit(pattern)` entries on every claude
 * CLI invocation. Grep is denied alongside Read because content search would
 * otherwise return lines from inside a file the step may not open; the
 * `Edit(pattern)` entries are emitted only when a workspace is resolved.
 *
 * Named files and file types only — deliberately no keyword wildcards. A
 * pattern like `*token*` reads as thorough but denies ordinary source such as
 * `tokenizer.ts`, so an investigation silently loses part of the codebase it
 * was asked to study. A miss here is visible and fixable by adding a line; a
 * wildcard's damage is invisible.
 *
 * Add a line when a project keeps secrets somewhere this does not name.
 *
 * Separate from BUILD_CONFIG_DENY_PATTERNS: credential files must be unreadable
 * as well as unwritable. Build config files must stay readable (steps
 * legitimately need to understand them) but must not be editable.
 */
export const CREDENTIAL_DENY_PATTERNS: readonly string[] = [
  // Environment files. Each real variant is named; `.env.example`,
  // `.env.sample` and `.env.template` are deliberately absent — a template
  // holds placeholders, and a step needs it to understand configuration.
  "**/.env",
  "**/.env.ci",
  "**/.env.docker",
  "**/.env.production",
  "**/.env.prod",
  "**/.env.staging",
  "**/.env.stage",
  "**/.env.preview",
  "**/.env.local",
  "**/.env.development",
  "**/.env.dev",
  "**/.env.test",
  // direnv's `.envrc` is a shell script, not a dotenv file, and routinely
  // exports secrets — the `.env*` spellings above do not cover it.
  "**/.envrc",

  "**/aws.json",
  "**/credentials",
  "**/credentials.production",
  "**/credentials.staging",
  "**/credentials.json",
  "**/credentials.toml",
  "**/credentials.yaml",
  "**/credentials.yml",
  "**/credentials.ini",
  "**/secrets.json",
  "**/secrets.yaml",
  "**/secrets.yml",
  "**/secrets.toml",
  "**/secrets.ini",
  "**/secret.json",
  "**/secret.yaml",
  "**/token.json",
  "**/token.yaml",
  "**/token.yml",
  "**/tokens.json",
  "**/service-account*.json",
  "**/terraform.tfvars",
  "**/terraform.tfvars.json",
  "**/secrets.tfvars",
  "**/*.auto.tfvars",
  "**/*.auto.tfvars.json",
  "**/*.tfstate",
  "**/*.tfstate.backup",

  // Tool auth files: each is a fixed filename holding a password or token in
  // cleartext, with no extension the rules below would catch.
  "**/.npmrc",
  "**/.netrc",
  "**/_netrc",
  "**/.pgpass",
  "**/.htpasswd",
  "**/htpasswd",

  // Cloud provider and cluster credentials. Directory-scoped where the secret
  // is not in a predictably named file: the aws SSO cache lives under
  // `.aws/sso`, gcloud keeps `credentials.db` under `.config/gcloud`.
  "**/.aws/**",
  "**/.azure/**",
  "**/.config/gcloud/**",
  "**/application_default_credentials.json",
  "**/.kube/config",
  "**/kubeconfig",

  // Key material by extension.
  "**/*.key",
  "**/*.pem",
  "**/*.der",
  "**/*.crt",
  "**/*.cer",
  "**/*.p8",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.truststore",
  // PuTTY private keys.
  "**/*.ppk",
  // OpenPGP/GnuPG key material, armored and binary.
  "**/*.gpg",
  "**/*.asc",
  "**/*.pgp",

  // Key material by location: everything inside an SSH or GnuPG home. Covers
  // the keyrings, `authorized_keys` and non-default key filenames, none of
  // which carry an extension the rules above would catch.
  "**/.ssh/**",
  "**/.gnupg/**",

  // SSH private keys carry no extension, so the rules above miss them —
  // `id_rsa` is the most common private-key filename on disk.
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/id_dsa*",

  // Case-varied duplicates: macOS APFS is case-insensitive, so `server.KEY`
  // and `server.key` are the same file while a case-sensitive glob matcher
  // sees two different names. Same reasoning as the `.Agent-flows` duplicate
  // in BUILD_CONFIG_DENY_PATTERNS — Windows and Java tooling do export
  // `CERT.PEM` and `KEYSTORE.JKS`, so both spellings must be denied.
  "**/*.KEY",
  "**/*.PEM",
  "**/*.DER",
  "**/*.CRT",
  "**/*.CER",
  "**/*.P8",
  "**/*.P12",
  "**/*.PFX",
  "**/*.JKS",
  "**/*.PPK",
  "**/*.GPG",
  "**/*.ASC",
  "**/*.PGP",
  "**/.Ssh/**",
  "**/.Gnupg/**",
  "**/.Aws/**",
  "**/.Azure/**",
  "**/.Kube/config",
];

/**
 * Files a workspace step may never EDIT (but may read). Applied via
 * `--disallowedTools` as `Edit(pattern)` entries — Read is intentionally absent
 * so steps can still inspect these files.
 *
 * These are build/execution artifacts: editing them lets an injected step
 * rewrite the test script or CI pipeline and have those rewrites executed
 * inside the same run. A step reading `package.json` to understand dependencies
 * is legitimate; a step rewriting `test` to `echo PWNED` is the attack.
 *
 * Separate from CREDENTIAL_DENY_PATTERNS, which denies both read and edit.
 * The distinction is intentional and the whole point: Read stays allowed here
 * so investigation steps retain full visibility into the build configuration.
 */
export const BUILD_CONFIG_DENY_PATTERNS: readonly string[] = [
  "**/package.json",
  "**/Makefile",
  "**/.github/workflows/**",
  "**/.git/**",
  "**/.husky/**",
  "**/*.config.*",
  // Protect project-level agent-flows config from mid-run edits. A write step
  // that rewrites checkCommand would change the convergence gate for future runs.
  // FR-003's read-once-at-startup rule closes the hole for the current run;
  // this closes it for the next one. Read stays allowed: steps legitimately
  // inspect the config to understand the project setup.
  "**/.agent-flows/**",
  // Duplicate with capital A: macOS APFS is case-insensitive, so
  // .Agent-flows/config.json resolves to the same file. Both spellings must be
  // denied to prevent a case-varied path from slipping through the glob match.
  "**/.Agent-flows/**",
  // Pipeline definitions are run configuration too. A write step that authors or
  // edits a pipeline decides what a later run is permitted to touch — its
  // permissions, its deny entries, its model. Deny being narrowing-only (spec 031
  // D5) bounds how far such an edit can reach; this closes the path a second time.
  // Read stays allowed: steps legitimately inspect pipeline definitions.
  "**/pipelines/**",
  // Case-varied duplicate, same APFS reasoning as .Agent-flows above.
  "**/Pipelines/**",
];

// ── Operator settings deny rules ──────────────────────────────────────────────

/**
 * Reads `permissions.deny` from the operator's USER-level claude settings
 * (`$HOME/.claude/settings.json`) so those rules can be re-applied through
 * `--disallowedTools`. `--restricted` makes the CLI ignore settings files in both
 * directions (F9), so without this the operator's own protections simply vanish
 * inside a step even though a plain `claude -p` honours them.
 *
 * Narrow-only, in two senses:
 *
 * - Only `deny` is read. `permissions.allow` is never consulted: honouring it would
 *   let a settings file widen a step's grant, which is precisely what `--restricted`
 *   was chosen to prevent. Merging deny rules can only ever shrink what a step can touch.
 * - Only the USER-level file is read. The target repository's own
 *   `.claude/settings.json` is deliberately NOT read: a hostile or careless repo could
 *   deny its own sources, and because Grep/Glob denials fail silently (F8) the reviewing
 *   agent would report "no matches" and conclude the code is absent rather than hidden.
 *   The user settings belong to the operator; the repo settings are part of the artifact
 *   under review and must not influence the reviewer. There is no user-level
 *   `settings.local.json` in the CLI's settings hierarchy — `.local` is a project-scope
 *   convention — so only `settings.json` is read here.
 *
 * Degrades to no extra denials on every failure — absent HOME, missing file, unreadable
 * file, malformed JSON, or no `permissions.deny` key. A broken settings file must cost
 * the operator their extra denials, not every pipeline run.
 */
export function operatorDenyRules(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME;
  if (home === undefined || home === "") return [];

  let raw: string;
  try {
    raw = readFileSync(join(home, ".claude", "settings.json"), "utf8");
  } catch {
    return [];
  }

  let deny: unknown;
  try {
    const parsed = JSON.parse(raw) as { permissions?: { deny?: unknown } };
    deny = parsed?.permissions?.deny;
  } catch {
    return [];
  }

  if (!Array.isArray(deny)) return [];
  return deny
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
}
