// Tests for attemptStep: the request the adapter is handed, provider failover,
// the one corrective retry, and the events and errors a caller reads. No Mastra:
// a scripted Dispatch stands in for the transports, and one block runs the real
// claude adapter against a fake spawn to read the argv.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { schemaContract } from "./outputContract.js";
import { ModelRegistry, resolveStepModel } from "./registry.js";
import { UNRECOGNIZED_MODEL_SUBTYPE } from "./runClaudeCli.js";
import { StepAttemptError, attemptStep, isFailoverWorthy } from "./stepAttempt.js";
import { StepTimeoutError, TransportFailureError } from "./stepRuntime.js";
import { makeFakeSpawnEach, makeStreamJsonStdout } from "./testing/fakeSpawn.js";
import type { OutputContract } from "./outputContract.js";
import type { ProviderProfile } from "./registry.js";
import type { AttemptContext, AttemptRequest, AttemptStep, Dispatch } from "./stepAttempt.js";
import type { StepLogEventInput } from "./stepLogEvents.js";
import type { StepRunnerDeps } from "./stepRuntime.js";

const PRIMARY: ProviderProfile = {
  id: "primary",
  roles: { reasoner: "m1", worker: "m1", scout: "m1" },
  fallback: ["secondary"],
};
const SECONDARY: ProviderProfile = {
  id: "secondary",
  roles: { reasoner: "m2", worker: "m2", scout: "m2" },
};
/** Text-only: the api transport has no tool loop, so it cannot read a repo. */
const TEXT_ONLY: ProviderProfile = {
  id: "text-only",
  roles: { reasoner: "m-api", worker: "m-api", scout: "m-api" },
};
const CODEX: ProviderProfile = {
  id: "codex-profile",
  roles: { reasoner: "m-codex", worker: "m-codex", scout: "m-codex" },
};
const PROFILES = [PRIMARY, SECONDARY, TEXT_ONLY, CODEX];
const REGISTRY = new ModelRegistry([
  { id: "m1", transport: "cli", cli: { bin: "claude", model: "m1" } },
  { id: "m2", transport: "cli", cli: { bin: "claude", model: "m2" } },
  { id: "m-codex", transport: "cli", cli: { bin: "codex", model: "gpt" } },
  {
    id: "m-api",
    transport: "api",
    api: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen" },
  },
]);

const STEP: AttemptStep = { id: "investigate.survey", role: "worker" };

/** A transport failure exactly as the claude adapter reports one. */
function transportFailure(): Error {
  return new TransportFailureError("claude exited with code 1\nstderr: connection reset", {
    transport: "cli:claude",
    exitCode: 1,
  });
}

interface Call {
  entryId: string;
  prompt: string;
  deps: StepRunnerDeps;
}

/** A Dispatch that records every call and answers through `handler`. */
function scripted(handler: (call: Call, n: number) => string | Promise<string>): {
  dispatch: Dispatch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const dispatch: Dispatch = async (entry, prompt, deps) => {
    const call: Call = { entryId: entry.id, prompt, deps: { ...deps } };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { dispatch, calls };
}

function request(
  over: {
    step?: AttemptStep;
    prompt?: string;
    profile?: ProviderProfile;
    pinned?: true;
    output?: OutputContract;
  } = {}
): AttemptRequest {
  const step = over.step ?? STEP;
  const profile = over.profile ?? PRIMARY;
  return {
    step,
    prompt: over.prompt ?? "survey prompt",
    model: {
      entry: resolveStepModel(step, profile, REGISTRY),
      profile,
      ...(over.pinned ? { pinned: true as const } : {}),
    },
    ...(over.output ? { output: over.output } : {}),
  };
}

function context(dispatch: Dispatch, over: Partial<AttemptContext> = {}): AttemptContext {
  return { registry: REGISTRY, providerProfiles: PROFILES, dispatch, ...over };
}

/** The StepAttemptError a rejected attempt throws; fails if it threw anything else. */
async function failure(attempt: Promise<unknown>): Promise<StepAttemptError> {
  try {
    await attempt;
  } catch (err) {
    assert.ok(err instanceof StepAttemptError, `expected a StepAttemptError, got: ${String(err)}`);
    return err;
  }
  assert.fail("the attempt was expected to fail");
}

const WEAKNESSES = schemaContract("weaknesses");
const BAD_SEVERITY = `{"weaknesses":[{"text":"x","severity":"moderate","blocking":false}]}`;
const VALID = `{"weaknesses":[]}`;

// ── Answering ─────────────────────────────────────────────────────────────────

describe("attemptStep — answering", () => {
  it("returns the raw text, naming the model the request asked for", async () => {
    const { dispatch, calls } = scripted(() => "the answer");
    const req = request();

    const r = await attemptStep(req, context(dispatch));

    assert.equal(r.value, "the answer");
    assert.equal(r.answeredBy.entry, req.model.entry, "no failover: the request's own entry");
    assert.equal(r.answeredBy.profileId, "primary");
    assert.deepEqual(
      calls.map((c) => [c.entryId, c.prompt]),
      [["m1", "survey prompt"]]
    );
  });

  it("returns the parsed value when the request carries an output contract", async () => {
    const { dispatch, calls } = scripted(() => VALID);

    const r = await attemptStep(request({ output: WEAKNESSES }), context(dispatch));

    assert.deepEqual(r.value, { weaknesses: [] });
    assert.equal(calls.length, 1, "a valid answer is not paid for twice");
  });
});

// ── What the adapter is handed ────────────────────────────────────────────────

describe("attemptStep — the request handed to the adapter", () => {
  async function depsFor(
    step: AttemptStep,
    over: Partial<AttemptContext> = {},
    output?: OutputContract
  ) {
    const { dispatch, calls } = scripted(() => (output ? VALID : "ok"));
    await attemptStep(request({ step, ...(output ? { output } : {}) }), context(dispatch, over));
    return calls[0].deps;
  }

  it("carries the step's deadline, the pipeline's fallback deadline and the step's budget", async () => {
    const deps = await depsFor(
      { ...STEP, timeoutMs: 1000, maxBudgetUsd: 2 },
      { defaultTimeoutMs: 5000, defaultMaxBudgetUsd: 9 }
    );

    assert.equal(deps.timeoutMs, 1000);
    assert.equal(deps.defaultTimeoutMs, 5000);
    assert.equal(deps.maxBudgetUsd, 2, "the step's own cap beats the pipeline's");
  });

  it("inherits the pipeline's budget and leaves the step deadline unset when the step declares none", async () => {
    const deps = await depsFor(STEP, { defaultTimeoutMs: 5000, defaultMaxBudgetUsd: 9 });

    assert.equal(deps.timeoutMs, undefined);
    assert.equal(deps.defaultTimeoutMs, 5000);
    assert.equal(deps.maxBudgetUsd, 9);
  });

  it("declares no cap and no deadline when neither level does", async () => {
    const deps = await depsFor(STEP);

    assert.equal("timeoutMs" in deps, false);
    assert.equal("defaultTimeoutMs" in deps, false);
    assert.equal("maxBudgetUsd" in deps, false);
  });

  it("forwards permissions.contents with the workspace directory", async () => {
    const deps = await depsFor(
      { ...STEP, permissions: { contents: "read" } },
      { workspaceDir: "/tmp/some-project" }
    );

    assert.equal(deps.contentsAccess, "read");
    assert.equal(deps.workspaceDir, "/tmp/some-project");
  });

  it("does not invent a workspace directory the caller never gave", async () => {
    const deps = await depsFor({ ...STEP, permissions: { contents: "read" } });

    assert.equal(deps.contentsAccess, "read");
    assert.equal("workspaceDir" in deps, false);
  });

  it("treats contents: none as no file access at all", async () => {
    const deps = await depsFor(
      { ...STEP, permissions: { contents: "none", deny: ["src/internal/**"] } },
      { workspaceDir: "/tmp/some-project" }
    );

    assert.equal("contentsAccess" in deps, false);
    assert.equal("workspaceDir" in deps, false);
    assert.equal(
      "denyPatterns" in deps,
      false,
      "a deny list without file access is a silent no-op"
    );
  });

  it("forwards the declared deny globs, and only alongside file access", async () => {
    const withDeny = await depsFor({
      ...STEP,
      permissions: { contents: "read", deny: ["src/internal/**"] },
    });
    const withoutDeny = await depsFor({ ...STEP, permissions: { contents: "read" } });

    assert.deepEqual(withDeny.denyPatterns, ["src/internal/**"]);
    assert.equal("denyPatterns" in withoutDeny, false);
  });

  it("forwards the declared skills", async () => {
    const deps = await depsFor({ ...STEP, skills: ["git", "chrome-test"] });

    assert.deepEqual(deps.skills, ["git", "chrome-test"]);
  });

  it("hands the contract's JSON schema to the transport, and none for a step without one", async () => {
    const withContract = await depsFor(STEP, {}, WEAKNESSES);
    const without = await depsFor(STEP);

    assert.deepEqual(withContract.outputJsonSchema, WEAKNESSES.jsonSchema);
    assert.equal("outputJsonSchema" in without, false);
  });

  it("passes the caller's transport hooks through untouched, and the run's signal on top", async () => {
    const controller = new AbortController();
    const env = { ONLY: "this" };
    const deps = await depsFor(STEP, {
      base: { env, _stallSilenceMs: 7 },
      signal: controller.signal,
    });

    assert.equal(deps.env, env);
    assert.equal(deps._stallSilenceMs, 7);
    assert.equal(deps.signal, controller.signal);
  });
});

// ── Refusing ──────────────────────────────────────────────────────────────────

describe("attemptStep — refusing an unportable step", () => {
  it("throws the portability reason verbatim, before any dispatch", async () => {
    const { dispatch, calls } = scripted(() => "never");
    const step: AttemptStep = { ...STEP, permissions: { contents: "write" } };

    const err = await failure(
      attemptStep(request({ step, profile: CODEX }), context(dispatch, { workspaceDir: "/tmp" }))
    );

    assert.equal(err.kind, "unportable");
    assert.equal(err.message, err.detail, "an unportable refusal carries no Step prefix");
    assert.match(
      err.message,
      /^step "investigate\.survey" under profile "codex-profile" resolves to model entry "m-codex"/
    );
    assert.equal(calls.length, 0);
  });
});

// ── Failover ──────────────────────────────────────────────────────────────────

describe("attemptStep — provider failover", () => {
  const answerFromSecondary = (call: Call): string => {
    if (call.entryId === "m1") throw transportFailure();
    return "answered by the fallback";
  };

  it("retries a transport failure on the next profile, with a different model", async () => {
    const { dispatch, calls } = scripted(answerFromSecondary);
    const req = request();

    const r = await attemptStep(req, context(dispatch));

    assert.deepEqual(
      calls.map((c) => c.entryId),
      ["m1", "m2"]
    );
    assert.equal(r.value, "answered by the fallback");
    assert.equal(r.answeredBy.profileId, "secondary");
    assert.equal(r.answeredBy.entry.id, "m2");
    assert.notEqual(r.answeredBy.entry, req.model.entry, "a moved step names a different entry");
    assert.equal(calls[1].prompt, "survey prompt", "the candidate gets the same prompt");
  });

  for (const [label, failover] of [
    ["failover: true", true],
    ["no failover field", undefined],
  ] as const) {
    it(`still walks the chain with ${label}`, async () => {
      const { dispatch, calls } = scripted(answerFromSecondary);
      const step: AttemptStep = failover === undefined ? STEP : { ...STEP, failover };

      await attemptStep(request({ step }), context(dispatch));

      assert.deepEqual(
        calls.map((c) => c.entryId),
        ["m1", "m2"]
      );
    });
  }

  it("never hands a failover: false step to a second provider, and says why", async () => {
    const { dispatch, calls } = scripted(() => {
      throw transportFailure();
    });

    const err = await failure(
      attemptStep(request({ step: { ...STEP, failover: false } }), context(dispatch))
    );

    assert.equal(err.kind, "failed");
    assert.match(err.message, /Failover refused: the step sets failover: false/);
    assert.match(err.message, /stayed pinned to profile "primary"/);
    assert.deepEqual(
      calls.map((c) => c.entryId),
      ["m1"]
    );
  });

  it("never fails a pinned request over, and — unlike failover: false — says nothing about it", async () => {
    const { dispatch, calls } = scripted(() => {
      throw transportFailure();
    });

    const err = await failure(attemptStep(request({ pinned: true }), context(dispatch)));

    assert.equal(err.message, `Step "investigate.survey": ${transportFailure().message}`);
    assert.doesNotMatch(err.message, /Failover/);
    assert.deepEqual(
      calls.map((c) => c.entryId),
      ["m1"],
      "an operator who pinned a model made a choice the chain must not quietly replace"
    );
  });

  it("keys the refusal tail on the step, not on the pin", async () => {
    const { dispatch } = scripted(() => {
      throw transportFailure();
    });

    const err = await failure(
      attemptStep(request({ step: { ...STEP, failover: false }, pinned: true }), context(dispatch))
    );

    assert.match(err.message, /Failover refused/);
  });

  it("does not claim a refusal for a failure no provider could have answered", async () => {
    const { dispatch } = scripted(() => {
      throw new Error("something about the request");
    });

    const err = await failure(
      attemptStep(request({ step: { ...STEP, failover: false } }), context(dispatch))
    );

    assert.equal(err.message, 'Step "investigate.survey": something about the request');
  });

  it("skips a text-only candidate for a step that declares permissions.contents", async () => {
    const { dispatch, calls } = scripted(() => {
      throw transportFailure();
    });
    const chained = { ...PRIMARY, fallback: ["text-only"] };
    const step: AttemptStep = { ...STEP, permissions: { contents: "read" } };

    const err = await failure(attemptStep(request({ step, profile: chained }), context(dispatch)));

    assert.match(
      err.message,
      /Failover exhausted: text-only: skipped \(.*permissions\.contents "read"/
    );
    assert.deepEqual(
      calls.map((c) => c.entryId),
      ["m1"],
      "a text-only candidate must be skipped, not attempted"
    );
  });

  it("skips a candidate that cannot enforce the step's permissions.deny", async () => {
    const { dispatch, calls } = scripted(() => {
      throw transportFailure();
    });
    const chained = { ...PRIMARY, fallback: ["text-only"] };
    const step: AttemptStep = {
      ...STEP,
      permissions: { contents: "read", deny: ["ops/secrets-notes/**"] },
    };

    const err = await failure(attemptStep(request({ step, profile: chained }), context(dispatch)));

    assert.match(err.message, /permissions\.deny/);
    assert.deepEqual(
      calls.map((c) => c.entryId),
      ["m1"]
    );
  });

  it("skips a candidate that would silently drop the step's skills", async () => {
    const { dispatch, calls } = scripted(() => {
      throw transportFailure();
    });
    const chained = { ...PRIMARY, fallback: ["codex-profile"] };
    const step: AttemptStep = { ...STEP, skills: ["review"] };

    const err = await failure(attemptStep(request({ step, profile: chained }), context(dispatch)));

    assert.match(err.message, /codex-profile: skipped/);
    assert.match(err.message, /skills/);
    assert.deepEqual(
      calls.map((c) => c.entryId),
      ["m1"]
    );
  });

  it("skips an unknown profile and a candidate resolving to the same model, then moves on", async () => {
    const { dispatch, calls } = scripted(answerFromSecondary);
    const same: ProviderProfile = {
      id: "same",
      roles: { reasoner: "m1", worker: "m1", scout: "m1" },
    };
    const chained = { ...PRIMARY, fallback: ["no-such-profile", "same", "secondary"] };

    const r = await attemptStep(
      request({ profile: chained }),
      context(dispatch, { providerProfiles: [...PROFILES, same] })
    );

    assert.equal(r.answeredBy.profileId, "secondary");
    assert.deepEqual(
      calls.map((c) => c.entryId),
      ["m1", "m2"]
    );
  });

  it("throws the original error naming every candidate when the chain is exhausted", async () => {
    const { dispatch } = scripted((call) => {
      if (call.entryId === "m1") throw transportFailure();
      throw new TransportFailureError("codex exec: exit 2; no agent_message found.", {
        transport: "cli:codex",
        exitCode: 2,
      });
    });
    const original = transportFailure();

    const err = await failure(attemptStep(request(), context(dispatch)));

    assert.equal(err.kind, "failed");
    assert.equal(err.stage, "dispatch");
    assert.equal(
      err.message,
      `Step "investigate.survey": ${original.message}\n` +
        "Failover exhausted: secondary: codex exec: exit 2; no agent_message found."
    );
    assert.equal(err.detail, err.message.replace('Step "investigate.survey": ', ""));
    assert.match(String((err.cause as Error).message), /claude exited with code 1/);
    assert.equal(err.answeredBy, undefined, "nothing answered");
    assert.deepEqual(err.raw, []);
  });

  it("walks no chain when the profile has no fallback", async () => {
    const { dispatch, calls } = scripted(() => {
      throw transportFailure();
    });

    const err = await failure(
      attemptStep(request({ profile: { id: PRIMARY.id, roles: PRIMARY.roles } }), context(dispatch))
    );

    assert.equal(err.message, `Step "investigate.survey": ${transportFailure().message}`);
    assert.equal(calls.length, 1);
  });
});

describe("attemptStep — which failures are worth another provider", () => {
  async function candidatesTried(thrown: (call: Call) => Error, signal?: AbortSignal) {
    const { dispatch, calls } = scripted((call) => {
      if (call.entryId === "m1") throw thrown(call);
      return "ok";
    });
    await attemptStep(request(), context(dispatch, signal ? { signal } : {})).catch(
      () => undefined
    );
    return calls.map((c) => c.entryId);
  }

  it("fails an AbortError over to nobody, even with the run signal still live", async () => {
    const controller = new AbortController();

    const tried = await candidatesTried(
      () => new DOMException("Claude CLI aborted", "AbortError"),
      controller.signal
    );

    assert.equal(controller.signal.aborted, false, "the signal guard must not be what fires here");
    assert.deepEqual(tried, ["m1"], "an abort must not reach another provider on its name alone");
  });

  it("fails a cancelled run over to nobody, even when the failure is a transport failure", async () => {
    const controller = new AbortController();
    const { dispatch, calls } = scripted(() => {
      controller.abort();
      // Failover-worthy on its own — only the cancelled run stops it.
      throw transportFailure();
    });

    await attemptStep(request(), context(dispatch, { signal: controller.signal })).catch(
      () => undefined
    );

    assert.deepEqual(
      calls.map((c) => c.entryId),
      ["m1"],
      "an operator cancellation must not reach another provider"
    );
  });

  it("dispatches nothing further once the signal aborts between candidates", async () => {
    const controller = new AbortController();
    const chained = { ...PRIMARY, fallback: ["secondary", "text-only"] };
    const { dispatch, calls } = scripted((call) => {
      if (call.entryId === "m2") controller.abort();
      throw transportFailure();
    });

    await attemptStep(
      request({ profile: chained }),
      context(dispatch, { signal: controller.signal, providerProfiles: PROFILES })
    ).catch(() => undefined);

    // m1 fails with the signal live; m2 is tried, aborts the run and fails; the
    // third candidate is never reached.
    assert.deepEqual(
      calls.map((c) => c.entryId),
      ["m1", "m2"]
    );
  });

  it("does not fail a request-shaped claude subtype over", async () => {
    const tried = await candidatesTried(
      () =>
        new TransportFailureError('claude: result subtype "error_max_turns": ran out', {
          transport: "cli:claude",
          exitCode: 0,
          subtype: "error_max_turns",
        })
    );

    assert.deepEqual(tried, ["m1"], "a second provider would spend a whole step repeating it");
  });

  it("does fail a model the local CLI does not recognise over", async () => {
    const tried = await candidatesTried(
      () =>
        new TransportFailureError('claude CLI rejected model "m1": unrecognized_model', {
          transport: "cli:claude",
          exitCode: 0,
          subtype: UNRECOGNIZED_MODEL_SUBTYPE,
        })
    );

    assert.deepEqual(
      tried,
      ["m1", "m2"],
      "an alias one CLI lacks is exactly what another may have"
    );
  });

  it("fails a transport syscall code over but not an ERR_* programming error", async () => {
    const syscall: NodeJS.ErrnoException = new Error("spawn claude ENOENT");
    syscall.code = "ENOENT";
    const programming: NodeJS.ErrnoException = new Error(
      'The "path" argument must be of type string'
    );
    programming.code = "ERR_INVALID_ARG_TYPE";

    assert.deepEqual(await candidatesTried(() => syscall), ["m1", "m2"]);
    assert.deepEqual(
      await candidatesTried(() => programming),
      ["m1"],
      "every Node ERR_* error carries a string code; that is not a transport failure"
    );
  });

  it("does not fail a budget failure over", async () => {
    const tried = await candidatesTried(() => {
      const err = new Error("Step exceeded budget limit of $1.0000 USD");
      err.name = "StepBudgetExceededError";
      return err;
    });

    assert.deepEqual(tried, ["m1"], "a spent budget is not a transport failure");
  });

  it("fails a deadline over", async () => {
    assert.deepEqual(await candidatesTried(() => new StepTimeoutError(1000)), ["m1", "m2"]);
  });

  it("classifies by error type, not by message", () => {
    for (const name of ["StepWatchdogError", "WatchdogTrip", "StepBudgetExceededError"]) {
      const err = new Error("claude exited with code 1");
      err.name = name;
      assert.equal(isFailoverWorthy(err, undefined), false, name);
    }
    assert.equal(isFailoverWorthy("a string", undefined), false);
    assert.equal(isFailoverWorthy(transportFailure(), AbortSignal.abort()), false);
    assert.equal(isFailoverWorthy(transportFailure(), undefined), true);
  });
});

// ── The deadline and the budget bound the STEP ────────────────────────────────

describe("attemptStep — the step's deadline and budget bound the step, not each attempt", () => {
  it("gives the fallback only what is left of the declared deadline", async () => {
    const declaredMs = 5_000;
    const { dispatch, calls } = scripted(async (call) => {
      if (call.entryId === "m1") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw transportFailure();
      }
      return "ok";
    });

    await attemptStep(request({ step: { ...STEP, timeoutMs: declaredMs } }), context(dispatch));

    assert.equal(calls[0].deps.timeoutMs, declaredMs, "the first attempt gets the whole deadline");
    const second = calls[1].deps.timeoutMs;
    assert.ok(
      second !== undefined && second > 0 && second < declaredMs,
      `the fallback must get what is LEFT of ${declaredMs}ms, got ${String(second)}`
    );
  });

  it("bounds the step by the pipeline's fallback deadline when the step declares none", async () => {
    const { dispatch, calls } = scripted(async (call) => {
      if (call.entryId === "m1") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw transportFailure();
      }
      return "ok";
    });

    await attemptStep(request(), context(dispatch, { defaultTimeoutMs: 5_000 }));

    const second = calls[1].deps.timeoutMs;
    assert.ok(second !== undefined && second < 5_000, `got ${String(second)}`);
    assert.equal(calls[1].deps.defaultTimeoutMs, 5_000);
  });

  it("walks no chain once the deadline is spent", async () => {
    const { dispatch, calls } = scripted(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw transportFailure();
    });

    const err = await failure(
      attemptStep(request({ step: { ...STEP, timeoutMs: 1 } }), context(dispatch))
    );

    assert.match(err.message, /deadline is spent/);
    assert.equal(calls.length, 1, "a spent deadline must not buy a second full-length attempt");
  });

  it("gives the fallback only the budget the first attempt left", async () => {
    const { dispatch, calls } = scripted((call) => {
      if (call.entryId === "m1") {
        call.deps.onEvent?.({ kind: "usage", costUsd: 0.75 });
        throw transportFailure();
      }
      return "ok";
    });

    await attemptStep(request({ step: { ...STEP, maxBudgetUsd: 1 } }), context(dispatch));

    assert.equal(calls[0].deps.maxBudgetUsd, 1, "the first attempt gets the whole budget");
    assert.equal(calls[1].deps.maxBudgetUsd, 0.25);
  });

  it("counts a budget inherited from the pipeline exactly as a declared one", async () => {
    const { dispatch, calls } = scripted((call) => {
      if (call.entryId === "m1") {
        call.deps.onEvent?.({ kind: "usage", costUsd: 0.75 });
        throw transportFailure();
      }
      return "ok";
    });

    await attemptStep(request(), context(dispatch, { defaultMaxBudgetUsd: 1 }));

    assert.equal(calls[0].deps.maxBudgetUsd, 1);
    assert.equal(calls[1].deps.maxBudgetUsd, 0.25);
  });

  it("walks no chain once the budget is spent", async () => {
    const { dispatch, calls } = scripted((call) => {
      call.deps.onEvent?.({ kind: "usage", costUsd: 1 });
      throw transportFailure();
    });

    const err = await failure(
      attemptStep(request({ step: { ...STEP, maxBudgetUsd: 1 } }), context(dispatch))
    );

    assert.match(err.message, /budget is spent/);
    assert.equal(calls.length, 1, "a spent budget must not buy a second full-budget attempt");
  });

  it("sums usage across every failed attempt, ignoring events that report no cost", async () => {
    const chained = { ...PRIMARY, fallback: ["secondary", "secondary-twin"] };
    const twin: ProviderProfile = { ...SECONDARY, id: "secondary-twin" };
    const { dispatch, calls } = scripted((call) => {
      call.deps.onEvent?.({ kind: "usage", turns: 3 });
      call.deps.onEvent?.({ kind: "usage", costUsd: 0.25 });
      throw transportFailure();
    });

    await failure(
      attemptStep(
        request({ step: { ...STEP, maxBudgetUsd: 1 }, profile: chained }),
        context(dispatch, { providerProfiles: [...PROFILES, twin] })
      )
    );

    assert.deepEqual(
      calls.map((c) => c.deps.maxBudgetUsd),
      [1, 0.75, 0.5]
    );
  });
});

// ── Output contract and the one retry ─────────────────────────────────────────

describe("attemptStep — the corrective retry", () => {
  it("retries once with a prompt naming the field and the constraint", async () => {
    const { dispatch, calls } = scripted((_call, n) => (n === 0 ? BAD_SEVERITY : VALID));

    const r = await attemptStep(request({ output: WEAKNESSES }), context(dispatch));

    assert.equal(calls.length, 2, "one retry, no more");
    assert.deepEqual(r.value, { weaknesses: [] });
    const retryPrompt = calls[1].prompt;
    assert.ok(retryPrompt.startsWith("survey prompt\n\n"), "the retry extends the original prompt");
    assert.match(retryPrompt, /weaknesses\.0\.severity/);
    assert.match(retryPrompt, /must be one of low, medium, high, critical/);
    assert.match(retryPrompt, /"moderate"/);
    assert.match(retryPrompt, / Return ONLY the JSON object\.$/);
  });

  it("tells a model that dropped the top-level key that the key is missing", async () => {
    const { dispatch, calls } = scripted((_call, n) => (n === 0 ? "[]" : VALID));

    await attemptStep(request({ output: WEAKNESSES }), context(dispatch));

    assert.match(calls[1].prompt, /valid JSON but had no top-level "weaknesses" key/);
  });

  it("logs a parse retry and a schema retry with their reason and detail", async () => {
    for (const [first, reason] of [
      ["I could not complete this task.", "parse"],
      [BAD_SEVERITY, "schema"],
    ] as const) {
      const events: StepLogEventInput[] = [];
      const { dispatch } = scripted((_call, n) => (n === 0 ? first : VALID));

      await attemptStep(
        request({ output: WEAKNESSES }),
        context(dispatch, { onEvent: (e) => events.push(e) })
      );

      const retries = events.filter((e) => e.kind === "retry");
      assert.equal(retries.length, 1);
      const retry = retries[0];
      assert.equal(retry.stepId, "investigate.survey");
      assert.equal(retry.reason, reason);
      assert.ok(retry.detail.length > 0);
    }
  });

  it("sends the retry to the model that answered after a failover, not the failed primary", async () => {
    const { dispatch, calls } = scripted((call, n) => {
      if (call.entryId === "m1") throw transportFailure();
      return n === 1 ? BAD_SEVERITY : VALID;
    });

    const r = await attemptStep(request({ output: WEAKNESSES }), context(dispatch));

    assert.deepEqual(
      calls.map((c) => c.entryId),
      ["m1", "m2", "m2"],
      "the retry must go to the failover candidate, not back to the primary that just failed"
    );
    assert.equal(r.answeredBy.profileId, "secondary");
  });

  it("gives the retry the same allowance as the first call", async () => {
    const { dispatch, calls } = scripted((_call, n) => (n === 0 ? "not json" : VALID));

    await attemptStep(
      request({ step: { ...STEP, timeoutMs: 1000, maxBudgetUsd: 2 }, output: WEAKNESSES }),
      context(dispatch)
    );

    for (const call of calls) {
      assert.equal(call.deps.timeoutMs, 1000);
      assert.equal(call.deps.maxBudgetUsd, 2);
    }
  });

  it("fails with the second answer's error, leaving both raw answers", async () => {
    const { dispatch, calls } = scripted((_call, n) =>
      n === 0 ? "first narration, no JSON" : BAD_SEVERITY
    );

    const err = await failure(attemptStep(request({ output: WEAKNESSES }), context(dispatch)));

    assert.equal(calls.length, 2, "exactly one retry before failing");
    assert.equal(err.kind, "output");
    assert.match(
      err.message,
      /^Step "investigate\.survey": output does not match schema "weaknesses": /
    );
    assert.match(err.message, /must be one of low, medium, high, critical/);
    assert.equal(err.detail, err.message.replace('Step "investigate.survey": ', ""));
    assert.deepEqual(err.raw, ["first narration, no JSON", BAD_SEVERITY]);
    assert.equal(err.cause, undefined);
    assert.equal(err.answeredBy?.profileId, "primary");
  });

  it("fails a retry the transport could not deliver without a failover tail, keeping the first answer", async () => {
    const { dispatch, calls } = scripted((_call, n) => {
      if (n === 0) return "not json";
      throw transportFailure();
    });

    const err = await failure(attemptStep(request({ output: WEAKNESSES }), context(dispatch)));

    assert.equal(calls.length, 2, "a failed retry is not itself failed over");
    assert.equal(err.kind, "failed");
    assert.equal(err.stage, "retry");
    assert.equal(err.message, `Step "investigate.survey": ${transportFailure().message}`);
    assert.doesNotMatch(err.message, /Failover/);
    assert.deepEqual(err.raw, ["not json"]);
    assert.equal((err.cause as Error).message, transportFailure().message);
  });

  it("names the failover candidate on an error from the retry", async () => {
    const { dispatch } = scripted((call, n) => {
      if (call.entryId === "m1") throw transportFailure();
      if (n === 1) return "not json";
      throw transportFailure();
    });
    const req = request({ output: WEAKNESSES });

    const err = await failure(attemptStep(req, context(dispatch)));

    assert.equal(err.kind, "failed");
    assert.equal(err.answeredBy?.profileId, "secondary");
    assert.equal(err.answeredBy?.entry.id, "m2");
    assert.notEqual(err.answeredBy?.entry, req.model.entry);
  });

  it("never retries a step with no output contract", async () => {
    const { dispatch, calls } = scripted(() => "not json");

    const r = await attemptStep(request(), context(dispatch));

    assert.equal(r.value, "not json");
    assert.equal(calls.length, 1);
  });
});

// ── Events ────────────────────────────────────────────────────────────────────

describe("attemptStep — events", () => {
  it("emits the adapters' events, then the failover, then the retry, in order", async () => {
    const events: StepLogEventInput[] = [];
    const { dispatch } = scripted((call, n) => {
      call.deps.onEvent?.({ kind: "usage", costUsd: 0.1 });
      if (call.entryId === "m1") throw transportFailure();
      return n === 1 ? "not json" : VALID;
    });

    await attemptStep(
      request({ output: WEAKNESSES }),
      context(dispatch, { onEvent: (e) => events.push(e) })
    );

    assert.deepEqual(
      events.map((e) => e.kind),
      ["usage", "failover", "usage", "retry", "usage"]
    );
    const failover = events[1] as Extract<StepLogEventInput, { kind: "failover" }>;
    assert.equal(failover.stepId, "investigate.survey");
    assert.equal(failover.fromProfile, "primary");
    assert.equal(failover.toProfile, "secondary");
    assert.match(failover.reason, /claude exited with code 1/);
  });

  it("is not stopped by a sink that throws", async () => {
    const { dispatch } = scripted((call, n) => {
      call.deps.onEvent?.({ kind: "usage", costUsd: 0.1 });
      if (call.entryId === "m1") throw transportFailure();
      return n === 1 ? "not json" : VALID;
    });

    const r = await attemptStep(
      request({ output: WEAKNESSES }),
      context(dispatch, {
        onEvent: () => {
          throw new Error("disk full");
        },
      })
    );

    assert.deepEqual(r.value, { weaknesses: [] });
  });
});

// ── Through the real claude adapter ───────────────────────────────────────────

describe("attemptStep — the argv the claude CLI receives", () => {
  /** The value following `flag` in a captured argv. */
  function flagValue(argv: string[], flag: string): string {
    const idx = argv.indexOf(flag);
    assert.notEqual(idx, -1, `argv carries no ${flag}`);
    return argv[idx + 1] ?? "";
  }

  it("carries the declared grant, deny list, skills, cap and schema on the first call AND the retry", async () => {
    const answers = ["not json", VALID];
    const { spawn, capturedArgs } = makeFakeSpawnEach((call) => ({
      stdoutChunks: [makeStreamJsonStdout(answers[call] ?? VALID)],
    }));
    const step: AttemptStep = {
      ...STEP,
      permissions: { contents: "read", deny: ["ops/runbooks/**"] },
      skills: ["review"],
      maxBudgetUsd: 2,
    };

    const r = await attemptStep(request({ step, output: WEAKNESSES }), {
      registry: REGISTRY,
      providerProfiles: PROFILES,
      // An empty env keeps the machine's own ~/.claude/settings.json deny rules out of the capture.
      base: { spawn, env: {} },
      workspaceDir: process.cwd(),
    });

    assert.deepEqual(r.value, { weaknesses: [] });
    assert.equal(capturedArgs.length, 2, "one call and one retry, each its own spawn");
    for (const argv of capturedArgs) {
      assert.equal(flagValue(argv, "--tools"), "Read,Glob,Grep,Skill");
      assert.equal(flagValue(argv, "--max-budget-usd"), "2");
      assert.ok(flagValue(argv, "--plugin-dir").endsWith("/.claude"));
      assert.ok(argv.includes("--json-schema"), "the contract's schema reaches --json-schema");
      const disallowed = flagValue(argv, "--disallowedTools");
      for (const tool of ["Read", "Grep", "Edit"]) {
        assert.ok(disallowed.includes(`${tool}(ops/runbooks/**)`), `${tool} denial missing`);
      }
    }
  });
});
