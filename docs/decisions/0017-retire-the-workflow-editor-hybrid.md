# 0017. Retire the workflow-editor hybrid (n8n)

Status: Accepted — 2026-09-14

Supersedes: the "Superseded by n8n hybrid (2026-09-04)" note on ADR-0013; the direction ADR-0013
described is resumed by spec 037.

## Context

On 2026-09-04 the in-house editor of ADR-0013 was set aside for an n8n hybrid: Binding C exported
pipelines as n8n workflows, a community node (`integrations/n8n-nodes-agent-flows/`) ran the steps,
and the daemon page grew connect/start/stop controls and template import from n8n.

By 2026-09-13 the hybrid had not paid for itself.

- The export covered 8 of 12 pipelines. The `pipeline`, `loop` and `check` kinds and the gate
  semantics had no node to compile to (`specs/027-open-work/spec.md:145`).
- The community node spawned `claude` directly and so bypassed the daemon's confinement, its tool
  grants and its run records (`specs/027-open-work/spec.md:107`). Spec 035 proposed routing the node
  back through the daemon — a fix for a problem the hybrid created.
- Every n8n surface — the export, the import, the workflow id map, the runtime card, two dialogs —
  was a second representation of the canon that had to be kept in sync with the files.
- Spec 036 gives the run view live step activity, which was the real value the canvas was bought
  for.

## Decision

1. **n8n is retired.** The daemon is the only executor; the page is the editor (spec 037).

2. **Removed:** Binding C (`src/bindings/n8n/`), every `/api/n8n/*` route plus
   `POST /api/pipelines/:id/n8n` and `POST /api/templates/from-n8n`, the `n8nRuntime` server option
   and the routes behind it, the page's runtime card, dialogs and "Edit in n8n" / "New in n8n" /
   "Save from n8n" actions, the community node package under `integrations/`, the `generate n8n`
   CLI target, the `bindings:n8n` script, and the `n8nMapPath` state location.

3. **Spec 035 is withdrawn.** Its subject was the node that no longer exists.

4. **Research notes under `docs/research/` stay as history.** So do the spec files that record the
   hybrid; this ADR does not rewrite the record, it closes it.

## Consequences

- Fewer moving parts and one truth: the canon files.
- The page must now provide what n8n was providing — the catalogue, editing and a diagram. That is
  spec 037, Ships 2 to 4.
- Two leftover files on the owner's machine, `~/.agent-flows/n8n.json` and `<stateDir>/n8n.json`,
  hold an n8n base URL and API key. Nothing reads them any more and they can be deleted; this ADR is
  the surviving pointer to them, since the README sections that named them are gone.
- `.n8n-workflows/` directories inside projects are dead generated output and can be deleted.
- A test, `src/serve/no-n8n.test.ts`, fails the suite if the identifier reappears under `src`,
  `scripts`, `package.json`, `README.md` or `.gitignore`, or if `integrations/` comes back.
