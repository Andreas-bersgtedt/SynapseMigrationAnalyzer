# Changelog

All notable changes to **Synapse Migration Analyzer** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
