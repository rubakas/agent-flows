// The credential deny list, as plain data with no imports. It is its own file because
// two consumers need it and one of them cannot import anything else: the review
// capture core (src/runtime/reviewCapture.ts) is transpiled into the plugin, which
// ships with no node_modules and no copy of the rest of canon/.

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
  // Git's credential store, PyPI's upload tokens, Docker's registry auth and
  // its legacy spelling. The review capture withheld these from a diff before
  // a step's own Read and Grep did.
  "**/.git-credentials",
  "**/.pypirc",
  "**/.docker/config.json",
  "**/.dockercfg",

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
