// The run view's session: the one place the page talks to a run (spec 047 FR-15).
//
// Plain ESM with no DOM access and no browser globals, served by the daemon at
// /ui-runview.js and imported by ui.html. Everything the browser supplies —
// fetch, EventSource — is handed in, which is what lets the ordering and the
// staleness rules below be unit-tested without a browser.
//
// Before this module the page kept the open run in a handful of page-wide
// variables and each async step re-checked "is this still the run on screen?"
// by hand; the checks were missing in several places, so a late response could
// paint run A into run B. A session is bound to one run and one project for its
// whole life, and close() is the single answer to that question:
//
//   - open() and refresh() ALWAYS resolve — the Refresh button re-enables in a
//     finally that waits on them — but emit nothing once the session is closed.
//   - stepOutput(), stepDetail() and whileOpen() NEVER settle after close(). A
//     caller writes to the DOM after its await, and a closed session means the
//     DOM is no longer that run's, so the continuation must not run. The
//     wrapper keeps no registry of pending resolvers (nothing to leak or to
//     flush) and swallows a source rejection that arrives after close(), so it
//     cannot surface as an unhandled rejection.
//
// The output cache is the exception: it is page-lifetime and is filled even
// when the session that asked has closed, because an output that has settled
// does not change.

import { mergeLogEvents } from "./ui-log.js";
import { pathFor } from "./ui-route.js";
import { runPhase } from "./ui-tables.js";

/** Step statuses after which a step's output can no longer appear or change. */
export const SETTLED_STEP_STATUSES = ["succeeded", "failed", "cancelled"];

/** The cache key for one step's output: project, run and step never collide. */
export function outputKey(projectKey, runId, stepId) {
  return JSON.stringify([projectKey, runId, stepId]);
}

/**
 * Full step outputs, shared by every session for the life of the page.
 * `payloads` holds the answer (a payload, or null for "none persisted") and
 * `inflight` the request still being made, so concurrent askers share one.
 */
export function createOutputCache() {
  return { payloads: new Map(), inflight: new Map() };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {object} o
 * @param {string} o.projectKey "" is this daemon's own project.
 * @param {string} o.runId
 * @param {Function} o.fetch (url, init?) => Promise<{ ok, status, json(), text() }>
 * @param {Function} o.openStream (url) => an EventSource-like stream
 * @param {{ payloads: Map, inflight: Map }} o.outputs
 * @param {object} o.on snapshot(s, cause), step(data), log(batch), stream(open), error(e)
 */
export function createRunSession(o) {
  const { projectKey, runId, outputs, on } = o;
  const api = (suffix) => pathFor(projectKey, `/api/runs/${encodeURIComponent(runId)}${suffix}`);

  let closed = false;
  let snapshot = null;
  let logState = mergeLogEvents(null, []);
  /** Log events held back while the backfill is in flight; null once flushed. */
  let logBuffer = [];
  let stream = null;
  let streamState = "none";
  let refreshing = false;

  async function getSnapshot() {
    const res = await o.fetch(api(""));
    const json = await res.json().catch(() => ({}));
    if (!res.ok)
      throw Object.assign(new Error(json.error || "Request failed"), { status: res.status });
    return json;
  }

  function applyLog(incoming) {
    if (incoming.length === 0) return;
    const lastSeq = logState.lastSeq;
    const droppedBefore = logState.droppedEarlier;
    logState = mergeLogEvents(logState, incoming);
    const seen = new Set();
    const applied = incoming
      .filter((ev) => ev && typeof ev.seq === "number" && ev.seq > lastSeq)
      .sort((a, b) => a.seq - b.seq)
      .filter((ev) => !seen.has(ev.seq) && seen.add(ev.seq));
    if (applied.length > 0) on.log({ applied, state: logState, droppedBefore });
  }

  /** The whole step log as NDJSON, then the events the stream buffered meanwhile. */
  async function backfill() {
    let text = "";
    try {
      const res = await o.fetch(api("/log"));
      if (res.ok) text = await res.text();
    } catch {
      // The activity list is an addition to the view, not the view itself.
    }
    if (closed) return;
    const events = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const ev = parseJson(line); // a torn last line of a file still being written
      if (ev !== undefined) events.push(ev);
    }
    applyLog(events);
    const buffered = logBuffer ?? [];
    logBuffer = null;
    applyLog(buffered);
  }

  function patchStep(data) {
    if (snapshot === null || typeof data.stepId !== "string") return;
    const { stepId, status, outputExcerpt, outputTruncated } = data;
    const patch = { status, outputExcerpt, outputTruncated };
    const step = { ...snapshot.steps?.[stepId] };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) step[k] = v;
    snapshot = { ...snapshot, steps: { ...snapshot.steps, [stepId]: step } };
  }

  function openStream() {
    const es = o.openStream(api("/events"));
    stream = es;
    streamState = "open";
    on.stream(true);

    /** A listener that ignores a closed session and an unreadable payload. */
    const listen = (type, handle) =>
      es.addEventListener(type, (ev) => {
        if (closed) return;
        const data = parseJson(ev.data);
        if (data !== undefined) handle(data);
      });

    listen("snapshot", (data) => {
      snapshot = data;
      on.snapshot(data, "stream");
    });
    listen("step", (data) => {
      patchStep(data);
      on.step(data);
    });
    // spec 036 D4: log events that arrive while the backfill is in flight are
    // buffered, not painted — the backfill has to land first so the lines stay
    // in seq order.
    listen("log", (data) => {
      if (logBuffer !== null) logBuffer.push(data);
      else applyLog([data]);
    });

    // An error ends the stream for good: the view keeps its last-known state and
    // nothing reconnects (the daemon ends a restored run's stream at once, so a
    // reconnect would loop).
    es.onerror = () => {
      if (closed || streamState !== "open") return;
      streamState = "detached";
      es.close();
      on.stream(false);
    };
  }

  /**
   * Whether a 404 for this step's output is final rather than "not yet". It is
   * read when the request goes out: a step that settles while the request is in
   * flight may have been answered before its output was written.
   */
  function settled(stepId) {
    return (
      SETTLED_STEP_STATUSES.includes(snapshot?.steps?.[stepId]?.status) ||
      snapshot?.source === "disk" ||
      (snapshot !== null && runPhase(snapshot) === "terminal")
    );
  }

  async function loadOutput(stepId, key) {
    const wasSettled = settled(stepId);
    const res = await o.fetch(api(`/steps/${encodeURIComponent(stepId)}/output`));
    if (res.status === 404) {
      if (wasSettled) outputs.payloads.set(key, null);
      return null;
    }
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const payload = await res.json();
    outputs.payloads.set(key, payload);
    return payload;
  }

  function cachedOutput(stepId) {
    const key = outputKey(projectKey, runId, stepId);
    if (outputs.payloads.has(key)) return Promise.resolve(outputs.payloads.get(key));
    let pending = outputs.inflight.get(key);
    if (pending === undefined) {
      pending = loadOutput(stepId, key).finally(() => outputs.inflight.delete(key));
      outputs.inflight.set(key, pending);
    }
    return pending;
  }

  /** `p`'s outcome while the session is open; never settles once it is closed. */
  function whileOpen(p) {
    return new Promise((resolve, reject) => {
      Promise.resolve(p).then(
        (value) => {
          if (!closed) resolve(value);
        },
        (error) => {
          if (!closed) reject(error);
        }
      );
    });
  }

  return {
    projectKey,
    runId,
    get closed() {
      return closed;
    },
    get snapshot() {
      return snapshot;
    },
    get logState() {
      return logState;
    },
    get streamState() {
      return streamState;
    },

    /** Snapshot, then the stream, then the log — the stream is open before the log is read. */
    async open() {
      let first;
      try {
        first = await getSnapshot();
      } catch (e) {
        if (!closed) on.error(e);
        return;
      }
      if (closed) return;
      snapshot = first;
      on.snapshot(first, "open");
      // FR-011: a run restored from disk has nothing left to stream; its step
      // log is still on disk, so the backfill runs on its own.
      if (first.source !== "disk") openStream();
      await backfill();
    },

    /** Re-read the snapshot. One request at a time: a refresh during one is dropped. */
    async refresh() {
      if (closed || refreshing) return;
      refreshing = true;
      try {
        const fresh = await getSnapshot();
        if (closed) return;
        snapshot = fresh;
        on.snapshot(fresh, "refresh");
      } catch {
        // last-known state stays on screen
      } finally {
        refreshing = false;
      }
    },

    /** One step's current state from a fresh snapshot; undefined when it cannot be read. */
    stepDetail(stepId) {
      return whileOpen(
        getSnapshot().then(
          (fresh) => fresh.steps?.[stepId],
          () => undefined
        )
      );
    },

    /** The persisted output of a step, or null when none was written. */
    stepOutput(stepId) {
      return whileOpen(cachedOutput(stepId));
    },

    whileOpen,

    close() {
      if (closed) return;
      closed = true;
      if (streamState !== "open") return;
      streamState = "closed";
      stream.close();
      on.stream(false);
    },
  };
}
