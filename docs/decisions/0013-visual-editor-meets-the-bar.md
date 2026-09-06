# 0013. A visual editor meets the Charter's bar

Status: Superseded by n8n hybrid (2026-09-04) — the direction described here (agent-flows-served DAG editor) was evaluated live on 2026-09-04 and superseded by Binding C (n8n). See README "Current direction" section and `docs/research/2026-09-04-n8n-spike.md`. Originally Accepted (2026-09-03).

Amends: ADR-0011 (operating surface), the README Charter. Does not revive ADR-0010.

## Context

The Charter states that agent-flows is a harness for "building, editing and running" dynamic workflows,
and spec 014 records that only running is implemented. The same Charter defers visual authoring:

> A visual workflow editor is desirable but no evaluated option has met the bar, so it is
> deliberately out of scope until one does.

Rivet was the evaluated option. Spec 011 passed its engine on the rubric and rejected its authoring
experience; hands-on use confirmed the wider problem, which is structural rather than cosmetic. It
is a separate desktop application on its own release cadence, carrying visible age and stalled
maintenance, and therefore unable to move at the speed of the canon it would be editing. Its code
was removed from this repository on 2026-09-03; the spike record remains in specs/011.

The Charter's deferral is a bar, not a ban. The question is whether any option clears it.

## Decision

1. **A web editor shipped inside agent-flows clears the bar, and visual authoring is no longer out of
   scope.** It inverts each property that disqualified Rivet: it ships with the canon, it updates
   when the canon updates, and it runs in a window the operator already has open — Claude Code's
   browser pane, T3 Code's desktop Browser panel, or an ordinary browser. It is one web
   application viewed in three places, not three integrations.

2. **The Charter's Operating surface paragraph is amended.** Chat remains a first-class surface and
   definitions remain files; the sentence deferring a visual editor is replaced by a statement that
   the editor is part of the product and writes the same files chat writes.

3. **The editor is served by a loopback-only local process.** `agent-flows serve` binds `127.0.0.1` and
   refuses any non-loopback bind. This does not revive ADR-0010's orchestrator, which was removed
   as a single-machine, chat-first decision: there is no remote execution, no remote approve, no
   multi-user access and no network-reachable control plane. The daemon serves an editor to the
   operator sitting at the machine, and nothing else.

4. **Files remain the source of record.** The editor writes the canon files that ADR-0011 defines
   and ADR-0003 keeps in git. A SQLite draft buffer sits in front of the file so an invalid or
   half-written edit never reaches disk, but nothing an agent, a CLI or git reads ever comes from
   that database.

5. **The root is where the harness was launched**, not where agent-flows is installed. There is no project
   registry and no multi-project bookkeeping; a scope flag selects a project-local pipeline or a
   global one.

## Consequences

- The README Charter must be edited in the same change that lands this ADR, or the project's stated
  policy contradicts its own code.
- A frontend toolchain enters a repository that had none. ADR-0004's supply-chain posture applies to
  it: exact pinning, a frozen lockfile, assets built and served from local disk, no CDN or remote
  origin at runtime.
- Rejecting a non-loopback bind outright keeps authentication out of scope. The moment a
  non-loopback bind is wanted, an access-control decision becomes mandatory and needs its own ADR.
- Spec 011's verdict on Rivet stands and is not reopened; this ADR replaces the category, not the
  evaluation.
