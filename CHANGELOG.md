# Changelog

All notable changes to **Synapse Migration Analyzer** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No changes yet._

## [2.0.0] - 2026-05-05

**Major release** — promotes the browser-driven control plane from an
opt-in preview to a first-class surface alongside the CLI. The `sma serve
--with-api` server, the React SPA, the run repository, the live progress
stream and the workspace-vitals Dashboard are all now part of the
supported product. The CLI, JSON / CSV / Markdown / HTML deliverables and
module contracts are unchanged from 1.2.x — every report file in
`output/` keeps the same shape — so existing automation continues to work
without modification.

**Highlights**

- One-shot Windows bootstrapper (`quickstart.ps1`) that installs every
  optional extra, builds the React SPA and launches the control plane.
- Browser control plane: Configuration / Run / Runs / Diff pages plus a
  workspace-level Dashboard with readiness, T-SQL surface, storage and
  pipeline-activity panels.
- Hardened SPA: deep-link / refresh-safe routing, run-id persistence
  across tabs, fixed Diff endpoint, faster and partial-failure-tolerant
  pipelines run-history collection.

**Upgrade notes**

- `pip install -e ".[web]"` (or rerun `quickstart.ps1`) is required to
  pick up the FastAPI / SSE dependencies for `sma serve --with-api`.
- Rebuild the SPA bundle (`cd web; npm install; npm run build`) so
  `web/dist/` matches the new types.
- Run files written by 1.2.x remain readable; no migration required.

### Added
- **Dashboard: storage statistics and pipeline daily activity.** The web
  SPA's main Dashboard now renders two extra sections sourced from
  `storage.json` and `pipelines.json`:
  - *Storage* — stat cards for dedicated-pool data / index space, ADLS
    used capacity, storage-account count, plus a per-pool table with row
    counts, data / index / reserved space and `% of max`.
  - *Pipeline activity (last 7 days)* — stat cards for daily run rate,
    success rate, daily data movement and the sampling window, plus a
    top-10 table with per-pipeline runs / day, success / failure breakdown,
    average data moved per run, total data moved and last run
    timestamp / status. Daily rates are derived from the 7-day rolling
    window (`run_count / 7`). Both sections render only when the
    underlying JSON is present, so deployments without those modules see
    the original Dashboard unchanged.
- **`quickstart.ps1` now bootstraps a fully working environment.** All
  optional pip extras (`dev`, `cost`, `web`) are installed unconditionally,
  the React SPA in `web/` is built by default (`npm install` + `npm run
  build`), and on a successful `sma doctor --offline` the script
  auto-launches `sma serve --with-api --static-dir web\dist` so the
  control plane is reachable in the browser at the end of bootstrap.
  Three new switches opt out: `-SkipDoctor`, `-SkipWebBuild`, `-NoServe`.
- **Web control plane (opt-in).** New `sma serve --with-api` boots a local
  FastAPI backend mounted at `/api/*` plus a SPA with four new pages:
  Configuration (read/write `.env`), Run (start an analyzer run with a
  module checklist), Runs (history), Diff (compare any two runs). The
  loopback-only HTTP server has no authentication; pass
  `--i-know-this-is-not-auth` to bind a non-loopback host. Live progress
  uses Server-Sent Events at `GET /api/runs/<id>/events`. Install via
  `pip install -e '.[web]'`. Static "deliverable" mode (the existing
  `sma serve` without `--with-api`) is unchanged.

### Fixed
- **SPA routing: deep links and tab navigation no longer 404 / blank.**
  `_SafeStaticFiles` now serves `index.html` for unknown non-asset paths
  so React Router's client-side routes survive a hard reload, and the
  selected run id is mirrored into `sessionStorage` (in addition to the
  URL hash) so navigating between tabs after picking a run keeps the
  module pages populated.
- **`GET /api/runs/<a>/diff/<b>` returned HTTP 500.** The endpoint
  attempted to JSON-encode `RunManifestEntry` dataclasses directly. The
  response now goes through `dataclasses.asdict` with ISO datetime
  serialization so the Diff page renders as expected.
- **Pipelines run-history collection: latency and partial-failure
  resilience.** Per-pipeline run / activity-run queries are batched and
  short-circuited when the workspace returns empty windows, and a single
  pipeline that errors no longer aborts the entire history pull —
  the failure is captured in the report's `errors[]` and other
  pipelines continue to be sampled.

### Fixed
- **Dedicated SQL pool storage reported `0 tables / 0 rows` and table
  sizes / row counts were missing from `tables.csv`.** Both the
  `storage` module's `pool_size.sql` and the `dedicated_pools`
  module's `tables.sql` joined `sys.dm_pdw_nodes_db_partition_stats`
  to `sys.tables` directly on `object_id`. In Synapse Dedicated SQL
  Pool the DMV's `object_id` is the *node-local* physical table id,
  not the user-database `sys.tables.object_id`, so the join collapsed
  to zero matches and the analyzer reported empty storage / row
  counts even on full pools. Both queries now route through
  `sys.pdw_nodes_tables` -> `sys.pdw_table_mappings` -> `sys.tables`,
  the documented mapping path. Verified end-to-end against
  `testpool001` (6 user tables, 9.4M rows, 6.28 GB reserved).

### Documentation
- **`VIEW DEFINITION` is now called out as a required SQL grant** on
  dedicated pools (and serverless) in [README.md](README.md) and
  [QUICKSTART.md](QUICKSTART.md). Without it, Synapse silently filters
  procedures and user-defined functions out of `sys.objects` /
  `sys.sql_modules` for the analyzer's principal, producing
  views-only `code_objects` reports. Added a troubleshooting row
  ("`code_objects` contains only views") that points to the missing
  grant.

### Fixed
- **`code_objects` only contained views, not procedures or functions.**
  The dedicated_pools `code_objects.sql` query drove from
  `sys.sql_modules` with an INNER JOIN, which silently dropped any
  procedure or function whose module body was unavailable (encrypted
  definition, restricted permission, or Synapse catalog edge cases),
  collapsing the inventory to "views only" in some tenants. The query
  now drives FROM `sys.objects` and LEFT JOINs `sys.sql_modules`, so
  procedures and functions are surfaced even when their body is hidden.
  `definition_length` becomes `NULL` instead of erroring when the body
  is missing. The `o.type` filter is RTRIM-ed for safety. Added a
  per-type INFO log line in the collector so a future regression is
  visible at runtime, plus a regression test pinning the join shape and
  verifying mixed P / V / FN / IF object types flow through.

### Added
- **`sma serve` CLI command.** Thin wrapper around `http.server` so
  analysts can browse `output_dir` (HTML reports + the optional `webui/`
  SPA) without running `python -m http.server` manually. Loopback-only
  by default (`--host 0.0.0.0` to expose), opens the browser at
  `webui/index.html` when present and falls back to the analyzer's
  `index.html` otherwise. Read-only.
- **Index banner for the web SPA.** When `webui/index.html` is present
  in the output directory, the analyzer-emitted `index.html` now
  renders an "Open web UI" banner above the per-module cards, so the
  static deliverable points analysts at the interactive view without
  hiding the per-module HTML reports they may still need.
- **Vitest smoke test for the SPA.** New `web/src/__tests__/fixtures.smoke.test.ts`
  loads committed fixtures under `tests/fixtures/web/` and asserts the
  documented top-level fields exist with the right primitive types.
  Closes the Phase 2 DoD item in `web/PLAN.md`.
- **GitHub Actions CI workflow.** New `.github/workflows/ci.yml` runs
  ruff + pytest for Python and `npm install && npm run typecheck && npm test && npm run build`
  for the web SPA, uploading `web/dist/` as a workflow artefact.
- **`sma export-schema` CLI command.** Emits the Pydantic JSON Schema
  for each module's top-level model (one `<module>.schema.json` per
  module, plus `x-sma-version` / `x-sma-module` stamps) into
  `./schemas/` (or `--out-dir <path>`). Lets the React SPA in `web/`
  regenerate `web/src/types.ts` via `json-schema-to-typescript` /
  `quicktype` instead of hand-maintaining the type contract. The
  command needs no Azure credentials.
- **`sma analyze-all --with-webui` flag.** After a successful run,
  copies the prebuilt static SPA from `web/dist/` (override with
  `--webui-dist <path>`) into `<output_dir>/webui/`, alongside copies
  of the analyzer's JSON outputs so the SPA can `fetch("./<module>.json")`
  out of the box. Missing `web/dist/` is a non-fatal warning. Closes
  the Phase 2 item tracked in `web/PLAN.md`.

### Changed
- **`analyze-all --with-webui` runs the SPA copy before rebuilding the
  index.** This ensures the analyzer's `index.html` picks up the SPA
  banner on the same run that installs the SPA.

### Changed
- **Web SPA dev mode simplified.** Vite now serves `$SMA_DATA_DIR`
  (default `../output`) as its `publicDir` during `npm run dev`, so the
  same `fetch("./fabric_mapping.json")` works in dev and prod. The
  unused `/data/*` proxy was removed. The loader now warns on missing
  modules instead of swallowing errors silently and caches each
  module's promise in memory so navigation between pages doesn't
  re-fetch JSON.

## [1.2.1] - 2026-05-01

### Added
- **SQL-plane analysis for stored procedures and functions.** The
  `dedicated_pools` collector now captures per-object metadata (create/modify
  date, line count, definition length, ANSI-NULLS / quoted-identifier flags)
  plus a parameter signature list (`sys.parameters`) for every procedure and
  function. Each `CodeObject` is classified as **`compatible`** /
  **`needs_review`** / **`incompatible`** based on its T-SQL surface gaps
  (blocker -> incompatible, warning -> needs_review, otherwise compatible),
  and a per-pool `code_object_summary` rolls counts up by object type and
  compatibility. The dedicated-pool markdown + HTML reports gain a
  "Code objects (SQL plane)" section with object-type breakdown,
  compatibility pills, parameter drill-downs, and a rule-rollup table.
  `fabric_mapping`'s `ReadinessSummary` adds `tsql_compatibility_pct`,
  `tsql_objects_total`, `tsql_objects_incompatible`, and
  `tsql_objects_needs_review` so the executive summary now shows
  "% T-SQL compatible" alongside the readiness score. Test suite grows to
  **195 tests** (+11 covering the classifier, summary rollup, and
  fabric_mapping integration).

### Changed
- **Lint baseline cleaned.** Removed unused imports, collapsed
  semicolon-separated statements in
  `dedicated_pools/distribution_advisor.py`, and hoisted the late
  `pydantic` import in `monitoring/reporting.py` to the top of the file.
  `ruff check src tests` is now clean.
- **Docs alignment.** Clarified that the `governance` module performs
  Purview **detection only** (not lineage extraction), and that
  `fabric_validation` remains a v0 preview opt-in via
  `--include fabric_validation`.

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
