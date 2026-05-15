# 04. Dashboard

## Purpose

The single screen that answers "how migration-ready is this Synapse
workspace, today?" If you only have time for one page, it is this one.

## How to open

- URL: `/` (the home route).
- Modes: both static and control plane.

## Inputs

| Section          | JSON file              | Module          |
| ---------------- | ---------------------- | --------------- |
| Headline / blockers / inputs | `fabric_mapping.json` | `fabric_mapping` |
| DWU utilization  | `monitoring.json`      | `monitoring`    |
| Storage          | `storage.json`         | `storage`       |
| Pipeline activity | `pipelines.json`      | `pipelines`     |
| Serverless SQL   | `serverless_pools.json` | `serverless_pools` |

The DWU utilization, Storage, Pipeline-activity and Serverless SQL
sections render only when their respective JSON files exist for the
selected run. The headline cards require `fabric_mapping.json` —
without it the page shows *Loading…* forever.

## Layout

```
Synapse Migration Analyzer — Dashboard
─────────────────────────────────────────────────────────────────────────
[ Readiness    ] [ T-SQL surface ] [ Recommendations ] [ SKU advisory ]
   84 / 100         128 findings        22 (3 blocker)     match (DW400c)
─────────────────────────────────────────────────────────────────────────
Top blockers
┌─────┬───────────────────────────────────────────┬─────────────────────┐
│ Sev │ Title                                     │ Target              │
├─────┼───────────────────────────────────────────┼─────────────────────┤
│ ●   │ MERGE statement used in stored procedure  │ dbo.UpsertCustomer  │
│ ●   │ CURSOR used in stored procedure           │ dbo.RebuildIndexes  │
│ ●   │ Column collation mismatch                 │ dbo.Customer.Notes  │
└─────┴───────────────────────────────────────────┴─────────────────────┘
Storage                                                  (only if storage.json)
[ Pool data 6.3 GB ] [ Pool indexes 1.2 GB ] [ ADLS used 84 GB ] [ Accounts 2 ]
┌────────────┬───────┬──────────┬─────────┬─────────┬──────────┬─────────┐
│ Pool       │ Tabls │ Rows     │ Data    │ Indexes │ Reserved │ % max   │
├────────────┼───────┼──────────┼─────────┼─────────┼──────────┼─────────┤
│ testpool01 │   6   │ 9.4M     │ 6.28 GB │ 1.18 GB │ 8.45 GB  │ 12.34 % │
└────────────┴───────┴──────────┴─────────┴─────────┴──────────┴─────────┘
Pipeline activity (last 7 days)            (only if pipelines.json + run_history)
[ Daily runs 4.3 ] [ Success 96 % ] [ Daily moved 412 MB ] [ Window 28-Apr→5-May ]
┌──────────────────────┬─────────┬─────────┬──────────┬───────────┬──────────┬─────────────────┐
│ Pipeline             │ Run/day │ Success │ Failed   │ Mvd / run │ Total Mb │ Last run        │
├──────────────────────┼─────────┼─────────┼──────────┼───────────┼──────────┼─────────────────┤
│ pl_load_customers    │  1.43   │   10    │    0     │ 384 MB    │ 2.6 GB   │ 5 May 09:14 ●   │
└──────────────────────┴─────────┴─────────┴──────────┴───────────┴──────────┴─────────────────┘
Inputs analyzed
┌──────────────┬──────────────────────────┬──────────────────────────────┐
│ Module       │ Source                   │ Counts                       │
├──────────────┼──────────────────────────┼──────────────────────────────┤
│ dedicated_p… │ output/dedicated_pools.j │ pools=1, code_objects=128, … │
└──────────────┴──────────────────────────┴──────────────────────────────┘
```

## Field reference

### Headline stat cards

| Card               | Field                                  | Notes |
| ------------------ | -------------------------------------- | ----- |
| **Readiness**      | `summary.readiness_score`              | 0–100, `>=80` is green, `>=50` amber, otherwise red. |
| **T-SQL surface**  | `summary.tsql_surface_findings`        | Sub-text shows `tsql_compatibility_pct` from 1.2.1+. |
| **Recommendations** | `recommendations.length` + blocker count | Sub-text breaks down by severity. |
| **SKU advisory**   | `summary.sku_advice`                   | One of `match`, `downsize`, `upsize`. |

### Top blockers

Filtered subset of `recommendations[]` with `severity = "blocker"`,
sorted by area then id, capped at the top 5.

### DWU utilization section

Reads `monitoring.json`. Renders only when one or more dedicated SQL
pools returned `DWUUsedPercent` series from Azure Monitor (or
`DWUUsed` + `DWULimit`, from which the percent is synthesised).

| Stat card          | Source                                              |
| ------------------ | --------------------------------------------------- |
| **Peak DWU %**     | `max(DWUUsedPercent.points[*].value)` across pools  |
| **P95 DWU %**      | 95th percentile of every `DWUUsedPercent` sample    |
| **Active hours**   | `Σ dwu_days[*].active_hours` (pool-hours with DWU > 0) |
| **Pools observed** | distinct `resource_name`s in the DWU series         |

The inline-SVG line chart plots one polyline per pool over the full
monitoring window (`window_start → window_end`, sampled at `interval`,
default 7 days @ `PT1H`). A dashed red line marks 100 % — anything
touching it for sustained periods is a sign the pool is undersized.
The Y axis auto-scales above 100 % when bursts exceed the limit.
Nulls in the series render as gaps (not zeros).

Per-pool table columns: pool name, DWU limit (e.g. `DW400c`), peak
DWU (absolute), peak %, p95 %, avg %, active hours. The Peak % and
P95 % pills use **inverted** severity colours vs. the rest of the SPA
(red ≥ 90 %, amber ≥ 70 %, green otherwise) because high DWU usage
means the pool is saturated, not healthy.

If this section is missing despite running `sma analyze-monitoring`:
the pool may have been paused for the entire window, or the calling
identity lacks **Monitoring Reader** on the subscription / RG (see
the collection-errors banner in `monitoring.html` for the underlying
Azure Monitor error).

### Storage section

| Stat card                | Source                                                 |
| ------------------------ | ------------------------------------------------------ |
| **Dedicated pool data**  | `Σ dedicated_pool_storage[*].data_space_gb`            |
| **Dedicated pool indexes** | `Σ dedicated_pool_storage[*].index_space_gb`         |
| **ADLS used**            | `Σ capacities[*].used_capacity_gb`                     |
| **Storage accounts**     | `accounts.length`; sub-text shows the workspace default |

Per-pool table columns: `pool_name`, `table_count`, `row_count`,
`data_space_gb`, `index_space_gb`, `reserved_space_gb`, `used_pct_of_max`.

### Pipeline activity section

| Stat card                | Source                                                 |
| ------------------------ | ------------------------------------------------------ |
| **Daily pipeline runs**  | `Σ window7d.run_count / 7`                             |
| **Success rate**         | `Σ succeeded / (Σ succeeded + Σ failed)`               |
| **Daily data movement**  | `Σ window7d.total_data_moved_mb / 7`                   |
| **Window**               | `run_history.window_start → window_end`                |

Top-10 table columns: pipeline name, runs/day (`run_count / 7`),
succeeded count, failed count, average data moved per run, total data
moved in the window, and a last-run timestamp + status pill.

### Serverless SQL section

Reads `serverless_pools.json`. When `daily_usage` is non-empty:

| Stat card                  | Source                                                 |
| -------------------------- | ------------------------------------------------------ |
| **Avg daily queries**      | `Σ daily_usage[*].request_count / N` (N = days observed) |
| **Total data scanned**     | `Σ daily_usage[*].data_processed_mb`                  |
| **Avg query data size**    | `total_data_scanned / total_requests`                  |
| **Estimated cost**         | `cost_estimate.estimated_cost_usd` (sub-text shows TB scanned and the list price per TB) |

Below the cards an inline-SVG **clustered bar chart** plots the last 7
days — one bar per day for queries (left axis, blue) and one for MB
scanned (right axis, orange). Hover a bar for the exact daily value.

When `daily_usage` is empty, the section instead shows database and
external-table counts plus a hint: `sys.dm_exec_requests_history` only
returns queries submitted by the calling principal unless the SP holds
`VIEW SERVER STATE` (or is a Synapse SQL admin). Grant that permission
and re-run `sma analyze-serverless-pools` to populate the chart.

### Inputs analyzed

Lists every module that contributed to the aggregation, the source
JSON path it was read from, and a comma-separated count breakdown
(e.g. `pools=1`, `pipelines=8`, `findings=12`). Useful sanity check
when something is missing.

## Common tasks

### "Where is my readiness score going?"

Watch the headline **Readiness** card across runs. The
[Diff page](11-diff-page.md) shows the score delta numerically; this
page shows the absolute value plus *what the blockers actually are*
right now.

### "Which one pipeline is moving the most data?"

Sort the Pipeline activity table by **Total Mb** (click the column
header). The top row is your highest data-mover. Pair it with the
**Failed** column — anything moving multi-GB *and* failing is your
priority.

### "Is the dedicated pool nearly full?"

Read the **% max** column in the per-pool storage table. Anything
above 70 % is worth raising in your runbook before migration; the
analyzer also surfaces a recommendation for it (see
[06. Recommendations](06-recommendations.md)).

## Empty / error states

- *Loading…* — `fabric_mapping.json` is being fetched.
- *No fabric_mapping data* — file is missing. Run
  `sma analyze-all` or `sma map-to-fabric`.
- The Storage / Pipeline-activity / Serverless SQL sections silently
  disappear when their JSON is absent or the corresponding arrays are
  empty (Serverless SQL only hides when there are no databases, no
  external tables **and** no `daily_usage` rows — a partially-populated
  report still renders the inventory tiles plus the permissions hint).

## Related

- [05. Code objects](05-code-objects.md) — drill into the T-SQL surface number
- [06. Recommendations](06-recommendations.md) — full triage table
- [07. Runbook](07-runbook.md) — sequence of remediation steps
