# 06. Recommendations

## Purpose

The full triage list. Every finding emitted by `fabric_mapping`'s
rules engine, sortable and filterable in one table.

## How to open

- URL: `/recommendations`.
- Modes: both static and control plane.

## Inputs

`fabric_mapping.json` — specifically the `recommendations[]` array.
Each entry has a stable `id`, severity, area, target, title, detail,
effort estimate, and a Fabric-side action hint.

## Layout

```
Recommendations

[ Filter (id, title, detail, target) ……………… ] [ All severities ▾ ] [ All areas ▾ ]   34 / 47

┌──────────┬────────┬────────────────┬─────────────────────────────┬────────────────────────────────┬──────────────────────────────┐
│ Severity │ Effort │ Area           │ Target                      │ Title                          │ Fabric action                │
├──────────┼────────┼────────────────┼─────────────────────────────┼────────────────────────────────┼──────────────────────────────┤
│ ●        │ M      │ tsql.surface   │ dbo.UpsertCustomer          │ MERGE statement used        ▾ │ Rewrite as INSERT/UPDATE     │
│ ●        │ S      │ collation      │ dbo.Customer.Notes          │ Column collation mismatch   ▾ │ ALTER COLUMN to UTF-8        │
│ ◐        │ M      │ pl.runs.idle   │ pl_archive_legacy           │ Pipeline has no runs        ▾ │ Decommission or schedule     │
│ ○        │ XS     │ sizing         │ dwpool01                    │ Downsize candidate (DWU p95)▾ │ Match with Fabric F128       │
└──────────┴────────┴────────────────┴─────────────────────────────┴────────────────────────────────┴──────────────────────────────┘
```

Click the title to expand the inline `<details>` element with the full
description.

## Field reference

### Toolbar

| Control                | Effect |
| ---------------------- | ------ |
| **Filter** input       | Free-text across `id`, `title`, `detail`, `area`, `target`, `fabric_action`. |
| **Severity** dropdown  | `blocker`, `warning`, `info`. |
| **Area** dropdown      | Auto-populated from the data. Common areas: `tsql.surface`, `collation`, `materialized_view`, `statistics`, `distribution`, `sizing`, `pl.activity`, `pl.linked_service`, `pl.runs.idle`, `pl.runs.low_success`, `pl.runs.heavy_data_movement`, `monitoring`, `storage`, `governance`, `security`, `cost`. |

The counter on the right shows `<filtered> / <total>`.

### Table columns

| Column          | Field           | Notes |
| --------------- | --------------- | ----- |
| **Severity**    | `severity`      | Pill: ● blocker (red), ◐ warning (amber), ○ info (green). Sort order in the underlying list is always blocker → warning → info, then by area. |
| **Effort**      | `effort`        | T-shirt size: `XS`, `S`, `M`, `L`, `XL`. Heuristic estimate from the rule. |
| **Area**        | `area`          | Stable rule-family id (e.g. `tsql.surface`). Useful for grouping. |
| **Target**      | `target`        | Free-form identifier the rule applies to — pool name, schema-qualified object, pipeline name, storage account, etc. |
| **Title**       | `title`         | One-line summary; click to expand the full `detail`. |
| **Fabric action** | `fabric_action` | Concrete remediation hint for Fabric Warehouse. |

### Severity pill semantics

| Pill     | Meaning |
| -------- | ------- |
| ● blocker | The migration cannot proceed without addressing this. (Examples: column collation mismatch, MERGE in a procedure, unsupported pipeline activity.) |
| ◐ warning | The migration will succeed but with degraded behaviour. (Examples: stale statistics, low-success pipeline, idle pipeline.) |
| ○ info   | Notable but not blocking — sizing hints, governance observations, cost concentration. |

## Common tasks

### "Build a sprint of all blockers under T-SQL surface"

Severity = **Blocker**, Area = **tsql.surface**. The visible rows are
your sprint. Pair them with [05. Code objects](05-code-objects.md) for
the line ranges.

### "What pipelines need attention?"

Filter free-text = `pl.`. Three families show up: `pl.activity` (the
activity is unsupported in Fabric), `pl.linked_service` (connector
unsupported), `pl.runs.*` (run-history-driven warnings).

### "Anything new since last run?"

The Recommendations page does not show a per-row delta — use the
[Diff page](11-diff-page.md) for that. The summary tells you how many
recommendations were added / removed; this page shows what they are.

### "Pull the data into a spreadsheet"

The same data is in `output/recommendations.csv` (CSV) and
`output/fabric_mapping.json` (`recommendations[]`). Open the CSV in
Excel for offline triage.

## Empty / error states

- *No recommendations to show* — the rules engine produced zero
  findings. Either the workspace is genuinely clean, or
  `fabric_mapping.json` is empty / missing.
- Filter yields no rows — sub-text shows `0 / N`.

## Related

- [04. Dashboard](04-dashboard.md) — top-blockers card
- [05. Code objects](05-code-objects.md) — the source for `tsql.surface`
- [07. Runbook](07-runbook.md) — recommendations sequenced as steps
