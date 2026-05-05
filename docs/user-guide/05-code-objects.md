# 05. Code objects

## Purpose

Inspect every stored procedure, view, function and trigger across all
dedicated SQL pools, and drill into the T-SQL surface gaps that block
their move to Fabric Warehouse.

## How to open

- URL: `/code-objects`.
- Modes: both static and control plane.

## Inputs

Single source: `dedicated_pools.json`. The page reads each pool's
`code_objects[]` and joins them to `tsql_surface_gaps[]` via
`code_object_id`.

## Layout

```
Code objects (SQL plane)
128 object(s) across 1 pool(s)

[ Filter ………………………… ] [ All compatibility ▾ ] [ All types ▾ ]   118 match(es)

┌────────────┬─────────────────────────────┬──────┬───────────────┬───────┬────────┬───────────┬─────────┐
│ Pool       │ Object                      │ Type │ Compatibility │ Lines │ Params │ T-SQL gaps│         │
├────────────┼─────────────────────────────┼──────┼───────────────┼───────┼────────┼───────────┼─────────┤
│ testpool01 │ dbo.UpsertCustomer          │ P    │ ● incompatible│  44   │   3    │     2     │ Details │
│ testpool01 │ dbo.RebuildIndexes          │ P    │ ● incompatible│ 112   │   0    │     1     │ Details │
│ testpool01 │ dbo.GetActiveCustomers      │ V    │ ● needs_review│  18   │   0    │     1     │ Details │
│ testpool01 │ dbo.fn_NormalizeEmail       │ FN   │ ○ compatible  │   8   │   1    │     0     │ Details │
└────────────┴─────────────────────────────┴──────┴───────────────┴───────┴────────┴───────────┴─────────┘
```

Clicking **Details** expands an inline panel showing parameter
signatures, the per-rule T-SQL gaps, the offending line ranges, and
metadata (created / modified date, ANSI-NULLS state).

## Field reference

### Toolbar

| Control            | Effect                                          |
| ------------------ | ----------------------------------------------- |
| **Filter** input   | Free-text filter across pool, schema, name, code-object id, type, compatibility. |
| **Compatibility** dropdown | Restrict to `incompatible`, `needs_review` or `compatible`. |
| **Type** dropdown  | Restrict to a specific object type (`P`, `V`, `FN`, `IF`, `TF`, `TR`, …). |

The match counter on the right shows the filtered row count.

### Table columns

| Column         | Field                                | Notes |
| -------------- | ------------------------------------ | ----- |
| **Pool**       | `<pool>.inventory.name`              | The dedicated pool the object belongs to. |
| **Object**     | `<schema>.<object_name>`             | Quoted in `<code>` style. |
| **Type**       | `object_type`                        | `P` = procedure, `V` = view, `FN` = scalar UDF, `IF` = inline TVF, `TF` = multi-statement TVF, `TR` = trigger. |
| **Compatibility** | `compatibility`                   | `compatible` / `needs_review` / `incompatible`. Sort uses the worst-first order `incompatible → needs_review → compatible`. |
| **Lines**      | `line_count`                         | From `sys.sql_modules.definition`. `NULL` when the body is hidden (encrypted / restricted), shown blank. |
| **Params**     | `parameter_count`                    | From `sys.parameters`. |
| **T-SQL gaps** | `gap_count`                          | Count of `tsql_surface_gaps[]` entries linked by `code_object_id`. |

### Detail panel (when expanded)

- **Identity**: `code_object_id` (stable across runs), `object_id`
  (catalog id), schema, name, type, created / modified timestamps.
- **Settings**: `is_ansi_nulls_on`, `is_quoted_identifier_on`,
  `definition_length` (chars).
- **Parameters**: ordered list of `{ name, type, length, is_output }`.
- **T-SQL gaps**: each row shows the rule id (e.g. `tsql.merge`,
  `tsql.cursor`, `tsql.global_temp`, `tsql.three_part_name`),
  severity, and the line range in the procedure where it was detected.

## Common tasks

### "Show me every blocker T-SQL gap from a specific schema"

1. Compatibility = **Incompatible**.
2. Filter = `dbo` (or your schema).
3. Sort by **T-SQL gaps** descending.

The top of the list is your remediation queue.

### "Are any procedures missing a body?"

Filter for **Lines = empty**. If you see any rows here that should
have a body (i.e. you know the proc has code), the analyzer's principal
is missing **VIEW DEFINITION** on the pool. See the troubleshooting
note in [13. Troubleshooting](13-troubleshooting.md).

### "Find every object that uses MERGE"

Filter free-text = `merge`. The text search matches the rule ids in
the gap list, so any object whose details contain a `tsql.merge` gap
will surface.

### "Was an object compatible last run?"

Switch the [run picker](03-run-picker.md) to the previous run id and
look up the same object — the `code_object_id` is stable, so it survives
across runs. The [Diff page](11-diff-page.md) gives a structural diff
of the same set.

## Empty / error states

- *No code objects collected. Run the dedicated_pools module.* —
  `dedicated_pools.json` is missing or has no `code_objects[]`. The
  most common reason in 1.2.x and earlier was the views-only join bug
  (fixed) — if you see this on 2.0.0, the principal lacks
  **VIEW DEFINITION**.
- Empty filter result — sub-text just shows `0 match(es)`. Clear the
  filter to recover.

## Related

- [06. Recommendations](06-recommendations.md) — see what each gap means for migration
- [07. Runbook](07-runbook.md) — sequenced remediation
- [13. Troubleshooting](13-troubleshooting.md) — VIEW DEFINITION grant
