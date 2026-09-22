// Which account each provider CLI is signed in as (spec 042 D23).
//
// The provider columns named a vendor and nothing else, so "what am I actually
// entitled to run" was a question the page could not answer — and it is the
// question behind every model list, because availability follows the account:
// the codex picker offers three models on one plan and more on another.
//
// Both CLIs can say. `claude auth status` prints JSON including
// `subscriptionType`; `codex login status` prints the auth mode and no plan at
// all, which is reported as the absence it is rather than guessed at.
//
// ONLY the plan and the auth method are taken. `claude auth status` also prints
// the signed-in email and an organisation id; neither is needed to answer the
// question, so neither is read into the response — the narrowest extraction is
// also the one that cannot leak.

/** Runs a command and returns its stdout, or undefined if it failed. */
export type RunCommand = (bin: string, args: string[]) => string | undefined;

/** What the page is told about one provider's account. */
export interface ProviderAccount {
  /** The subscription tier, when the CLI reports one. */
  plan?: string;
  /** How the CLI is authenticated, when it says. */
  authMethod?: string;
  /** Set when the CLI could not be asked at all. */
  error?: string;
}

/**
 * The plan and auth method from `claude auth status` output.
 *
 * Deliberately field-by-field rather than a spread: a future field in that JSON
 * must not arrive in our response because nobody looked.
 */
export function parseAnthropicStatus(stdout: string | undefined): ProviderAccount {
  if (stdout === undefined) return { error: "claude auth status did not answer" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { error: "claude auth status did not print JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: "claude auth status did not print an object" };
  }
  const o = parsed as Record<string, unknown>;
  if (o.loggedIn === false) return { error: "not signed in" };
  return {
    ...(typeof o.subscriptionType === "string" ? { plan: o.subscriptionType } : {}),
    ...(typeof o.authMethod === "string" ? { authMethod: o.authMethod } : {}),
  };
}

/**
 * The auth method from `codex login status` output.
 *
 * It reports no plan, and this returns none: the codex picker's model list does
 * depend on the plan, so inventing one here would be worse than saying nothing.
 */
export function parseOpenaiStatus(stdout: string | undefined): ProviderAccount {
  if (stdout === undefined) return { error: "codex login status did not answer" };
  const line = stdout.trim();
  if (line === "") return { error: "codex login status printed nothing" };
  if (/not logged in|no credentials/iu.test(line)) return { error: "not signed in" };
  const via = /logged in using (.+?)\.?$/iu.exec(line);
  return via ? { authMethod: via[1].trim() } : { authMethod: line.split("\n")[0] };
}

/** One line for a column header: the plan when known, else how it is signed in. */
export function accountLabel(account: ProviderAccount | undefined): string {
  if (account === undefined) return "";
  if (account.error !== undefined) return account.error;
  if (account.plan !== undefined) return account.plan;
  return account.authMethod ?? "";
}

/**
 * Ask both CLIs who they are signed in as.
 *
 * Keyed by the vendor the matrix derives for a model entry, so the page can look
 * a column's account up by the same name it already uses.
 */
export function probeProviderAccounts(run: RunCommand): Record<string, ProviderAccount> {
  return {
    anthropic: parseAnthropicStatus(run("claude", ["auth", "status"])),
    openai: parseOpenaiStatus(run("codex", ["login", "status"])),
  };
}
