# Visual pass request — spec 037 Ship 4 (developer-UI restyle, D8/FR-013)

Owner's pass. The change is presentation only: no route, payload or behaviour moved. Open the
daemon page and walk the views below. In every view the same four things are the subject: 13px
base, monospace for machine text (ids, paths, inputs, YAML, prompts, commands, run ids), one
table/badge/button style, 1px borders with a 3px radius and no shadows. Check each view once in
light and once in dark (`prefers-color-scheme`).

## `#/runs`

- Section header reads as a 12px uppercase muted label, not a page title.
- Active / Finished / All are buttons now (26px, square-ish), the selected one filled with the
  accent tint. They were pills.
- Table: uppercase 11px muted header, 30px rows, hover tints the row, no zebra.
- Status is a mono chip: `running` accent, `succeeded` green, `failed` red,
  `awaiting_approval` amber. An awaiting row also keeps the amber tint and the 3px left edge —
  it must still be the row that stands out.
- A run restored from its artifact shows a muted `disk` chip next to its status (hover it: the
  title says "restored from its artifact — this run is not live"). This replaced a tier badge —
  confirm it is still visible and not mistaken for a status.
- Started and Duration columns are muted.
- At ≥1200px wide, selecting a run splits the view: list left, detail right, 1px divider.

## A run (`#/runs/<id>`, or click a row)

- Header: workflow name with the status chip beside it, then `Run <id>` in mono with a Copy
  button.
- `HOW IT WAS RUN` / `Chat` / `curl` labels are small uppercase muted; their bodies are mono
  code blocks on the sunk background.
- `Steps` is now the same uppercase label style as the other block heads (it used to be a
  one-off bold `STEPS`).
- A step row: mono id, status chip, mono model, output excerpt; Activity and Output disclosures.
- If a step is running, open Activity: the list is 12px mono, `check.output` on stderr and
  watchdog warnings are amber (`--warn`), tool results are collapsed.
- If the run is awaiting approval, the gate box is amber-bordered with Approve (primary) and
  Reject (danger) buttons.
- Decisions table must look like every other table.

## `#/workflows`

- One table; the `Source` column is now plain muted text (`project` / `bundled`) — the coloured
  tier badges are gone everywhere. Confirm nothing looks like it lost meaning.
- Row actions are small buttons; `Delete` is the only red one.

## A workflow page (`#/workflows/<id>`)

- Head: mono workflow id, description, muted mono source word, actions right-aligned.
- The levels diagram sits in a 1px bordered box; the step table matches the other tables.
- On a bundled project the head offers Install and no Edit/Delete.

## `#/workflows/<id>/edit` (needs an installed project workflow)

- Pipeline / Prompts are button toggles now, matching the runs filters.
- YAML and prompt textareas are mono 12px on the page background with a 1px border.
- Validate / Save (primary) / Discard in the head; the status line under the editor stays muted
  and turns red on an error.
- At ≥1200px the diagram and the tabs sit side by side with a single 1px divider.

## `#/templates`

- Two sections, Bundled and Yours, each with the uppercase muted header and its muted note.
- Both tables match the Workflows table. `Install all` is in the Bundled header.

## A template preview (Preview on either section)

- Head shows a muted mono `bundled` / `template` word where a coloured badge used to be.
- Check-commands table carries mono command blocks; the file list is a run of mono chips.

## `#/settings`

- Environment is the one place a `.card` survives: key/value rows, keys muted, values mono.
- Skills / Agents chips open the reader on the right; the reader title is a mono filename and
  must NOT be uppercased (it is an id, not a section label).

## Anything to flag

Report any view where text is too small to read, a table header is not obviously a header, a
badge colour reads wrong in dark mode, or a control lost its affordance. Nothing here changes
what any button does — if a click does something unexpected, that is a bug, not a style note.
