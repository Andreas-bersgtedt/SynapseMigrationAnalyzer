"""Tests for the pipelines run_stats aggregator (pure functions, no Azure)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from synapse_migration_analyzer.modules.pipelines import run_stats
from synapse_migration_analyzer.modules.pipelines.run_stats import (
    DATA_MOVEMENT_ACTIVITY_TYPES,
    aggregate_runs,
    extract_data_bytes,
    pipelines_with_data_movement,
)

NOW = datetime(2026, 4, 28, 12, 0, 0, tzinfo=timezone.utc)


def _run(pipeline: str, age_days: float, status: str = "Succeeded",
         duration_ms: float | None = 1000.0, run_id: str | None = None) -> dict:
    return {
        "run_id": run_id or f"{pipeline}-{age_days}",
        "pipeline_name": pipeline,
        "status": status,
        "run_end": NOW - timedelta(days=age_days),
        "run_start": NOW - timedelta(days=age_days, minutes=1),
        "duration_in_ms": duration_ms,
    }


def _copy_ar(read: int | None = None, written: int | None = None) -> dict:
    out: dict = {}
    if read is not None:
        out["dataRead"] = read
    if written is not None:
        out["dataWritten"] = written
    return {"activity_type": "Copy", "status": "Succeeded", "output": out}


def test_data_movement_types_complete() -> None:
    assert {"Copy", "ExecuteDataFlow", "Lookup"} <= DATA_MOVEMENT_ACTIVITY_TYPES


def test_pipelines_with_data_movement_detects_activities() -> None:
    activities = [
        {"pipeline": "p1", "type": "Copy"},
        {"pipeline": "p2", "type": "Wait"},
        {"pipeline": "p3", "type": "ExecuteDataFlow"},
    ]
    assert pipelines_with_data_movement(activities) == {"p1", "p3"}


def test_extract_data_bytes_copy_uses_written_when_present() -> None:
    assert extract_data_bytes(_copy_ar(read=10, written=20)) == 20
    assert extract_data_bytes(_copy_ar(read=15)) == 15
    assert extract_data_bytes(_copy_ar()) is None


def test_extract_data_bytes_dataflow_metrics() -> None:
    ar = {
        "activity_type": "ExecuteDataFlow",
        "output": {"runStatus": {"metrics": {
            "sink1": {"bytes": 100},
            "sink2": {"bytes": 250},
        }}},
    }
    assert extract_data_bytes(ar) == 350


def test_extract_data_bytes_unknown_type_returns_none() -> None:
    assert extract_data_bytes({"activity_type": "Wait", "output": {}}) is None


def test_aggregate_runs_empty_pipeline_emits_zero_windows() -> None:
    out = aggregate_runs(
        pipeline_names=["empty"],
        pipelines_with_data_movement=set(),
        runs=[],
        now=NOW,
    )
    assert len(out) == 1
    stats = out[0]
    assert stats.pipeline == "empty"
    assert stats.last_run_at is None
    assert [w.window_days for w in stats.windows] == [7, 14, 28, 90]
    for w in stats.windows:
        assert w.run_count == 0
        assert w.success_rate is None
        assert w.avg_duration_ms is None
        assert w.total_data_moved_mb is None  # no data movement


def test_aggregate_runs_age_buckets() -> None:
    runs = [
        _run("p", age_days=1),    # in all 4 windows
        _run("p", age_days=10),   # in 14/28/90
        _run("p", age_days=20),   # in 28/90
        _run("p", age_days=60),   # in 90 only
    ]
    out = aggregate_runs(
        pipeline_names=["p"],
        pipelines_with_data_movement=set(),
        runs=runs,
        now=NOW,
    )
    counts = {w.window_days: w.run_count for w in out[0].windows}
    assert counts == {7: 1, 14: 2, 28: 3, 90: 4}


def test_aggregate_runs_success_rate_and_failures() -> None:
    runs = [
        _run("p", 1, status="Succeeded"),
        _run("p", 2, status="Succeeded"),
        _run("p", 3, status="Failed"),
        _run("p", 4, status="InProgress"),
    ]
    out = aggregate_runs(
        pipeline_names=["p"],
        pipelines_with_data_movement=set(),
        runs=runs,
        now=NOW,
    )
    w7 = next(w for w in out[0].windows if w.window_days == 7)
    assert w7.run_count == 4
    assert w7.succeeded == 2
    assert w7.failed == 1
    assert w7.other == 1
    assert w7.success_rate is not None
    assert abs(w7.success_rate - (2 / 3)) < 1e-9


def test_aggregate_runs_data_movement_avg_and_total() -> None:
    runs = [
        _run("dm", 1, run_id="r1"),
        _run("dm", 2, run_id="r2"),
    ]
    activity_runs = {
        "r1": [_copy_ar(written=1024 * 1024)],          # 1 MB
        "r2": [_copy_ar(written=2 * 1024 * 1024)],      # 2 MB
    }
    out = aggregate_runs(
        pipeline_names=["dm"],
        pipelines_with_data_movement={"dm"},
        runs=runs,
        activity_runs_by_run_id=activity_runs,
        now=NOW,
    )
    w7 = next(w for w in out[0].windows if w.window_days == 7)
    assert out[0].has_data_movement is True
    assert w7.total_data_moved_mb == 3.0
    assert w7.avg_data_moved_mb_per_run == 1.5


def test_aggregate_runs_no_data_movement_pipeline_emits_none() -> None:
    runs = [_run("nodm", 1)]
    out = aggregate_runs(
        pipeline_names=["nodm"],
        pipelines_with_data_movement=set(),
        runs=runs,
        now=NOW,
    )
    w7 = next(w for w in out[0].windows if w.window_days == 7)
    assert out[0].has_data_movement is False
    assert w7.avg_data_moved_mb_per_run is None
    assert w7.total_data_moved_mb is None


def test_aggregate_runs_p95_duration() -> None:
    runs = [_run("p", 1, duration_ms=float(i * 100)) for i in range(1, 101)]
    out = aggregate_runs(
        pipeline_names=["p"],
        pipelines_with_data_movement=set(),
        runs=runs,
        now=NOW,
    )
    w7 = next(w for w in out[0].windows if w.window_days == 7)
    # nearest-rank p95 of 1..100 (scaled by 100) is the 95th-largest (i=95) → 9500
    assert w7.p95_duration_ms == 9500.0
    assert w7.avg_duration_ms is not None and abs(w7.avg_duration_ms - 5050.0) < 1e-6


def test_aggregate_runs_last_run_tracking() -> None:
    runs = [
        _run("p", 5, status="Failed", run_id="old"),
        _run("p", 1, status="Succeeded", run_id="new"),
    ]
    out = aggregate_runs(
        pipeline_names=["p"],
        pipelines_with_data_movement=set(),
        runs=runs,
        now=NOW,
    )
    assert out[0].last_run_status == "Succeeded"
    assert out[0].last_run_at == NOW - timedelta(days=1)


def test_aggregate_runs_iso_string_dates_are_parsed() -> None:
    iso_run = {
        "run_id": "x",
        "pipeline_name": "p",
        "status": "Succeeded",
        "run_end": (NOW - timedelta(days=1)).isoformat().replace("+00:00", "Z"),
        "duration_in_ms": 500,
    }
    out = aggregate_runs(
        pipeline_names=["p"],
        pipelines_with_data_movement=set(),
        runs=[iso_run],
        now=NOW,
    )
    w7 = next(w for w in out[0].windows if w.window_days == 7)
    assert w7.run_count == 1
