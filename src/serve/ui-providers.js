// The provider matrix editor's markup and document builder (spec 039).
//
// Plain ESM with no dependencies and no DOM access, served by the daemon at
// /ui-providers.js and imported by ui.html. It lives here rather than inline in
// the page for the same reason ui-tables.js does: every value it renders comes
// from providers.yaml or from the operator's environment, so the escaping and
// the shape of the document that gets written back have to be testable without
// a browser.
//
// The one value this module must never see is a credential: the daemon reports
// `keyEnv` by NAME, so a key env var is rendered as a variable name and a
// set/unset flag, never as a secret.

/**
 * Escape HTML entities. Identical to `escH` in ui.html — the page's house rule
 * is that all server data is escaped with it or written via textContent.
 *
 * @param {unknown} s
 * @returns {string}
 */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The roles the matrix renders as rows, in declaration order. */
export const PROVIDER_ROLES = ["reasoner", "worker", "scout"];

/**
 * The notices above the editor.
 *
 * The staleness warning and the save confirmation are two different facts and
 * are rendered from two different inputs: `restartRequired` comes from the
 * daemon and is true on a cold load of a file that diverges from its startup
 * snapshot, while `saved` is true only after a PUT in this page session. Saying
 * "Saved to disk." on a page nobody has saved asserts an action that never
 * happened, and a line that is always present stops being read — which costs
 * the restart warning its audience.
 *
 * @param {{restartRequired?: boolean, saved?: boolean}} [state]
 * @returns {string} HTML for the notices region; empty when there is nothing to say.
 */
export function renderProviderNotices(state = {}) {
  const notices = [];
  if (state.saved) {
    notices.push(`<p class="muted" data-provider-saved>Saved to disk.</p>`);
  }
  if (state.restartRequired) {
    notices.push(
      `<p class="muted" data-provider-restart>.agent-flows/providers.yaml differs from the daemon's startup snapshot — restart it for these values to affect runs.</p>`
    );
  }
  return notices.join("");
}

/**
 * One column per profile id, project entry winning over a built-in of the same
 * id — the same find-first rule `getProfile` applies, so the table shows what
 * resolution actually does.
 *
 * @param {{profiles?: object[]}} data The `GET /api/providers` body.
 * @returns {object[]} Columns in render order: project-declared, then built-ins.
 */
export function providerColumns(data) {
  const profiles = data.profiles ?? [];
  const builtins = new Map();
  for (const p of profiles) {
    if (p.source === "builtin") builtins.set(p.id, p);
  }
  const columns = [];
  const seen = new Set();
  for (const p of profiles) {
    if (p.source !== "project" || seen.has(p.id)) continue;
    seen.add(p.id);
    const builtin = builtins.get(p.id);
    columns.push({
      id: p.id,
      roles: { ...p.roles },
      fallback: [...(p.fallback ?? [])],
      source: "project",
      overridesBuiltIn: builtin !== undefined,
      builtin:
        builtin === undefined
          ? null
          : { roles: { ...builtin.roles }, fallback: [...(builtin.fallback ?? [])] },
    });
  }
  for (const p of profiles) {
    if (p.source !== "builtin" || seen.has(p.id)) continue;
    seen.add(p.id);
    columns.push({
      id: p.id,
      roles: { ...p.roles },
      fallback: [...(p.fallback ?? [])],
      source: "builtin",
      overridesBuiltIn: false,
      builtin: { roles: { ...p.roles }, fallback: [...(p.fallback ?? [])] },
    });
  }
  return columns;
}

/**
 * The role × profile matrix: rows are roles, columns are profiles.
 *
 * Reading a row across the columns is the point — it shows the equivalent model
 * in each provider (reasoner → opus | codex | ollama-qwen), which is what makes
 * "switch provider" an informed choice rather than a guess.
 *
 * Takes the columns rather than the response body because the page re-renders
 * from its own edited state after every add or remove, not from the last GET.
 *
 * @param {object[]} columns From `providerColumns`, then edited by the page.
 * @param {{modelIds?: string[], activeProfile?: string}} [opts]
 * @returns {string} HTML for the matrix table.
 */
export function renderProviderMatrix(columns, opts = {}) {
  if (columns.length === 0) return `<p class="empty">No provider profiles.</p>`;
  const modelIds = opts.modelIds ?? [];

  const head = columns
    .map((c) => {
      const badge = c.source === "project" ? "project" : "built-in";
      const note = c.overridesBuiltIn
        ? `<div class="muted">overrides the built-in "${esc(c.id)}"</div>`
        : "";
      const active = c.id === opts.activeProfile ? `<span class="badge active">active</span>` : "";
      const remove =
        c.source === "project"
          ? `<button class="btn" data-remove-profile="${esc(c.id)}" title="Remove this project profile">×</button>`
          : "";
      // `fallback` is a property of the profile, not a model assignment, so it
      // sits with the other profile-level facts in the header rather than as a
      // fourth row in a three-role table.
      return `<th data-profile-col="${esc(c.id)}">
        <div class="matrix-cell">
          <div class="cfg-head"><code>${esc(c.id)}</code><span class="badge">${esc(badge)}</span>${active}${remove}</div>
          ${note}
          <div class="cfg-sub"><span>fallback</span>
            <input class="cfg-input" type="text" data-fallback-profile="${esc(c.id)}"
              placeholder="none" value="${esc((c.fallback ?? []).join(", "))}" /></div>
          <div class="error-box cell-error" data-profile-error="${esc(c.id)}" hidden></div>
        </div>
      </th>`;
    })
    .join("");

  const rows = PROVIDER_ROLES.map((role) => {
    const cells = columns
      .map(
        (c) =>
          `<td class="matrix-cell"><input class="cfg-input" type="text" list="provider-model-ids"
             data-cell-profile="${esc(c.id)}" data-cell-role="${esc(role)}"
             value="${esc(c.roles?.[role] ?? "")}" />
           <div class="error-box cell-error" data-cell-error-profile="${esc(c.id)}" data-cell-error-role="${esc(role)}" hidden></div></td>`
      )
      .join("");
    return `<tr><th scope="row"><code>${esc(role)}</code></th>${cells}</tr>`;
  }).join("");

  const datalist = `<datalist id="provider-model-ids">${modelIds
    .map((id) => `<option value="${esc(id)}"></option>`)
    .join("")}</datalist>`;

  return `${datalist}<table class="table"><thead><tr><th>Role</th>${head}</tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/**
 * The model entries table. Project-declared entries are editable; built-ins are
 * shown read-only because they live in the registry's source, and the way to
 * change one is to declare a project entry with the same id — which the badge
 * on the shadowed built-in makes visible.
 *
 * @param {object[]} project Editable project entries, in the page's edit order.
 * @param {object[]} builtin Read-only built-in entries from the last GET.
 * @returns {string} HTML for the models table.
 */
export function renderProviderModels(project, builtin = []) {
  const rows = (project ?? []).map((m, i) => renderModelRow(m, i)).join("");
  const builtinRows = builtin
    .map((m) => {
      const detail =
        m.transport === "cli"
          ? `${esc(m.cli?.bin ?? "")}${m.cli?.model ? ` ${esc(m.cli.model)}` : ""}`
          : `${esc(m.api?.endpoint ?? "")}${m.api?.model ? ` ${esc(m.api.model)}` : ""}`;
      const key = m.api?.keyEnv
        ? `<span class="badge">${esc(m.api.keyEnv)} ${m.api.keyEnvSet ? "set" : "unset"}</span>`
        : "";
      const shadowed = m.overriddenByProject
        ? `<span class="badge">overridden</span>`
        : `<span class="badge">built-in</span>`;
      return `<tr><td><code>${esc(m.id)}</code></td><td><code>${esc(m.transport)}</code></td>
        <td><code>${detail}</code> ${key}</td><td>${shadowed}</td></tr>`;
    })
    .join("");

  return `<table class="table"><thead><tr>
      <th>ID</th><th>Transport</th><th>Target</th><th></th>
    </tr></thead><tbody>${rows}${builtinRows}</tbody></table>`;
}

/**
 * One editable project model row. The api column offers `keyEnv` — the NAME of
 * an environment variable — and deliberately has no field for its value: a
 * credential must never travel through this form.
 *
 * @param {object} m
 * @param {number} index Position among the project entries; the error anchor.
 * @returns {string}
 */
function renderModelRow(m, index) {
  const isApi = m.transport === "api";
  const cliBlock = `<span data-model-cli="${index}"${isApi ? " hidden" : ""}>
      <select class="cfg-input" data-model-bin="${index}">
        <option value="claude"${m.cli?.bin === "codex" ? "" : " selected"}>claude</option>
        <option value="codex"${m.cli?.bin === "codex" ? " selected" : ""}>codex</option>
      </select>
      <input class="cfg-input" type="text" data-model-climodel="${index}" placeholder="model (optional)"
        value="${esc(m.cli?.model ?? "")}" />
    </span>`;
  const apiBlock = `<span data-model-api="${index}"${isApi ? "" : " hidden"}>
      <input class="cfg-input" type="text" data-model-endpoint="${index}" placeholder="https://host/v1/chat/completions"
        value="${esc(m.api?.endpoint ?? "")}" />
      <input class="cfg-input" type="text" data-model-keyenv="${index}" placeholder="KEY_ENV_NAME (never the key)"
        value="${esc(m.api?.keyEnv ?? "")}" />
      <input class="cfg-input" type="text" data-model-apimodel="${index}" placeholder="model (optional)"
        value="${esc(m.api?.model ?? "")}" />
    </span>`;
  return `<tr>
      <td><input class="cfg-input" type="text" data-model-id="${index}" value="${esc(m.id ?? "")}" />
        <div class="error-box" data-model-error="${index}" hidden></div></td>
      <td><select class="cfg-input" data-model-transport="${index}">
        <option value="cli"${isApi ? "" : " selected"}>cli</option>
        <option value="api"${isApi ? " selected" : ""}>api</option>
      </select></td>
      <td>${cliBlock}${apiBlock}</td>
      <td><button class="btn" data-remove-model="${index}">Remove</button></td>
    </tr>`;
}

/** Drop a key whose value is an empty string, so an untouched optional field is absent. */
function optional(key, value) {
  return typeof value === "string" && value.trim() !== "" ? { [key]: value.trim() } : {};
}

/**
 * Build the providers.yaml document from the form state.
 *
 * A built-in profile column is emitted only when it was actually changed:
 * writing every built-in back would freeze today's defaults into the project
 * file, so a later change to the shipped registry would silently not apply.
 *
 * @param {{defaultProvider?: string, profiles: object[], models: object[]}} form
 * @returns {{document: object, profileIds: string[], modelIds: string[]}}
 *   `profileIds`/`modelIds` are in emitted order, so a validator error naming
 *   `profiles[1]` can be attached to the column it came from.
 */
export function collectProviderDocument(form) {
  const profiles = [];
  const profileIds = [];
  for (const p of form.profiles ?? []) {
    const roles = {};
    for (const role of PROVIDER_ROLES) roles[role] = (p.roles?.[role] ?? "").trim();
    const fallback = (p.fallback ?? []).map((f) => f.trim()).filter((f) => f !== "");
    if (p.source !== "project" && p.builtin && !changed(roles, fallback, p.builtin)) continue;
    profiles.push({ id: (p.id ?? "").trim(), roles, ...(fallback.length > 0 ? { fallback } : {}) });
    profileIds.push((p.id ?? "").trim());
  }

  const models = [];
  const modelIds = [];
  for (const m of form.models ?? []) {
    const id = (m.id ?? "").trim();
    if (m.transport === "api") {
      models.push({
        id,
        transport: "api",
        api: {
          endpoint: (m.api?.endpoint ?? "").trim(),
          ...optional("keyEnv", m.api?.keyEnv),
          ...optional("model", m.api?.model),
        },
      });
    } else {
      models.push({
        id,
        transport: "cli",
        cli: {
          bin: m.cli?.bin === "codex" ? "codex" : "claude",
          ...optional("model", m.cli?.model),
        },
      });
    }
    modelIds.push(id);
  }

  const defaultProvider = (form.defaultProvider ?? "").trim();
  return {
    document: {
      version: 1,
      models,
      profiles,
      ...(defaultProvider !== "" ? { defaultProvider } : {}),
    },
    profileIds,
    modelIds,
  };
}

/** Whether a column's roles or fallback differ from the built-in it shadows. */
function changed(roles, fallback, builtin) {
  for (const role of PROVIDER_ROLES) {
    if ((roles[role] ?? "") !== (builtin.roles?.[role] ?? "")) return true;
  }
  const base = builtin.fallback ?? [];
  return fallback.length !== base.length || fallback.some((id, i) => id !== base[i]);
}

const RE_FIELD_PATH = /^[^:]*:\s*(profiles|models)\[(\d+)\]([^:]*):\s*([\s\S]*)$/u;

/**
 * Locate a validator error so the page can show it next to what was wrong.
 *
 * The parser's messages are `<source>: <field path>: <reason>` — everything the
 * page needs to anchor an error is already in them, so it is read rather than
 * the errors being re-invented with a second validation pass in the browser.
 *
 * @param {string} message
 * @returns {{scope: string, index: number|null, field: string, reason: string}}
 */
export function parseProviderError(message) {
  const text = String(message ?? "");
  const match = RE_FIELD_PATH.exec(text);
  if (!match) return { scope: "document", index: null, field: "", reason: text };
  return {
    scope: match[1],
    index: Number(match[2]),
    field: match[3].replace(/^\./u, ""),
    reason: match[4],
  };
}
