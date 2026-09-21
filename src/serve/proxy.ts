// Reading another project's daemon through the one whose page is open (spec 042 D12).
//
// Every daemon serves the same API for exactly one project, chosen once at
// startup, so seeing two projects meant opening two ports and remembering which
// was which. The browser cannot simply call the other port itself — that is a
// cross-origin request the daemon does not answer — so the daemon whose page is
// open forwards it instead.
//
// The forwarding target is never taken from the request. The request names a
// project KEY; the port comes from that project's own `daemon.json`, verified
// live by the same probe the daemons panel uses. So this cannot be pointed at an
// arbitrary host or port: a caller who asks for a project that has no live
// daemon gets a refusal, not a connection somewhere else.

/** Where a proxied request is forwarded, once the project key has been resolved. */
export interface ProxyTarget {
  port: number;
  projectDir: string;
}

/** The prefix a proxied request carries: `/api/projects/<key>/<rest>`. */
export const PROXY_PREFIX = "/api/projects/";

/** A proxied request, split into the project it names and the path to forward. */
export interface ProxySplit {
  projectKey: string;
  /** Absolute path on the target daemon, always starting with `/`. */
  rest: string;
}

/**
 * Split a proxy URL into its project key and forwarded path.
 *
 * Returns undefined for anything that is not a proxy path, and for a nested
 * proxy path — forwarding one of those would make two daemons bounce a request
 * between them until something ran out.
 */
export function splitProxyPath(pathname: string): ProxySplit | undefined {
  if (!pathname.startsWith(PROXY_PREFIX)) return undefined;
  const tail = pathname.slice(PROXY_PREFIX.length);
  const slash = tail.indexOf("/");
  if (slash <= 0) return undefined;
  const projectKey = decodeURIComponent(tail.slice(0, slash));
  const rest = tail.slice(slash);
  if (projectKey === "" || !rest.startsWith("/api/")) return undefined;
  if (rest.startsWith(PROXY_PREFIX)) return undefined;
  return { projectKey, rest };
}

/** What a daemon list entry must carry for this module to route to it. */
export interface RoutableDaemon {
  projectKey: string;
  projectDir: string;
  port: number;
  live: boolean;
}

/**
 * Resolve a project key to the daemon that can answer for it.
 *
 * A string result is a refusal to show the caller: the key is unknown, or its
 * daemon is recorded but not answering. Neither is an error the page can fix by
 * retrying, so both name what is wrong rather than failing blank.
 */
export function resolveProxyTarget(
  projectKey: string,
  daemons: readonly RoutableDaemon[]
): ProxyTarget | string {
  const entry = daemons.find((d) => d.projectKey === projectKey);
  if (entry === undefined) {
    return `no project named "${projectKey}" has ever recorded a daemon on this machine`;
  }
  if (!entry.live) {
    return `the daemon recorded for ${entry.projectDir} is not answering on port ${entry.port}`;
  }
  return { port: entry.port, projectDir: entry.projectDir };
}
