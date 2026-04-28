# Synapse Migration Analyzer

Python tooling that inventories and analyzes **Azure Synapse Analytics** workspaces to assess readiness for migration to **Microsoft Fabric Warehouse**.

> Modules:
> - `dedicated_pools` — dedicated SQL pool inventory, schema/table/index/usage/security/workload-management, T-SQL code-object capture, column-level collation audit, materialized-view inventory, statistics-freshness report, column stats, distribution-key advisor (skew + filter-selectivity heuristics), and a per-object "T-SQL surface gaps" rollup with stable code-object ids
> - `serverless_pools` — built-in serverless SQL pool, databases, external data sources & external tables, top queries, daily data-scanned, cost estimate
> - `spark_pools` — Apache Spark pool inventory & configuration, plus notebook and Spark-job-definition inventory
> - `pipelines` — pipelines, linked services, datasets, triggers, integration runtimes, with activity-level Fabric-compatibility classification
> - `monitoring` — historical Azure Monitor metrics for dedicated SQL pools (DWU, queries, connections)
> - `storage` — ADLS / Storage account inventory (workspace-default Gen2 flagged), Azure Monitor capacity metrics (UsedCapacity, BlobCapacity), and dedicated SQL pool size in MB / GB
> - `fabric_mapping` — aggregates the above and produces Fabric Warehouse migration recommendations (collation, T-SQL surface, activity gaps, sizing hints)

📘 **New here?** See the module-based [QUICKSTART.md](QUICKSTART.md).

## Architecture

```
src/synapse_migration_analyzer/
├── cli.py                       # `sma` CLI (Click)
├── config.py                    # .env / env-var loader
├── auth.py                      # azure-identity ClientSecretCredential + SQL access tokens
├── modules/
│   ├── dedicated_pools/         # ARM + DMV-driven analysis
│   ├── serverless_pools/        # ARM + serverless DMVs
│   ├── spark_pools/             # ARM (big_data_pools) + Synapse Artifacts (notebooks, SJDs)
│   ├── pipelines/               # azure-synapse-artifacts SDK + Fabric-compat classifier
│   ├── monitoring/              # azure-mgmt-monitor — dedicated-pool metrics
│   ├── storage/                 # azure-mgmt-storage + Azure Monitor capacity + DMV pool sizing
│   └── fabric_mapping/          # aggregator + heuristic rules (incl. T-SQL surface scan)
└── reporting/                   # shared writers (JSON/CSV/Markdown), shared HTML CSS/JS,
                                  #   and the top-level index.html aggregator
```

Each module exposes:
- `analyzer.py` with a class providing `.run() -> <ModulePydanticModel>`
- `models.py` with Pydantic v2 models
- `reporting.py` writing JSON / CSV / Markdown, plus a per-module `html_report.py`
- `arm_client.py` / `sql_client.py` / `artifacts_client.py` as appropriate
- `collectors[.py|/]` and (for SQL-backed modules) `queries/*.sql`

A new CLI subcommand is registered in [cli.py](src/synapse_migration_analyzer/cli.py).

## Prerequisites

- Python **3.12+**
- **Microsoft ODBC Driver 18 for SQL Server** installed on the host machine (required by `pyodbc`).
  - Windows: <https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server>
- A **service principal** with:
  - `Reader` on the Synapse workspace (control plane).
  - **Synapse Artifact User** on the workspace for `analyze-pipelines` and `analyze-spark-pools` (notebooks / SJDs).
  - **Monitoring Reader** at the subscription / resource-group scope for `analyze-monitoring` and `analyze-storage` (capacity metrics).
  - For `analyze-storage`: `Reader` on each storage account (or on the subscription / RG that contains it). The workspace's default ADLS Gen2 is auto-detected.
  - **Synapse SQL access** to each dedicated pool (granted via `CREATE USER [<sp>] FROM EXTERNAL PROVIDER` in the pool, plus role memberships such as `db_datareader` and access to DMVs / `VIEW DATABASE STATE`).

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"

Copy-Item .env.example .env
# edit .env with tenant/client/secret/subscription/workspace
```

## Run

```powershell
sma doctor                                        # consolidated host + auth pre-flight
sma doctor --offline                              # skip live Azure calls

sma analyze-dedicated-pools                       # all formats
sma analyze-serverless-pools
sma analyze-spark-pools
sma analyze-pipelines
sma analyze-monitoring                            # Azure Monitor metrics for dedicated pools
sma analyze-storage                               # ADLS inventory + capacity + dedicated-pool size
sma map-to-fabric                                 # aggregates prior outputs

sma analyze-all                                   # runs everything end-to-end (7 steps)
sma analyze-all --skip monitoring --skip storage  # opt out of selected modules
sma -v analyze-dedicated-pools                    # verbose
```

Outputs land in `./output/` (override via `SMA_OUTPUT_DIR`). Every analyzer emits JSON, CSV,
Markdown and HTML. After `analyze-all` (or via `sma index`) a top-level `index.html` is
(re)generated, linking to whichever module reports exist. See each module section in
[QUICKSTART.md](QUICKSTART.md) for the file list.

## Tests

```powershell
pytest -q          # ~92 unit tests, no Azure access required
sma doctor         # host + auth pre-flight (uses .env when present)
```

## What the dedicated_pools module captures

| Area | Source | File |
|---|---|---|
| Pool inventory, SKU, DWU, status, collation, max size | ARM (`azure-mgmt-synapse`) | `arm_client.py` |
| Schemas + object counts | `sys.schemas` / `sys.objects` | `queries/schemas.sql` |
| Tables: distribution, partitioning, row counts, storage MB, index type | `sys.pdw_*`, `sys.dm_pdw_nodes_db_partition_stats` | `queries/tables.sql` |
| Indexes (incl. CCI/heap) | `sys.indexes` | `queries/indexes.sql` |
| Usage snapshot (active/completed/failed requests, durations, sessions) | `sys.dm_pdw_exec_*` | `queries/usage.sql` |
| Database principals & role memberships | `sys.database_principals`, `sys.database_role_members` | `queries/security.sql` |
| Workload groups & classifier counts | `sys.workload_management_*` | `queries/workload.sql` |
| Code objects (procs / views / functions) with stable id | `sys.sql_modules` | `queries/code_objects.sql` |
| **v2** Column collation audit (per-column vs DB default) | `sys.columns` + `sys.databases` | `queries/column_collation.sql` |
| **v2** Materialized-view inventory | `sys.views` + `sys.indexes` | `queries/materialized_views.sql` |
| **v2** Statistics freshness (last_updated, modification_counter) | `sys.stats` + `sys.dm_db_stats_properties` | `queries/statistics_freshness.sql` |
| **v2** Column-level row/distinct/null/skew stats | `sys.dm_pdw_nodes_db_partition_stats` (+ derived) | `queries/column_stats.sql` |
| **v2** Distribution-key candidates (skew + filter-selectivity scoring) | pure Python over the above + code objects | `distribution_advisor.py` + `query_pattern_extractor.py` |
| **v2** T-SQL surface gap rollup linked to stable `code_object_id` | pure Python over `code_objects` | `tsql_surface_gap.py` |

Paused pools are detected via control-plane `status` and DMV collection is skipped (recorded in `errors`).

## Roadmap

The seven core modules (`dedicated_pools`, `serverless_pools`, `spark_pools`, `pipelines`,
`monitoring`, `storage`, `fabric_mapping`) are implemented end-to-end with reporting, a Fabric-mapping
aggregator, a Click-based CLI, and a `sma doctor` self-test. The roadmap below is grouped
by horizon. Items are ordered roughly by user value within each band; nothing here is
committed work.

### Near-term (next minor releases)

Polish and depth on what already exists.

> **Status (v2 scaffolding shipped):** all bullets in this section now have a working
> Python skeleton in the codebase. SDK-bound bits (live DMVs / Log Analytics / Livy job
> history) are wired with try/except so older Synapse versions don't fail the run; pure-
> Python heuristics (distribution advisor, notebook lint, expression compat, schedule
> mapper, DWU-hours derivation, readiness score, runbook builder, capacity projection,
> storage-account cost attribution) are fully implemented and unit-tested.

- **`dedicated_pools` v2** — column-level collation audit, distribution-key candidate
  suggestions (skew + filter selectivity heuristics), materialized-view inventory,
  statistics freshness report, and a "T-SQL surface gaps" rollup that links each finding
  back to the offending object via a stable code-object id.
- **`serverless_pools` v2** — capture `OPENROWSET` / external-table column projections,
  per-database query history with **partition-pruning** analysis, and per-storage-account
  cost attribution for the 30-day data-scanned figure.
- **`spark_pools` v2** — library / package inventory (custom + workspace-level), recent
  Livy job-run history, runtime-version compatibility check against Fabric Spark, and a
  notebook lint pass (Synapse-only magics, `spark.synapse.*` configs).
- **`pipelines` v2** — per-activity parameter-binding analysis, expression-language
  compatibility checks (`@pipeline()`, `@activity()`, system variables), and trigger-time
  schedule mapping to Fabric Data Factory pipeline schedules.
- **`monitoring` v2** — Log Analytics / KQL queries (long-running queries, top users,
  failed logins, blocked sessions) over 30/60/90-day windows, plus a derived "active DWU
  hours per day" series for sizing.
- **`fabric_mapping` v2** — auto-generated **migration runbook** (sequenced, dependency-aware
  steps with rollback notes), Fabric **capacity (CU) cost projection** sourced from
  monitoring metrics + workload mix, and a per-pool readiness score (0-100) with the
  five biggest blockers called out.
- **CLI / DX** — `sma analyze-all --skip <module>`, structured JSON-lines logs behind
  `--log-format json`, deterministic exit codes per failure class, and a `--since` flag
  on monitoring to override the default window.

### Mid-term

New modules and integrations once the core depth is in place.

- **`governance` module** — workspace- and resource-level RBAC export (control plane +
  data plane), managed-private-endpoint inventory, customer-managed-key configuration,
  and **Microsoft Purview** lineage capture for the analyzed workspace.
- **`security` module** — firewall rules, AAD-only enforcement, TLS minimum version,
  encryption-at-rest configuration, and a per-pool secrets/credentials inventory
  (linked-service credential types only, never values).
- **`cost` module** — month-over-month consumption pull from
  Microsoft.Consumption / Cost Management for the workspace's resource group, broken down
  by SKU and pool, paired with the `fabric_mapping` CU projection for a side-by-side TCO
  delta.
- **Fabric-side validation** — optional post-migration runner that connects to a target
  Fabric Warehouse / Lakehouse and verifies object counts, row counts, collation, and a
  sample of T-SQL surface findings actually resolved.
- **Incremental / delta runs** — persist a run manifest (hash + timestamp per collector)
  so subsequent `analyze-all` invocations can skip unchanged objects and produce a diff
  report against the prior run.

### Long-term / exploratory

Ideas that need design work or external dependencies.

- **Code conversion assist** — automated rewrite hints for the T-SQL surface gaps
  detected today (surrogate keys via `IDENTITY` → Fabric pattern, `MERGE` simplifications,
  unsupported hints, etc.). Suggestions only — never silent rewrites of customer code.
- **Notebook conversion assist** — rewrite hints for the most common Synapse-Spark-only
  patterns (`mssparkutils` → `notebookutils`, linked-service mounts, runtime-specific APIs).
- **GitHub Action / Azure DevOps task** — packaged invocation of `analyze-all` with
  artifact upload and a PR-comment summary of the readiness score delta.
- **Workspace-of-workspaces** — point at a subscription and fan out across every Synapse
  workspace, producing a portfolio-level rollup.
- **Public extension points** — documented hooks so customers / partners can register
  their own collectors and Fabric-mapping rules without forking.

### Non-goals

- **Performing the migration itself.** This tool inventories and assesses; data movement
  and DDL/DML translation remain out of scope.
- **Modifying the source workspace.** All Azure access is read-only by design (Reader,
  Monitoring Reader, Synapse Artifact User, plus `db_datareader` + `VIEW DATABASE STATE`
  on dedicated pools).
- **A GUI.** The CLI + generated HTML / Markdown / CSV / JSON reports are the surface;
  any UI work would live in a separate project.

Have a request or want to contribute? Open an issue on the
[GitHub repository](https://github.com/anbergst_microsoft/SynapseMigrationAnalyzer/issues)
with the module name and a concrete scenario. See [CONTRIBUTING.md](CONTRIBUTING.md) for
the contribution workflow, [DEPENDENCIES.md](DEPENDENCIES.md) for the third-party
dependency inventory, and [SECURITY.md](SECURITY.md) for vulnerability reports.

## License

This project is licensed under the [MIT License](LICENSE).

## Trademarks

"Azure", "Azure Synapse Analytics", "Microsoft Fabric" and related product names are
trademarks of Microsoft Corporation. This project is an independent, community-driven
tool and is **not affiliated with, endorsed by, or sponsored by Microsoft**. The MIT
license covers only the source code in this repository; it does not grant any rights
to use Microsoft trademarks.

