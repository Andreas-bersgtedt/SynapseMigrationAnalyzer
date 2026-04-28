# Changelog

All notable changes to **Synapse Migration Analyzer** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-04-29

### Summary
- **Mid-term modules promoted to production.** `governance`, `security`, `cost`,
  and **incremental / delta runs** all graduate from v0 scaffolding to v1 with
  full rules engines, severity-tagged findings, per-module HTML reports, and
  documented data-source / RBAC requirements. They remain opt-in via
  `analyze-all --include <module>` (or the dedicated `sma analyze-<module>`
  subcommand) but are now considered first-class capabilities alongside the
  seven core modules.
- **Cost module data-source dependency documented.** Required role:
  **Cost Management Reader** at subscription or workspace-RG scope. Required
  optional Python extra: `pip install -e ".[cost]"` (pulls in
  `azure-mgmt-costmanagement>=4.0`). When either is missing, the analyzer
  still runs and surfaces specific status findings
  (`cost.sdk_missing` / `cost.collection_error` / `cost.live_disabled`)
  instead of silently emitting empty data. New env vars: `SMA_COST_MONTHS`,
  `SMA_COST_DISABLE_LIVE`.
- **Fabric-side validation moved to long-term roadmap.** The post-migration
  Fabric-warehouse runner is no longer tracked under mid-term — it requires
  Fabric-side connectivity / permissions design that's outside the scope of
  this release.

### Added
- **Incremental / delta runs v1.** Promoted from v0 scaffolding. `analyze-all`
  now auto-emits `run_manifest.json`, `run_delta.md`, **`run_delta.html`**, and
  **`run_delta.json`** (machine-readable). Each artifact entry now includes a
  top-level `record_count` peek (findings / rows / pools / role_assignments /
  pipelines / notebooks / spark_jobs / external_tables / firewall_rules /
  credentials) so the delta surfaces +N findings or -N rows alongside the
  SHA / size changes. New `peek_record_count` helper, new `diff_summary`
  returning `{added, removed, changed, unchanged, total}`, sorted HTML
  artifacts table (changed → added → removed → unchanged → name) with a
  5-stat grid, and an `index.html` linkout for the new `run_delta` card.
  `sma run-delta` emits all four files; failures during manifest / delta
  emission remain non-fatal (warning + `partial_failure`).
- **`cost` module v1.** Promoted from v0 scaffolding with a pure-Python rules
  engine, per-resource aggregation, and a per-module HTML report. New finding
  ids: `cost.no_data` (info, when Cost Management returned no rows),
  `cost.fabric.savings` (info, when the Fabric SKU estimate is ≥10% cheaper
  than the Synapse average), `cost.fabric.increase` (medium, when Fabric is
  ≥10% more expensive — points at CU sizing / reservation pricing),
  `cost.concentration.dedicated_pool` and `cost.concentration.spark_pool`
  (info, when one resource kind exceeds 70% of total spend), and
  `cost.month_over_month.spike` (medium, when a month rises ≥25% over the
  prior). New `by_resource_name` aggregation and CSV (`cost_by_resource_kind.csv`,
  `cost_findings.csv`). Markdown gains a Findings section; HTML report
  contains a 6-stat grid (rows, months, kinds, findings, Synapse avg/mo,
  Fabric SKU), severity-sorted findings table, monthly-totals table with
  ±25% MoM pills, by-kind / by-resource breakdowns, and a Fabric comparison
  card. `sma analyze-cost` and `analyze-all --include cost` emit HTML.
- **`governance` module v1.** Promoted from v0 scaffolding to a fully-built
  module with a pure-Python rules engine, severity-tagged findings, role-name
  resolution against `Microsoft.Authorization/roleDefinitions`, and a per-module
  HTML report. New finding ids: `gov.rbac.subscription_privileged` (high),
  `gov.rbac.workspace_privileged` (medium), `gov.mpe.not_approved` and
  `gov.mpe.provisioning_failed` (medium), `gov.cmk.not_configured` (info),
  `gov.cmk.disabled` (medium), `gov.purview.not_configured` (info). Privileged
  built-in roles are detected by name (Owner, Contributor, User Access
  Administrator, Role Based Access Control Administrator). RBAC assignments
  are deduplicated across scopes by assignment id. `sma analyze-governance`
  now emits HTML alongside JSON / CSV / Markdown, and `analyze-all --include
  governance` picks up the HTML automatically.
- **`security` module v1.** Promoted from v0 scaffolding with three new live
  collectors: per-pool **Transparent Data Encryption** state
  (`sql_pool_transparent_data_encryptions.get`), workspace **AAD/SQL
  administrators**, and **linked-service payloads** pulled directly from the
  Synapse Artifacts plane (so credential classification no longer piggy-backs
  on `pipelines.json`). New finding ids: `sec.workspace.no_aad_admin` (high),
  `sec.workspace.encryption_platform_managed` (info),
  `sec.workspace.no_managed_vnet` (medium, only when public network access is
  enabled), `sec.pool.tde_disabled` (high, per dedicated pool), and
  `sec.credentials.inline_secret` (high) when `password` / `accountKey` /
  `secret` / `sasToken` literals or nested `{"type": "SecureString"}` payloads
  appear in a linked-service definition (Key Vault references are still
  treated as safe). New per-module HTML report (severity-sorted findings,
  workspace-settings card, firewall table, pool-TDE table, credential
  rollup with inline-secret column). Markdown gains AAD-admin and pool-TDE
  sections; CSV gains `security_pool_tde.csv`. `sma analyze-security` and
  `analyze-all --include security` emit HTML.
- 32 new unit tests (173 total, up from 141) covering the governance rules
  engine + role-name caching, the security TDE / AAD / managed-VNet /
  encryption / inline-secret rules, inline-secret detection (literal vs.
  `SecureString` vs. `AzureKeyVaultSecret` reference), the cost rules
  (Fabric savings / increase / no-data / concentration / month-over-month
  spike) + by-resource aggregation, and HTML round-trips for all three
  modules.

## [1.1.0] - 2026-04-28

### Added
- **Mid-term roadmap scaffolding (v0).** Five new opt-in capabilities, all
  fail-soft and gated behind explicit CLI flags / `analyze-all --include`:
  - `governance` module — workspace + resource-level RBAC, managed private
    endpoints, customer-managed keys, and Microsoft Purview lineage capture.
  - `security` module — firewall rules, AAD-only / TLS / public-network
    settings, and a linked-service credential inventory (types only, never
    secret values), plus a pure-Python rules engine producing severity-tagged
    findings (`sec.firewall.allow_all`, `sec.workspace.tls_below_12`, …).
  - `cost` module — month-over-month consumption pull from Microsoft Cost
    Management aggregated by resource kind, paired with the `fabric_mapping`
    capacity projection for a side-by-side TCO delta vs. Fabric SKU pricing.
  - `fabric_validation` module — optional post-migration runner that connects
    to a target Fabric Warehouse and diffs object counts, row counts,
    collation, and T-SQL surface-gap resolution against the prior
    `dedicated_pools.json`.
  - **Incremental / delta runs** — `analyze-all` now writes a
    `run_manifest.json` (SHA-256 per artifact + version + workspace metadata)
    and a `run_delta.md` comparing against the previous manifest. New
    `sma run-delta` subcommand can be invoked standalone.
- New CLI subcommands: `sma analyze-governance`, `sma analyze-security`,
  `sma analyze-cost` (with `--months N`), `sma validate-fabric`,
  `sma run-delta`. Mid-term modules are opt-in via
  `sma analyze-all --include governance --include security …`.
- 32 new unit tests (141 total) covering rules, scope/resource classification,
  diff helpers, manifest hashing, and Fabric TCO comparison math.

## [1.0.1] - 2026-04-28

### Added
- **Pipeline run-history statistics** in the `pipelines` module. Each pipeline
  now reports rolling 7 / 14 / 28 / 90-day windows with execution counts,
  success / failure counts, success rate, average duration, and p95 duration.
- **Per-run data-movement metrics**. For pipelines that statically contain a
  `Copy`, `ExecuteDataFlow`, or `Lookup` activity, the analyzer fetches activity
  runs and surfaces `avg_data_moved_mb_per_run` and `total_data_moved_mb` per
  window — derived from `dataRead` / `dataWritten` (Copy) and
  `runStatus.metrics[*].bytes` (Dataflow).
- New CSV outputs:
  - `pipeline_run_stats.csv` — one row per `(pipeline, window)`
  - `pipeline_run_summary.csv` — one row per pipeline using the 28-day window as
    the headline
- New section in the pipelines HTML report (TOC entry **Runtime statistics**,
  headline tiles, success-rate pills color-coded ≥99% / 95–99% / <95%) and an
  equivalent table in the markdown report.
- New CLI flags on `sma analyze-pipelines`:
  - `--since <N>d` — narrows the run-history window for the current run
  - `--no-run-history` — skips the run-history fetch entirely
- New environment variables to tune run-history collection:
  - `SMA_PIPELINES_RUN_HISTORY` (default `1`)
  - `SMA_PIPELINES_RUN_DAYS` (default `90`)
  - `SMA_PIPELINES_RUN_LIMIT` (default `5000`; sets `truncated=true` when hit)
  - `SMA_PIPELINES_ACTIVITY_RUNS` (default `1`)
- New `fabric_mapping` recommendations driven by run history:
  - `pl.runs.idle` — pipelines with no runs in the observed window
  - `pl.runs.low_success.<pipeline>` — pipelines below 95% success in the 28-day
    window (with at least 5 terminal runs)
  - `pl.runs.heavy_data_movement` — pipelines averaging ≥ 1 GB / run
- `DEPENDENCIES.md` — third-party dependency inventory, linked from `README.md`.
- 17 new unit tests across `tests/test_pipelines_run_stats.py` and
  `tests/test_pipelines_run_history_rules.py` (109 tests total, up from 92).

### Changed
- `pipelines.json` schema now includes a `run_history` object (nullable when
  collection is skipped or fails). The `fabric_mapping` aggregator consumes it
  automatically.
- `README.md` and `QUICKSTART.md` updated to document the new statistics, CLI
  flags, env vars, and dependency inventory link.

### Fixed
- `SECURITY.md`: replaced an invalid GitHub Security Advisories URL.

### Required permissions
- The new run-history collection uses the existing **Synapse Artifact User**
  workspace role already required by `analyze-pipelines`. No additional
  permissions are needed.

## [1.0.0] - Initial release

- Initial public release: dedicated pools, serverless pools, spark pools,
  pipelines, monitoring, storage, and fabric_mapping modules with JSON / CSV /
  Markdown / HTML reporting.
