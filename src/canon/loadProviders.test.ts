import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProvidersIoError,
  ProvidersParseError,
  ProvidersValidationError,
  loadProviders,
  parseProviders,
} from "./loadProviders.js";

// ── parseProviders: absent / empty content ────────────────────────────────────

describe("parseProviders — absent / empty", () => {
  it("absent-file-returns-empty-config: null parses to empty config", () => {
    // A YAML file with only comments parses to null in the yaml library.
    const result = parseProviders("# just a comment\n", "test");
    assert.deepEqual(result, { models: [], profiles: [] });
  });

  it("empty string parses to empty config", () => {
    const result = parseProviders("", "test");
    assert.deepEqual(result, { models: [], profiles: [] });
  });
});

// ── parseProviders: full example ──────────────────────────────────────────────

describe("parseProviders — full example from spec", () => {
  const yaml = `
version: 1
defaultProvider: budget
models:
  - id: deepseek
    transport: api
    api:
      endpoint: http://localhost:11434/v1/chat/completions
      model: deepseek-r1:14b
  - id: gpt5
    transport: cli
    cli: { bin: codex, model: gpt-5 }
  - id: sonnet
    transport: cli
    cli: { bin: claude, model: claude-sonnet-4-5 }
profiles:
  - id: budget
    roles: { reasoner: deepseek, worker: gpt5, scout: haiku }
  - id: anthropic
    roles: { reasoner: opus, worker: sonnet, scout: haiku }
`;

  it("parses-full-example: models, profiles, and defaultProvider are correct", () => {
    const result = parseProviders(yaml, "test");
    assert.equal(result.defaultProvider, "budget");
    assert.equal(result.models.length, 3);
    assert.equal(result.profiles.length, 2);

    const deepseek = result.models.find((m) => m.id === "deepseek")!;
    assert.equal(deepseek.transport, "api");
    assert.equal(deepseek.api?.endpoint, "http://localhost:11434/v1/chat/completions");
    assert.equal(deepseek.api?.model, "deepseek-r1:14b");

    const gpt5 = result.models.find((m) => m.id === "gpt5")!;
    assert.equal(gpt5.transport, "cli");
    assert.equal(gpt5.cli?.bin, "codex");
    assert.equal(gpt5.cli?.model, "gpt-5");

    const sonnet = result.models.find((m) => m.id === "sonnet")!;
    assert.equal(sonnet.transport, "cli");
    assert.equal(sonnet.cli?.bin, "claude");
    assert.equal(sonnet.cli?.model, "claude-sonnet-4-5");

    const budget = result.profiles.find((p) => p.id === "budget")!;
    assert.equal(budget.roles.reasoner, "deepseek");
    assert.equal(budget.roles.worker, "gpt5");
    assert.equal(budget.roles.scout, "haiku");

    const anthropic = result.profiles.find((p) => p.id === "anthropic")!;
    assert.equal(anthropic.roles.reasoner, "opus");
    assert.equal(anthropic.roles.worker, "sonnet");
    assert.equal(anthropic.roles.scout, "haiku");
  });
});

// ── parseProviders: schema rejections (FR-003) ────────────────────────────────

describe("parseProviders — schema rejections", () => {
  function rejectsWithField(yaml: string, field: string): void {
    assert.throws(
      () => parseProviders(yaml, "providers.yaml"),
      (err: unknown) => {
        assert.ok(
          err instanceof ProvidersValidationError,
          `not a validation error: ${String(err)}`
        );
        assert.ok(err.message.includes(field), `error does not mention "${field}": ${err.message}`);
        return true;
      }
    );
  }

  it("rejects-bad-version: version must be 1", () => {
    rejectsWithField("version: 2\n", "version");
  });

  it("rejects-unknown-top-level-key: 'extra' is not allowed", () => {
    rejectsWithField("version: 1\nextra: true\n", "extra");
  });

  it("rejects-duplicate-model-id: two entries with id 'sonnet'", () => {
    const yaml = `
version: 1
models:
  - id: sonnet
    transport: cli
    cli: { bin: claude }
  - id: sonnet
    transport: cli
    cli: { bin: claude }
`;
    rejectsWithField(yaml, "sonnet");
  });

  it("rejects-duplicate-profile-id: two profiles with id 'anthropic'", () => {
    const yaml = `
version: 1
profiles:
  - id: anthropic
    roles: { reasoner: fable, worker: sonnet, scout: haiku }
  - id: anthropic
    roles: { reasoner: fable, worker: sonnet, scout: haiku }
`;
    rejectsWithField(yaml, "anthropic");
  });

  it("rejects-missing-role-key: profile missing 'scout'", () => {
    const yaml = `
version: 1
profiles:
  - id: myprofile
    roles: { reasoner: fable, worker: sonnet }
`;
    rejectsWithField(yaml, "scout");
  });

  it("rejects-unknown-role-key: 'executor' is not a valid role", () => {
    const yaml = `
version: 1
profiles:
  - id: myprofile
    roles: { reasoner: fable, worker: sonnet, scout: haiku, executor: opus }
`;
    rejectsWithField(yaml, "executor");
  });

  it("rejects-bad-transport: only 'cli' and 'api' are valid", () => {
    const yaml = `
version: 1
models:
  - id: mymodel
    transport: grpc
`;
    rejectsWithField(yaml, "transport");
  });

  it("rejects-bad-cli-bin: only 'claude' and 'codex' are valid", () => {
    const yaml = `
version: 1
models:
  - id: mymodel
    transport: cli
    cli: { bin: gpt }
`;
    rejectsWithField(yaml, "cli.bin");
  });

  it("rejects-unknown-default-provider: names an unknown profile", () => {
    const yaml = `
version: 1
defaultProvider: nonexistent
`;
    rejectsWithField(yaml, "defaultProvider");
  });

  it("rejects-bad-yaml: syntax error names the field", () => {
    const yaml = "version: 1\nmodels: [unclosed";
    assert.throws(
      () => parseProviders(yaml, "providers.yaml"),
      (err: unknown) => {
        assert.ok(
          err instanceof ProvidersParseError,
          `expected ProvidersParseError, got ${String(err)}`
        );
        return true;
      }
    );
  });
});

// ── parseProviders: passthrough role values ───────────────────────────────────

describe("parseProviders — role passthrough", () => {
  it("accepts arbitrary role values not in the built-in model set (registry passthrough)", () => {
    const yaml = `
version: 1
profiles:
  - id: custom
    roles: { reasoner: my-custom-alias, worker: some-other-alias, scout: haiku }
`;
    const result = parseProviders(yaml, "test");
    assert.equal(result.profiles[0].roles.reasoner, "my-custom-alias");
    assert.equal(result.profiles[0].roles.worker, "some-other-alias");
  });
});

// ── parseProviders: defaultProvider can name a built-in ──────────────────────

describe("parseProviders — defaultProvider names a built-in profile", () => {
  it("accepts 'anthropic' as defaultProvider (built-in)", () => {
    const yaml = `
version: 1
defaultProvider: anthropic
`;
    const result = parseProviders(yaml, "test");
    assert.equal(result.defaultProvider, "anthropic");
  });

  it("accepts a project-declared profile id as defaultProvider", () => {
    const yaml = `
version: 1
defaultProvider: myprofile
profiles:
  - id: myprofile
    roles: { reasoner: fable, worker: sonnet, scout: haiku }
`;
    const result = parseProviders(yaml, "test");
    assert.equal(result.defaultProvider, "myprofile");
  });
});

// ── loadProviders: filesystem behaviour ──────────────────────────────────────

describe("loadProviders — filesystem", () => {
  it("absent-file-returns-empty-config: ENOENT means no file = empty config", () => {
    const result = loadProviders("/tmp/definitely-does-not-exist-xyzzy", {
      readFile: () => {
        const err = new Error("not found") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    });
    assert.deepEqual(result, { models: [], profiles: [] });
  });

  it("ENOTDIR treated as absent", () => {
    const result = loadProviders("/some/path", {
      readFile: () => {
        const err = new Error("not a directory") as NodeJS.ErrnoException;
        err.code = "ENOTDIR";
        throw err;
      },
    });
    assert.deepEqual(result, { models: [], profiles: [] });
  });

  it("EACCES re-throws as ProvidersIoError", () => {
    assert.throws(
      () =>
        loadProviders("/some/path", {
          readFile: () => {
            const err = new Error("permission denied") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProvidersIoError, `expected ProvidersIoError, got ${String(err)}`);
        return true;
      }
    );
  });

  it("reads providers.yaml content when present", () => {
    const yaml = "version: 1\n";
    const result = loadProviders("/fake/project", {
      readFile: () => yaml,
    });
    assert.deepEqual(result, { models: [], profiles: [] });
  });

  it("malformed content throws ProvidersValidationError (not silent fallback)", () => {
    assert.throws(
      () =>
        loadProviders("/fake/project", {
          readFile: () => "version: 2\n",
        }),
      (err: unknown) => {
        assert.ok(
          err instanceof ProvidersValidationError,
          `expected ProvidersValidationError, got ${String(err)}`
        );
        assert.ok(err.message.includes("version"), `error must mention field: ${err.message}`);
        return true;
      }
    );
  });
});
