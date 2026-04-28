"""Orchestrator for the pipelines module."""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from ...config import AppConfig
from ...errors import format_error
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
    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg
        self._api = ArtifactsApiClient(cfg.azure)

    def run(self) -> PipelinesAnalysis:
        result = PipelinesAnalysis(
            workspace_name=self._cfg.azure.workspace_name,
            subscription_id=self._cfg.azure.subscription_id,
            resource_group=self._cfg.azure.resource_group,
            artifacts_endpoint=self._api.endpoint,
            generated_at=datetime.now(timezone.utc),
        )

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

        # v3 — pipeline run history (counts / success rates / data movement).
        if _env_flag("SMA_PIPELINES_RUN_HISTORY", default=True):
            try:
                result.run_history = self._collect_run_history(result)
            except Exception as exc:  # noqa: BLE001
                log.warning("run_history collection failed: %s", exc)
                result.errors.append(format_error("run_history", exc))

        return result

    # ------------------------------------------------------------------ run history

    def _collect_run_history(self, result: PipelinesAnalysis) -> PipelineRunHistory:
        max_window = max(RUN_STATS_WINDOWS_DAYS)
        days = _env_int("SMA_PIPELINES_RUN_DAYS", default=max_window, minimum=1)
        run_limit = _env_int("SMA_PIPELINES_RUN_LIMIT", default=5000, minimum=1)
        fetch_activity_runs = _env_flag("SMA_PIPELINES_ACTIVITY_RUNS", default=True)

        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days)
        history = PipelineRunHistory(window_start=start, window_end=end)

        client = RunHistoryClient(self._cfg.azure)

        # Pull all runs first.
        runs: list[dict] = []
        for run in client.iter_pipeline_runs(start=start, end=end, limit=run_limit):
            runs.append(run)
        history.fetched_run_count = len(runs)
        if len(runs) >= run_limit:
            history.truncated = True

        # Determine which pipelines could plausibly emit data-movement metrics.
        dm_set = run_stats.pipelines_with_data_movement(
            [a.model_dump() for a in result.activities]
        )

        # For runs whose pipeline is in dm_set, fetch activity runs to compute
        # MB/run. We only fetch for *succeeded or failed* terminal runs (in-progress
        # runs would otherwise inflate API calls without yielding stable metrics).
        activity_runs_by_run_id: dict[str, list[dict]] = {}
        if fetch_activity_runs and dm_set and runs:
            ar_budget = run_limit  # reuse same cap for activity rows
            ar_count = 0
            for run in runs:
                if ar_count >= ar_budget:
                    history.truncated = True
                    break
                pname = run.get("pipeline_name")
                run_id = run.get("run_id")
                status = (run.get("status") or "").lower()
                if not (pname and run_id) or pname not in dm_set:
                    continue
                if status not in ("succeeded", "failed"):
                    continue
                try:
                    ars = list(client.iter_activity_runs(
                        pipeline_name=pname,
                        run_id=run_id,
                        start=start,
                        end=end,
                        limit=ar_budget - ar_count,
                    ))
                except Exception as exc:  # noqa: BLE001
                    log.debug("activity_runs[%s/%s] failed: %s", pname, run_id, exc)
                    result.errors.append(format_error(
                        f"activity_runs[{pname}/{run_id}]", exc,
                    ))
                    continue
                if ars:
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
