"""Pure aggregation of pipeline / activity run records into rolling-window stats.

This module contains *no* Azure SDK imports — it operates on plain dicts so
it can be exhaustively unit-tested with fixtures. The collector
(``run_history_client.py``) is responsible for paginating the Synapse Artifacts
API and feeding well-shaped dicts into :func:`aggregate_runs`.

Raw shapes consumed (subset of fields, all optional/duck-typed):

``RawRun`` (one item per pipeline execution):
    - ``run_id``            : str
    - ``pipeline_name``     : str
    - ``status``            : str   (``"Succeeded"`` | ``"Failed"`` | ``"InProgress"`` | ``"Queued"`` | ``"Cancelled"`` | ...)
    - ``run_end``           : datetime (timezone-aware preferred)
    - ``run_start``         : datetime
    - ``duration_in_ms``    : int | float | None

``RawActivityRun`` (zero or more per run, only fetched for pipelines that
contain data-movement activities):
    - ``activity_name``     : str
    - ``activity_type``     : str   (``"Copy"`` | ``"ExecuteDataFlow"`` | ``"Lookup"`` | ...)
    - ``status``            : str
    - ``output``            : dict  (Copy: ``dataRead`` / ``dataWritten`` in bytes;
                                       Dataflow: ``bytesProcessed`` or ``runStatus.metrics``)
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from .models import (
    RUN_STATS_WINDOWS_DAYS,
    PipelineRunStats,
    PipelineRunWindowStats,
)

# Activity types that, when present in a pipeline's static definition, mean
# we should attribute "data movement" metrics to that pipeline.
DATA_MOVEMENT_ACTIVITY_TYPES: frozenset[str] = frozenset({
    "Copy",
    "ExecuteDataFlow",
    "Lookup",
})

_TERMINAL_SUCCESS = {"succeeded"}
_TERMINAL_FAILURE = {"failed"}


@dataclass
class _RunBucket:
    count: int = 0
    succeeded: int = 0
    failed: int = 0
    other: int = 0
    durations_ms: list[float] = field(default_factory=list)
    data_bytes: list[int] = field(default_factory=list)  # per-run total bytes (only when >0 / known)


def _coerce_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            # Python's fromisoformat handles "...+00:00"; convert "Z" first.
            txt = value.replace("Z", "+00:00")
            dt = datetime.fromisoformat(txt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _percentile(values: list[float], pct: float) -> float | None:
    """Nearest-rank percentile (good enough for run durations, no numpy dep)."""
    if not values:
        return None
    sorted_vals = sorted(values)
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    rank = max(1, math.ceil(pct / 100.0 * len(sorted_vals)))
    return sorted_vals[rank - 1]


def _safe_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def extract_data_bytes(activity_run: dict[str, Any]) -> int | None:
    """Best-effort extraction of bytes moved by a single activity run.

    Returns ``None`` when the activity doesn't expose data-movement counters
    (so callers can distinguish "no data movement" from "0 bytes").
    """
    output = activity_run.get("output")
    if not isinstance(output, dict):
        return None
    a_type = (activity_run.get("activity_type") or "").lower()

    if a_type == "copy":
        # Synapse Copy activity: dataRead / dataWritten are bytes.
        read = _safe_int(output.get("dataRead"))
        written = _safe_int(output.get("dataWritten"))
        if read is None and written is None:
            return None
        # Use written when present, otherwise read. (Don't double-count.)
        return written if written is not None else read

    if a_type == "executedataflow":
        # Mapping data flows surface metrics under runStatus.metrics.<sink>.bytes.
        run_status = output.get("runStatus")
        if isinstance(run_status, dict):
            metrics = run_status.get("metrics")
            if isinstance(metrics, dict):
                total = 0
                seen = False
                for sink_metrics in metrics.values():
                    if isinstance(sink_metrics, dict):
                        b = _safe_int(sink_metrics.get("bytes"))
                        if b is not None:
                            total += b
                            seen = True
                if seen:
                    return total
        b = _safe_int(output.get("bytesProcessed"))
        return b

    if a_type == "lookup":
        # Lookups don't carry bytes; surface 0 only when explicitly reported.
        return _safe_int(output.get("dataRead"))

    return None


def aggregate_runs(
    *,
    pipeline_names: Iterable[str],
    pipelines_with_data_movement: set[str],
    runs: Iterable[dict[str, Any]],
    activity_runs_by_run_id: dict[str, list[dict[str, Any]]] | None = None,
    now: datetime | None = None,
    windows_days: tuple[int, ...] = RUN_STATS_WINDOWS_DAYS,
) -> list[PipelineRunStats]:
    """Bucket runs into rolling windows and emit per-pipeline stats.

    ``pipeline_names`` ensures every known pipeline gets a row (with zero
    counts) even if it has not run in the fetch window.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    activity_runs_by_run_id = activity_runs_by_run_id or {}

    # Pre-compute window cutoffs so each run is bucketed in O(W).
    sorted_windows = sorted(windows_days)
    cutoffs = [(w, now - timedelta(days=w)) for w in sorted_windows]

    by_pipe_window: dict[str, dict[int, _RunBucket]] = defaultdict(
        lambda: {w: _RunBucket() for w in sorted_windows}
    )
    last_run: dict[str, tuple[datetime, str | None]] = {}

    for run in runs:
        pname = run.get("pipeline_name") or run.get("pipeline")
        if not pname:
            continue
        end_dt = _coerce_datetime(run.get("run_end") or run.get("run_start"))
        if end_dt is None:
            continue

        status = (run.get("status") or "").strip()
        status_lc = status.lower()
        duration = run.get("duration_in_ms")
        try:
            duration_f = float(duration) if duration is not None else None
        except (TypeError, ValueError):
            duration_f = None

        # Track latest run per pipeline.
        prev = last_run.get(pname)
        if prev is None or end_dt > prev[0]:
            last_run[pname] = (end_dt, status or None)

        # Sum data bytes from activity runs (Copy/Dataflow). None → unknown.
        run_id = run.get("run_id")
        bytes_for_run: int | None = None
        if run_id and pname in pipelines_with_data_movement:
            for ar in activity_runs_by_run_id.get(run_id, []):
                b = extract_data_bytes(ar)
                if b is None:
                    continue
                bytes_for_run = (bytes_for_run or 0) + b

        for w, cutoff in cutoffs:
            if end_dt < cutoff:
                continue
            bucket = by_pipe_window[pname][w]
            bucket.count += 1
            if status_lc in _TERMINAL_SUCCESS:
                bucket.succeeded += 1
            elif status_lc in _TERMINAL_FAILURE:
                bucket.failed += 1
            else:
                bucket.other += 1
            if duration_f is not None:
                bucket.durations_ms.append(duration_f)
            if bytes_for_run is not None:
                bucket.data_bytes.append(bytes_for_run)

    # Materialize results, including zero rows for pipelines with no runs.
    out: list[PipelineRunStats] = []
    for pname in pipeline_names:
        windows: list[PipelineRunWindowStats] = []
        buckets = by_pipe_window.get(pname, {w: _RunBucket() for w in sorted_windows})
        for w in sorted_windows:
            b = buckets[w]
            terminal = b.succeeded + b.failed
            success_rate = (b.succeeded / terminal) if terminal else None
            avg_dur = (sum(b.durations_ms) / len(b.durations_ms)) if b.durations_ms else None
            p95 = _percentile(b.durations_ms, 95.0)

            has_dm = pname in pipelines_with_data_movement
            avg_mb_per_run: float | None = None
            total_mb: float | None = None
            if has_dm:
                if b.data_bytes:
                    total_bytes = sum(b.data_bytes)
                    total_mb = total_bytes / (1024 * 1024)
                    avg_mb_per_run = total_mb / len(b.data_bytes)
                else:
                    # Pipeline can move data but no metrics observed in window:
                    # leave as None (unknown) rather than reporting 0.
                    total_mb = 0.0 if b.count == 0 else None
                    avg_mb_per_run = None

            windows.append(PipelineRunWindowStats(
                window_days=w,
                run_count=b.count,
                succeeded=b.succeeded,
                failed=b.failed,
                other=b.other,
                success_rate=success_rate,
                avg_duration_ms=avg_dur,
                p95_duration_ms=p95,
                avg_data_moved_mb_per_run=avg_mb_per_run,
                total_data_moved_mb=total_mb,
            ))

        last = last_run.get(pname)
        out.append(PipelineRunStats(
            pipeline=pname,
            has_data_movement=pname in pipelines_with_data_movement,
            last_run_at=last[0] if last else None,
            last_run_status=last[1] if last else None,
            windows=windows,
        ))
    return out


def pipelines_with_data_movement(activities: Iterable[dict[str, Any]]) -> set[str]:
    """Return the set of pipelines that statically contain a data-movement activity."""
    out: set[str] = set()
    for a in activities:
        a_type = a.get("type") or ""
        if a_type in DATA_MOVEMENT_ACTIVITY_TYPES:
            pname = a.get("pipeline")
            if pname:
                out.add(pname)
    return out
