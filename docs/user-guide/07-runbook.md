# 07. Runbook

## Purpose

A sequenced, phased view of the same recommendations — what to do
first, second, third, and how to roll back if a step fails.

## How to open

- URL: `/runbook`.
- Modes: both static and control plane.

## Inputs

`fabric_mapping.json` — specifically the `runbook[]` array, generated
by `fabric_mapping.runbook_builder` from the recommendations plus a
phase / dependency heuristic.

## Layout

```
Migration runbook

Phase 1 — Pre-migration
┌───┬───────────────────────────────────────┬──────────┬────────┬─────────────────────┐
│ # │ Step                                  │ Severity │ Effort │ Target              │
├───┼───────────────────────────────────────┼──────────┼────────┼─────────────────────┤
│ 1 │ Refresh statistics on all tables    ▾ │ ◐ warn   │ S      │ dwpool01            │
│ 2 │ Backfill VIEW DEFINITION grant      ▾ │ ●        │ XS     │ dwpool01            │
└───┴───────────────────────────────────────┴──────────┴────────┴─────────────────────┘

Phase 2 — Schema migration
┌───┬───────────────────────────────────────┬──────────┬────────┬─────────────────────┐
│ # │ Step                                  │ Severity │ Effort │ Target              │
├───┼───────────────────────────────────────┼──────────┼────────┼─────────────────────┤
│ 1 │ Convert column collation to UTF-8   ▾ │ ●        │ M      │ dbo.Customer.Notes  │
│ 2 │ Rewrite MERGE in dbo.UpsertCustomer ▾ │ ●        │ M      │ dbo.UpsertCustomer  │
│ … │                                       │          │        │                     │
└───┴───────────────────────────────────────┴──────────┴────────┴─────────────────────┘

Phase 3 — Pipeline migration
…

Phase 4 — Post-migration validation
…
```

Each phase is its own table; rows are sorted by `order`. Clicking the
**Step** title expands an inline panel with the full detail and a
**Rollback** note when one is provided.

## Field reference

### Sections (one per phase)

The phase string is rendered verbatim from `phase`. The default phase
labels emitted by the analyzer are:

- *Phase 1 — Pre-migration* (statistics, grants, sizing decisions)
- *Phase 2 — Schema migration* (DDL changes, collation, distribution)
- *Phase 3 — Pipeline migration* (Fabric Data Factory remappings)
- *Phase 4 — Post-migration validation* (object / row count parity)

### Table columns

| Column     | Field      | Notes |
| ---------- | ---------- | ----- |
| **#**      | `order`    | 1-based step number within the phase. |
| **Step**   | `title`    | Click to expand `detail` and `rollback`. |
| **Severity** | `severity` | Same pill semantics as [Recommendations](06-recommendations.md). |
| **Effort** | `effort`   | T-shirt size (`XS` … `XL`). |
| **Target** | `target`   | The object / pool / pipeline this step modifies. |

### Detail panel

- `detail` — multi-paragraph description of the step, often pasted
  verbatim into a change ticket.
- `rollback` — when present, a one-paragraph note describing how to
  reverse the step if it fails (e.g. *"Revert the column collation
  with `ALTER COLUMN ... COLLATE <prev>` and rerun the dependent
  ETL."*). Steps without a rollback note are typically idempotent
  (e.g. statistics refresh).

## Common tasks

### "Hand the runbook to a junior engineer"

Print or copy the `runbook.md` file (it is the same content rendered
as Markdown) — the rendered Markdown ships in `output/`. The HTML
report (`fabric_mapping.html`) renders the same data with a TOC.

### "I want to skip a step"

The runbook is advisory, not enforced. Track skip decisions outside
the analyzer (in your migration plan / change ticket). The next run
will re-emit the step if the underlying recommendation still exists.

### "The order seems wrong"

The order is heuristic — the analyzer cannot know your specific
deployment cadence. Treat it as a starting point. The phase
boundaries are usually correct (you genuinely cannot migrate schema
before fixing collation), but cross-phase reordering may make sense
for your release window.

## Empty / error states

- *No runbook generated* — `fabric_mapping.json` has no `runbook[]`
  entries. Either the run was very small (no recommendations → no
  steps), or the aggregator failed. Check the
  [Inputs analyzed](04-dashboard.md#inputs-analyzed) card on the
  Dashboard for module status.

## Related

- [06. Recommendations](06-recommendations.md) — flat triage list
- [08. Delta](08-delta.md) — what changed between two runs
