"""Orchestrator for the pipelines module."""
from __future__ import annotations

import logging
import os
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

from ...config import AppConfig
from ...errors import format_error
from ...progress import NullProgress, ProgressReporter
from . import expression_compat, run_stats, schedule_mapper
from .artifacts_client import ArtifactsApiClient
from .models import (
    RUN_STATS_WINDOWS_DAYS,
    ExpressionFinding,
    PipelineRunHistory,
    PipelinesAnalysis,
    ScheduleMapping,
)
from .run_history_client import RunHistoryClient

log = logging.getLogger(__name__)


class PipelinesAnalyzer:
    def __init__(
        self,
        cfg: AppConfig,
        *,
        progress: ProgressReporter | None = None,
    ) -> None:
        self._cfg = cfg
        self._api = ArtifactsApiClient(cfg.azure)
        self._progress = progress or NullProgress()

    def run(self) -> PipelinesAnalysis:
        result = PipelinesAnalysis(
            workspace_name=self._cfg.azure.workspace_name,
            subscription_id=self._cfg.azure.subscription_id,
            resource_group=self._cfg.azure.resource_group,
            artifacts_endpoint=self._api.endpoint,
            generated_at=datetime.now(timezone.utc),
        )

        # 7 sub-tasks: pipelines+activities, linked_services, datasets,
        # triggers, integration_runtimes, expression_compat, schedule_mapper.
        # Run history (when enabled) adds N more steps via add_total below.
        self._progress.start(7, label="enumerating pipelines")

        # Pipelines + activities (walked together so we only call the API once).
        try:
            pipes: list = []
            acts: list = []
            for pipe, activities in self._api.iter_pipelines_with_activities():
                pipes.append(pipe)
                acts.extend(activities)
            result.pipelines = pipes
            result.activities = acts
        except Exception as exc:  # noqa: BLE001
            log.warning("pipelines collection failed: %s", exc)
            result.errors.append(format_error("pipelines", exc))
        self._progress.step(label="pipelines+activities")

        for label, fn, attr in (
            ("linked_services", self._api.list_linked_services, "linked_services"),
            ("datasets", self._api.list_datasets, "datasets"),
            ("triggers", self._api.list_triggers, "triggers"),
            ("integration_runtimes", self._api.list_integration_runtimes, "integration_runtimes"),
        ):
            try:
                setattr(result, attr, list(fn()))
            except Exception as exc:  # noqa: BLE001
                log.warning("%s collection failed: %s", label, exc)
                result.errors.append(format_error(label, exc))
            self._progress.step(label=label)

        # v2 — expression-language compatibility scan over activity payloads.
        try:
            findings = expression_compat.scan_activities(
                [a.model_dump() for a in result.activities]
            )
            result.expression_findings = [
                ExpressionFinding(
                    rule_id=f.rule_id, label=f.label, severity=f.severity,
                    pipeline=f.pipeline, activity=f.activity, expression=f.expression,
                )
                for f in findings
            ]
        except Exception as exc:  # noqa: BLE001
            log.warning("expression_compat failed: %s", exc)
            result.errors.append(f"expression_compat: {exc}")
        self._progress.step(label="expression_compat")

        # v2 — trigger schedule → Fabric schedule mapping.
        try:
            for trig in result.triggers:
                sched = schedule_mapper.map_trigger(trig.model_dump())
                result.schedule_mappings.append(ScheduleMapping(
                    trigger_name=trig.name,
                    trigger_type=trig.type,
                    fabric_kind=sched.kind,
                    every_n=sched.every_n,
                    interval=sched.interval,
                    days_of_week=list(sched.days_of_week),
                    start_time_utc=sched.start_time_utc,
                    end_time_utc=sched.end_time_utc,
                    notes=list(sched.notes),
                    summary=schedule_mapper.render_human(sched),
                ))
        except Exception as exc:  # noqa: BLE001
            log.warning("schedule_mapper failed: %s", exc)
            result.errors.append(f"schedule_mapper: {exc}")
        self._progress.step(label="schedule_mapper")

        # v3 — pipeline run history (counts / success rates / data movement).
        if _env_flag("SMA_PIPELINES_RUN_HISTORY", default=True):
            self._progress.add_total(1)
            try:
                result.run_history = self._collect_run_history(result)
            except Exception as exc:  # noqa: BLE001
                log.warning("run_history collection failed: %s", exc)
                result.errors.append(format_error("run_history", exc))
            self._progress.step(label="run_history")

        return result

    # ------------------------------------------------------------------ run history

    def _collect_run_history(self, result: PipelinesAnalysis) -> PipelineRunHistory:
        max_window = max(RUN_STATS_WINDOWS_DAYS)
        days = _env_int("SMA_PIPELINES_RUN_DAYS", default=max_window, minimum=1)
        run_limit = _env_int("SMA_PIPELINES_RUN_LIMIT", default=5000, minimum=1)
        fetch_activity_runs = _env_flag("SMA_PIPELINES_ACTIVITY_RUNS", default=True)
        # Sampling cap: per-pipeline upper bound on how many terminal runs we
        # actually fetch activity-runs for. The aggregator only needs a
        # *sample* to derive averages — set to 0 to disable the cap.
        ar_sample_per_pipeline = _env_int(
            "SMA_PIPELINES_ACTIVITY_RUN_SAMPLE", default=50, minimum=0,
        )
        # Number of parallel HTTP fetches for activity-runs. Synapse Artifacts
        # is sync HTTP, so a small thread pool gives a big win without hitting
        # service throttling.
        concurrency = _env_int(
            "SMA_PIPELINES_RUN_CONCURRENCY", default=8, minimum=1,
        )

        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days)
        history = PipelineRunHistory(window_start=start, window_end=end)

        client = RunHistoryClient(self._cfg.azure)

        # Pull all runs first (ordered RunStart DESC server-side, so the
        # most recent runs are kept when the cap is hit).
        runs: list[dict] = []
        for run in client.iter_pipeline_runs(start=start, end=end, limit=run_limit):
            runs.append(run)
        history.fetched_run_count = len(runs)
        if len(runs) >= run_limit:
            history.truncated = True

        # When the global cap was hit, low-frequency pipelines may have been
        # starved by a few high-volume ones. For every pipeline that ended
        # up with zero runs, do a best-effort per-pipeline backfill query
        # so the dashboard at least shows their last few executions. We cap
        # this aggressively (10 runs / pipeline, batched 25 at a time) to
        # avoid amplifying load on Synapse.
        if history.truncated:
            seen_pipelines: set[str] = {
                r.get("pipeline_name") for r in runs if r.get("pipeline_name")
            }
            missing = [
                p.name for p in result.pipelines if p.name and p.name not in seen_pipelines
            ]
            if missing:
                per_pipeline_cap = _env_int(
                    "SMA_PIPELINES_RUN_BACKFILL_PER_PIPELINE", default=10, minimum=1,
                )
                batch_size = 25
                backfill_total = 0
                for i in range(0, len(missing), batch_size):
                    chunk = missing[i:i + batch_size]
                    # Per-pipeline cap × chunk-size upper bound for this batch.
                    chunk_cap = per_pipeline_cap * len(chunk)
                    try:
                        for r in client.iter_pipeline_runs(
                            start=start,
                            end=end,
                            limit=chunk_cap,
                            pipeline_names=chunk,
                        ):
                            runs.append(r)
                            backfill_total += 1
                    except Exception as exc:  # noqa: BLE001
                        log.debug("backfill[%s] failed: %s", chunk, exc)
                        result.errors.append(format_error(
                            f"runs_backfill[{','.join(chunk)}]", exc,
                        ))
                if backfill_total:
                    log.info(
                        "Backfilled %d runs across %d previously-missing pipelines",
                        backfill_total, len(missing),
                    )
                    history.fetched_run_count = len(runs)

        # Determine which pipelines could plausibly emit data-movement metrics.
        dm_set = run_stats.pipelines_with_data_movement(
            [a.model_dump() for a in result.activities]
        )

        # Decide which runs to query activity-runs for. Only terminal
        # (succeeded/failed) runs are candidates; in-progress runs would skew
        # metrics. We fetch for *all* pipelines (not just data-movement ones)
        # so the orchestration meter can count actual non-copy activity runs
        # — including ForEach/Until fan-out — instead of relying on the static
        # activity-count multiplier. Within each pipeline we take the most
        # recent ``ar_sample_per_pipeline`` runs (sorted by ``run_end`` desc).
        activity_runs_by_run_id: dict[str, list[dict]] = {}
        if fetch_activity_runs and runs:
            candidates_by_pipeline: dict[str, list[dict]] = defaultdict(list)
            for run in runs:
                pname = run.get("pipeline_name")
                run_id = run.get("run_id")
                status = (run.get("status") or "").lower()
                if not (pname and run_id):
                    continue
                if status not in ("succeeded", "failed"):
                    continue
                candidates_by_pipeline[pname].append(run)

            selected: list[dict] = []
            for pname, plist in candidates_by_pipeline.items():
                # Sort by run_end desc — fall back to run_start if missing.
                plist.sort(
                    key=lambda r: r.get("run_end") or r.get("run_start") or datetime.min,
                    reverse=True,
                )
                if ar_sample_per_pipeline > 0:
                    plist = plist[:ar_sample_per_pipeline]
                selected.extend(plist)

            # Cap total activity-run rows like before so a runaway pipeline
            # cannot pull unbounded data into memory.
            ar_budget = run_limit
            ar_count = 0

            def _fetch_one(run: dict) -> tuple[str, list[dict] | None, Exception | None]:
                run_id = run["run_id"]
                pname = run["pipeline_name"]
                try:
                    ars = list(client.iter_activity_runs(
                        pipeline_name=pname,
                        run_id=run_id,
                        start=start,
                        end=end,
                        limit=ar_budget,
                    ))
                    return run_id, ars, None
                except Exception as exc:  # noqa: BLE001
                    return run_id, None, exc

            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                futures = [pool.submit(_fetch_one, run) for run in selected]
                for fut in as_completed(futures):
                    run_id, ars, err = fut.result()
                    if err is not None:
                        log.debug("activity_runs[%s] failed: %s", run_id, err)
                        result.errors.append(format_error(
                            f"activity_runs[{run_id}]", err,
                        ))
                        continue
                    if not ars:
                        continue
                    if ar_count >= ar_budget:
                        history.truncated = True
                        continue
                    activity_runs_by_run_id[run_id] = ars
                    ar_count += len(ars)
        history.fetched_activity_run_count = sum(
            len(v) for v in activity_runs_by_run_id.values()
        )

        history.by_pipeline = run_stats.aggregate_runs(
            pipeline_names=[p.name for p in result.pipelines],
            pipelines_with_data_movement=dm_set,
            runs=runs,
            activity_runs_by_run_id=activity_runs_by_run_id,
            non_copy_activity_counts=run_stats.non_copy_activity_counts(
                [a.model_dump() for a in result.activities]
            ),
            dataflow_cores_by_pipeline_activity=run_stats.dataflow_cores_by_pipeline_activity(
                [a.model_dump() for a in result.activities]
            ),
            now=end,
        )
        return history


def _env_flag(name: str, *, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


def _env_int(name: str, *, default: int, minimum: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        n = int(raw)
    except ValueError:
        return default
    return max(minimum, n)
