// Tests for the provider matrix editor's renderers and document builder
// (spec 039 V5).
//
// The matrix is the only place the page builds HTML from providers.yaml, and
// the document builder is what decides which bytes get written back — so both
// the escaping and the "which columns are emitted" rule are asserted here,
// without a DOM.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PROVIDER_ROLES,
  collectProviderDocument,
  parseProviderError,
  providerColumns,
  modelLabel,
  modelOptions,
  renderProviderMatrix,
  renderProviderModels,
  renderProviderNotices,
} from "./ui-providers.js";

/** A GET /api/providers body with one project profile shadowing a built-in. */
function sampleData() {
  return {
    activeProfile: "anthropic",
    profiles: [
      {
        id: "anthropic",
        roles: { reasoner: "opus", worker: "sonnet", scout: "haiku" },
        fallback: ["openai"],
        source: "project",
        overridesBuiltIn: true,
      },
      {
        id: "anthropic",
        roles: { reasoner: "opus", worker: "sonnet", scout: "haiku" },
        fallback: ["openai"],
        source: "builtin",
        overriddenByProject: true,
      },
      {
        id: "openai",
        roles: { reasoner: "codex", worker: "codex", scout: "codex" },
        fallback: ["anthropic"],
        source: "builtin",
        overriddenByProject: false,
      },
    ],
    models: [{ id: "opus", transport: "cli", cli: { bin: "claude" }, source: "builtin" }],
  };
}

describe("renderProviderNotices — staleness and save are two facts (D1)", () => {
  it("never claims a save on a page that has not saved", () => {
    const html = renderProviderNotices({ restartRequired: true, saved: false });
    assert.ok(
      !html.includes("Saved to disk"),
      "a cold load of a stale file must not assert a save this session never made"
    );
    assert.match(html, /differs from the daemon's startup snapshot/u);
  });

  it("confirms a save that actually happened", () => {
    const html = renderProviderNotices({ restartRequired: true, saved: true });
    assert.ok(html.includes("Saved to disk."), "a real save must be confirmed");
    assert.match(html, /differs from the daemon's startup snapshot/u);
  });

  it("says nothing when the file is in force and nothing was saved", () => {
    assert.equal(renderProviderNotices({}), "");
  });
});

describe("providerColumns — one column per id, project wins (3.5)", () => {
  it("puts project-declared profiles first and keeps the built-in it shadows", () => {
    const columns = providerColumns(sampleData());
    assert.deepEqual(
      columns.map((c) => [c.id, c.source]),
      [
        ["anthropic", "project"],
        ["openai", "builtin"],
      ]
    );
    assert.equal(columns[0].overridesBuiltIn, true, "the shadowed built-in must be reported");
    assert.deepEqual(columns[0].builtin?.roles.worker, "sonnet");
    assert.equal(columns[1].overridesBuiltIn, false);
  });

  it("returns no columns for an empty document", () => {
    assert.deepEqual(providerColumns({}), []);
  });
});

describe("the model picker shows the whole list and what each one resolves to (042 D20)", () => {
  const MODELS = [
    { id: "opus", transport: "cli", cli: { bin: "claude", model: "claude-opus-5" } },
    { id: "haiku", transport: "cli", cli: { bin: "claude", model: "claude-haiku-4-5" } },
    { id: "codex", transport: "cli", cli: { bin: "codex" } },
    { id: "ollama-qwen", transport: "api", api: { model: "qwen2.5:1.5b" } },
  ];

  it("names the version a pinned entry resolves to, not just its id", () => {
    assert.equal(modelLabel(MODELS[0]), "opus — claude-opus-5");
    assert.equal(modelLabel(MODELS[3]), "ollama-qwen — qwen2.5:1.5b");
  });

  it("says a CLI-default entry pins nothing rather than implying it does", () => {
    assert.equal(modelLabel(MODELS[2]), "codex — codex default");
  });

  it("offers every entry, so the list is not something to be typed from memory", () => {
    const html = modelOptions(MODELS, "opus");
    for (const m of MODELS) assert.ok(html.includes(`value="${m.id}"`), `missing ${m.id}`);
    assert.equal((html.match(/<option/gu) ?? []).length, MODELS.length);
    assert.ok(html.includes('value="opus" selected'), "the current value must be selected");
  });

  it("keeps a value the registry no longer carries, and says so", () => {
    const html = modelOptions(MODELS, "sonnet-legacy");
    assert.ok(
      html.includes('value="sonnet-legacy" selected'),
      `dropping it would rewrite the profile silently: ${html}`
    );
    assert.ok(html.includes("not in the registry"));
  });

  it("offers an explicit empty choice when the role has no model yet", () => {
    assert.ok(modelOptions(MODELS, "").includes('value="" selected'));
  });

  it("puts a real select in every cell — a datalist only suggests what you type", () => {
    const html = renderProviderMatrix(providerColumns(sampleData()), { models: MODELS });
    assert.ok(html.includes('<select class="cfg-input"'), `cells must be selects: ${html}`);
    assert.ok(!html.includes("provider-model-ids"), "the datalist is gone");
    assert.ok(html.includes("claude-opus-5"), "a version must be readable in the picker");
  });
});

describe("renderProviderMatrix — roles are rows, profiles are columns (3.1)", () => {
  it("renders one row per role and one column per profile", () => {
    const html = renderProviderMatrix(providerColumns(sampleData()), {
      models: [
        { id: "opus", cli: { bin: "claude", model: "claude-opus-5" } },
        { id: "codex", cli: { bin: "codex" } },
      ],
      activeProfile: "anthropic",
    });
    for (const role of PROVIDER_ROLES) {
      assert.ok(html.includes(`data-cell-role="${role}"`), `no cell for role ${role}`);
    }
    assert.ok(html.includes('data-profile-col="anthropic"'));
    assert.ok(html.includes('data-profile-col="openai"'));
    // Reading the reasoner row across the columns is the equivalence view.
    assert.ok(html.includes('data-cell-profile="anthropic" data-cell-role="reasoner"'));
    assert.ok(html.includes('data-cell-profile="openai" data-cell-role="reasoner"'));
  });

  it("marks built-in columns and the ones a project profile overrides", () => {
    const html = renderProviderMatrix(providerColumns(sampleData()));
    assert.ok(html.includes("built-in"), "the built-in column must be labelled");
    assert.ok(html.includes("overrides the built-in"), "the override must be visible");
  });

  it("renders the fallback chain as an editable profile-level field, not a role row", () => {
    const html = renderProviderMatrix(providerColumns(sampleData()));
    assert.ok(html.includes('data-fallback-profile="anthropic"'));
    assert.ok(html.includes('value="openai"'), "the chain must be pre-filled");
    const body = html.slice(html.indexOf("<tbody>"));
    assert.ok(
      !body.includes("data-fallback-profile"),
      "fallback is a profile property — it must not read as a fourth role row"
    );
    assert.equal(
      body.match(/<tr>/gu)?.length,
      PROVIDER_ROLES.length,
      "the matrix body has exactly one row per role"
    );
  });

  it("marks the profile in force with its own chip", () => {
    const html = renderProviderMatrix(providerColumns(sampleData()), {
      activeProfile: "anthropic",
    });
    assert.ok(
      html.includes('<span class="badge active">active</span>'),
      "active must be a chip, not another run of header text"
    );
  });

  it("gives every role cell its own error anchor (D3)", () => {
    const html = renderProviderMatrix(providerColumns(sampleData()));
    assert.ok(
      html.includes('data-cell-error-profile="anthropic" data-cell-error-role="worker"'),
      "a validation error must be able to anchor to the cell at fault"
    );
  });

  it("escapes every interpolated value", () => {
    const html = renderProviderMatrix([
      {
        id: "<img src=x onerror=alert(1)>",
        roles: { reasoner: '"><script>bad()</script>', worker: "", scout: "" },
        fallback: ["<b>"],
        source: "project",
        overridesBuiltIn: false,
        builtin: null,
      },
    ]);
    assert.ok(!html.includes("<img"), "a profile id must not reach the DOM as markup");
    assert.ok(!html.includes("<script>"), "a role value must not reach the DOM as markup");
    assert.ok(html.includes("&lt;img"), "the id must appear escaped");
  });

  it("says so rather than rendering an empty table", () => {
    assert.match(renderProviderMatrix([]), /No provider profiles/u);
  });
});

describe("renderProviderModels — project entries edit, built-ins read (3.4)", () => {
  it("renders an editable row per project entry and a read-only row per built-in", () => {
    const html = renderProviderModels(
      [{ id: "mine", transport: "cli", cli: { bin: "codex", model: "" }, api: {} }],
      [
        {
          id: "litellm",
          transport: "api",
          api: {
            endpoint: "http://localhost:4000/v1",
            keyEnv: "LITELLM_VIRTUAL_KEY",
            keyEnvSet: true,
          },
        },
      ]
    );
    assert.ok(html.includes('data-model-id="0"'), "the project entry must be editable");
    assert.ok(html.includes('data-remove-model="0"'));
    assert.ok(html.includes("LITELLM_VIRTUAL_KEY"), "the key env NAME is shown");
    assert.ok(!html.includes('data-model-id="1"'), "a built-in entry must not be editable");
  });

  it("never renders a field that could carry a key value", () => {
    const html = renderProviderModels([
      {
        id: "x",
        transport: "api",
        cli: {},
        api: { endpoint: "https://h/v1", keyEnv: "MY_KEY", model: "" },
      },
    ]);
    assert.ok(html.includes('data-model-keyenv="0"'), "the NAME is editable");
    assert.ok(!/data-model-key(value|secret)/u.test(html), "no field may hold a key value");
  });

  it("escapes model fields", () => {
    const html = renderProviderModels(
      [],
      [{ id: "<i>x</i>", transport: "cli", cli: { bin: "claude" } }]
    );
    assert.ok(!html.includes("<i>"), "a model id must not reach the DOM as markup");
  });
});

describe("collectProviderDocument — what actually gets written (2.x)", () => {
  it("emits a project profile and drops an unchanged built-in column", () => {
    const built = collectProviderDocument({
      defaultProvider: "mine",
      profiles: [
        {
          id: "mine",
          roles: { reasoner: "opus", worker: "sonnet", scout: "haiku" },
          fallback: ["anthropic"],
          source: "project",
          builtin: null,
        },
        {
          id: "openai",
          roles: { reasoner: "codex", worker: "codex", scout: "codex" },
          fallback: ["anthropic"],
          source: "builtin",
          builtin: {
            roles: { reasoner: "codex", worker: "codex", scout: "codex" },
            fallback: ["anthropic"],
          },
        },
      ],
      models: [],
    });
    assert.deepEqual(built.profileIds, ["mine"]);
    assert.deepEqual(built.document, {
      version: 1,
      models: [],
      profiles: [
        {
          id: "mine",
          roles: { reasoner: "opus", worker: "sonnet", scout: "haiku" },
          fallback: ["anthropic"],
        },
      ],
      defaultProvider: "mine",
    });
  });

  it("emits a built-in column once it is edited, so the override is persisted", () => {
    const built = collectProviderDocument({
      profiles: [
        {
          id: "anthropic",
          roles: { reasoner: "fable", worker: "sonnet", scout: "haiku" },
          fallback: ["openai"],
          source: "builtin",
          builtin: {
            roles: { reasoner: "opus", worker: "sonnet", scout: "haiku" },
            fallback: ["openai"],
          },
        },
      ],
      models: [],
    });
    assert.deepEqual(built.profileIds, ["anthropic"]);
    const profiles = built.document.profiles as { roles: Record<string, string> }[];
    assert.equal(profiles[0].roles.reasoner, "fable");
  });

  it("drops empty optional fields so the validator never sees a blank string", () => {
    const built = collectProviderDocument({
      profiles: [],
      models: [
        { id: "a", transport: "cli", cli: { bin: "claude", model: "" }, api: {} },
        {
          id: "b",
          transport: "api",
          cli: {},
          api: { endpoint: "https://h/v1", keyEnv: "  ", model: "m" },
        },
      ],
    });
    assert.deepEqual(built.document.models, [
      { id: "a", transport: "cli", cli: { bin: "claude" } },
      { id: "b", transport: "api", api: { endpoint: "https://h/v1", model: "m" } },
    ]);
    assert.deepEqual(built.modelIds, ["a", "b"]);
  });

  it("omits defaultProvider when none is chosen", () => {
    const built = collectProviderDocument({ defaultProvider: "", profiles: [], models: [] });
    assert.ok(!("defaultProvider" in built.document));
  });
});

describe("parseProviderError — anchoring a 400 to a field (3.6)", () => {
  it("locates a profile field", () => {
    const where = parseProviderError(
      ".agent-flows/providers.yaml: profiles[1].roles.worker: must be a non-empty string"
    );
    assert.deepEqual(where, {
      scope: "profiles",
      index: 1,
      field: "roles.worker",
      reason: "must be a non-empty string",
    });
  });

  it("locates a model field", () => {
    const where = parseProviderError(
      ".agent-flows/providers.yaml: models[0].api.endpoint: must be an absolute URL"
    );
    assert.equal(where.scope, "models");
    assert.equal(where.index, 0);
    assert.equal(where.field, "api.endpoint");
  });

  it("falls back to the whole document when there is no field path", () => {
    const where = parseProviderError(".agent-flows/providers.yaml: version: is required");
    assert.equal(where.scope, "document");
    assert.equal(where.index, null);
    assert.match(where.reason, /version/u);
  });
});
