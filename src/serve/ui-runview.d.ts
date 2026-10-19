// Types for ui-runview.js. The run session ships as plain ESM so the browser can
// load it unbuilt from /ui-runview.js; this declaration lets the unit test import
// it without turning on allowJs for the whole project.

import type { LogState } from "./ui-log.js";

type Json = Record<string, any>;

export declare const SETTLED_STEP_STATUSES: readonly string[];
export declare function outputKey(projectKey: string, runId: string, stepId: string): string;

/** Step outputs shared by every session: answers by key, and requests still in flight. */
export interface OutputCache {
  payloads: Map<string, Json | null>;
  inflight: Map<string, Promise<Json | null>>;
}
export declare function createOutputCache(): OutputCache;

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}

export interface StreamLike {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  onerror: unknown;
  close(): void;
}

export interface LogBatch {
  applied: Json[];
  state: LogState;
  droppedBefore: Map<string, number>;
}

export interface RunSessionOptions {
  /** "" is this daemon's own project. */
  projectKey: string;
  runId: string;
  fetch(url: string, init?: unknown): Promise<FetchResponse>;
  openStream(url: string): StreamLike;
  outputs: OutputCache;
  on: {
    snapshot(snapshot: Json, cause: "open" | "stream" | "refresh"): void;
    step(data: {
      stepId?: string;
      status?: string;
      outputExcerpt?: string;
      outputTruncated?: boolean;
    }): void;
    log(batch: LogBatch): void;
    /** true when the stream opens, false once when it ends; never twice for one stream. */
    stream(open: boolean): void;
    /** Only a failed initial snapshot. */
    error(e: Error): void;
  };
}

export interface RunSession {
  readonly projectKey: string;
  readonly runId: string;
  readonly closed: boolean;
  readonly snapshot: Json | null;
  readonly logState: LogState;
  readonly streamState: "none" | "open" | "detached" | "closed";
  /** Always resolves; emits nothing once the session is closed. */
  open(): Promise<void>;
  /** Always resolves; a call while one is in flight is dropped. */
  refresh(): Promise<void>;
  /** Never settles once the session is closed. */
  stepDetail(stepId: string): Promise<Json | undefined>;
  /** Rejects with "Request failed (N)" on a non-404 failure; never settles once closed. */
  stepOutput(stepId: string): Promise<Json | null>;
  /** The promise's outcome while the session is open; never settles once closed. */
  whileOpen<T>(p: Promise<T> | T): Promise<T>;
  /** Idempotent. */
  close(): void;
}

export declare function createRunSession(o: RunSessionOptions): RunSession;
