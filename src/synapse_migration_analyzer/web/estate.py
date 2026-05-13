"""Estate-wide aggregation of run artefacts.

Produces a single :class:`EstateReport` summarising every workspace
scanned by this server, by walking ``runs_dir/<id>/run.json`` plus the
relevant module artefacts (`fabric_mapping.json`, `cost.json`).

Designed to be cheap on repeat calls: results are memoised in-process
keyed by ``(run_id, run.json mtime)`` and rebuilt incrementally when a
new run lands or an existing run is mutated. There is no on-disk cache
\u2014 the index is small (~1 kB per run) so an in-memory dict is enough.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Iterable

from .schemas import (
    EstateHistoryPoint,
    EstateReport,
    EstateTopBlocker,
    EstateTotals,
    EstateWorkspace,
)
from .storage import FilesystemRunRepo

log = logging.getLogger(__name__)

# Per-workspace history cap. Older points are dropped once the count
# exceeds this; configurable via SMA_ESTATE_MAX_HISTORY for power users.
_DEFAULT_MAX_HISTORY = 50


def _max_history() -> int:
    raw = os.getenv("SMA_ESTATE_MAX_HISTORY")
    if not raw:
        return _DEFAULT_MAX_HISTORY
    try:
        n = int(raw)
        return max(1, n)
    except ValueError:
        return _DEFAULT_MAX_HISTORY


def workspace_key(
    *,
    tenant_id: str | None = None,  # noqa: ARG001 — kept for API compatibility
    subscription_id: str | None,
    resource_group: str | None = None,  # noqa: ARG001 — kept for API compatibility
    workspace_name: str | None,
) -> str:
    """Stable URL-safe key for a workspace.

    Identity is ``(subscription_id, workspace_name)`` — subscription ids
    are globally unique, so this stays correct across tenants while
    avoiding split rows when a workspace is rescanned after the
    tenant/RG fields were added to ``run.json``. The ``tenant_id`` and
    ``resource_group`` arguments are accepted but ignored.
    """
    return f"{subscription_id or '_'}|{workspace_name or '_'}"


class EstateIndex:
    """In-memory aggregator.

    Holds per-run extracts keyed by ``run_id`` so the next call only
    needs to re-read run folders whose ``run.json`` mtime advanced (or
    new folders that appeared).
    """

    def __init__(self, repo: FilesystemRunRepo) -> None:
        self.repo = repo
        self._lock = RLock()
        # run_id -> (mtime_ns, extract dict)
        self._cache: dict[str, tuple[int, dict[str, Any]]] = {}

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def invalidate(self, run_id: str | None = None) -> None:
        with self._lock:
            if run_id is None:
                self._cache.clear()
            else:
                self._cache.pop(run_id, None)

    def build(self) -> EstateReport:
        with self._lock:
            extracts = self._collect_extracts()

        groups: dict[str, list[dict[str, Any]]] = {}
        for ex in extracts:
            groups.setdefault(ex["workspace_key"], []).append(ex)

        cap = _max_history()
        workspaces: list[EstateWorkspace] = []
        latest_extracts: list[dict[str, Any]] = []
        for key, items in groups.items():
            items.sort(key=lambda r: r["finished_at_sort"], reverse=True)
            latest = next(
                (r for r in items if r["status"] == "ok"),
                items[0],
            )
            latest_extracts.append(latest)
            history_items = items[:cap]
            history = [
                EstateHistoryPoint(
                    run_id=r["id"],
                    finished_at=r["finished_at"],
                    status=r["status"],
                    readiness_score=r["readiness_score"],
                    blocker_count=r["blocker_count"],
                    warning_count=r["warning_count"],
                    actual_monthly_cost=r["actual_monthly_cost"],
                )
                for r in reversed(history_items)  # chronological for charting
            ]
            workspaces.append(EstateWorkspace(
                key=key,
                tenant_id=latest["tenant_id"],
                subscription_id=latest["subscription_id"],
                resource_group=latest["resource_group"],
                workspace_name=latest["workspace_name"] or "(unknown)",
                run_count=len(items),
                latest_run_id=latest["id"],
                latest_status=latest["status"],
                latest_finished_at=latest["finished_at"],
                modules_run=latest["modules_run"],
                readiness_score=latest["readiness_score"],
                readiness_bucket=latest["readiness_bucket"],
                blocker_count=latest["blocker_count"],
                warning_count=latest["warning_count"],
                info_count=latest["info_count"],
                tsql_compatibility_pct=latest["tsql_compatibility_pct"],
                projected_fabric_cu=latest["projected_fabric_cu"],
                recommended_fabric_sku=latest["recommended_fabric_sku"],
                actual_monthly_cost=latest["actual_monthly_cost"],
                actual_currency=latest["actual_currency"],
                fabric_estimated_monthly_cost=latest["fabric_estimated_monthly_cost"],
                fabric_cost_delta_abs=latest["fabric_cost_delta_abs"],
                fabric_cost_delta_pct=latest["fabric_cost_delta_pct"],
                effort_hours_p50=latest["effort_hours_p50"],
                effort_hours_p90=latest["effort_hours_p90"],
                effort_days_p50=latest["effort_days_p50"],
                effort_days_p90=latest["effort_days_p90"],
                history=history,
            ))

        workspaces.sort(key=lambda w: (w.workspace_name or "").lower())
        totals = _totals(workspaces)
        # Aggregate blockers from each workspace's *latest* extract only,
        # so the table can never disagree with the "Open blockers" total.
        top_blockers = _aggregate_top_blockers(latest_extracts)
        return EstateReport(
            generated_at=datetime.now(timezone.utc),
            totals=totals,
            workspaces=workspaces,
            top_blockers=top_blockers,
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _collect_extracts(self) -> list[dict[str, Any]]:
        runs_dir = self.repo.runs_dir
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for entry in runs_dir.iterdir():
            if not entry.is_dir():
                continue
            run_id = entry.name
            try:
                self.repo._validate_id(run_id)  # noqa: SLF001 \u2014 internal check
            except ValueError:
                continue
            seen.add(run_id)
            run_json = entry / "run.json"
            if not run_json.exists():
                continue
            try:
                mtime_ns = run_json.stat().st_mtime_ns
            except OSError:
                continue
            cached = self._cache.get(run_id)
            if cached is not None and cached[0] == mtime_ns:
                out.append(cached[1])
                continue
            extract = _extract_run(entry)
            if extract is None:
                continue
            self._cache[run_id] = (mtime_ns, extract)
            out.append(extract)
        # Drop cache entries for deleted runs.
        for stale in [k for k in self._cache if k not in seen]:
            self._cache.pop(stale, None)
        return out


# ---------------------------------------------------------------------------
# Per-run extraction
# ---------------------------------------------------------------------------


def _extract_run(run_dir: Path) -> dict[str, Any] | None:
    run_json = run_dir / "run.json"
    try:
        meta = json.loads(run_json.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("estate: skipping unreadable %s: %s", run_json, exc)
        return None

    started = _parse_dt(meta.get("started_at"))
    finished = _parse_dt(meta.get("finished_at")) or started
    if finished is None:
        # Cannot place this run on a timeline.
        return None

    fm = _read_optional_json(run_dir / "fabric_mapping.json")
    cost = _read_optional_json(run_dir / "cost.json")
    pipelines = _read_optional_json(run_dir / "pipelines.json")
    workspace_name = (
        meta.get("workspace_name")
        or (fm.get("workspace_name") if fm else None)
        or (cost.get("workspace_name") if cost else None)
    )
    # Older runs predate the workspace identity fields on ``run.json``;
    # fall back to cost.json (which has carried subscription_id /
    # resource_group since v1) so totals like "Subscriptions" stay
    # accurate for legacy data.
    subscription_id = meta.get("subscription_id") or (
        cost.get("subscription_id") if cost else None
    )
    resource_group = meta.get("resource_group") or (
        cost.get("resource_group") if cost else None
    )
    tenant_id = meta.get("tenant_id")

    readiness = (fm or {}).get("readiness") or {}
    capacity = (fm or {}).get("capacity_projection") or {}
    counts = readiness.get("counts") or {}
    fabric_cmp = (cost or {}).get("fabric_comparison") or {}
    actual_monthly = None
    if cost:
        # Average of the monthly_totals dict.
        monthly_totals = cost.get("monthly_totals") or {}
        if isinstance(monthly_totals, dict) and monthly_totals:
            try:
                vals = [float(v) for v in monthly_totals.values()]
                actual_monthly = sum(vals) / len(vals) if vals else None
            except (TypeError, ValueError):
                actual_monthly = None
        if actual_monthly is None:
            actual_monthly = fabric_cmp.get("synapse_avg_monthly_cost")

    actual_currency = None
    if cost:
        for row in cost.get("rows") or []:
            cur = row.get("currency") if isinstance(row, dict) else None
            if cur:
                actual_currency = cur
                break

    modules_run: list[str] = [
        m.get("name") for m in meta.get("modules", []) if m.get("name")
    ]

    blockers: list[dict[str, Any]] = []
    warnings_count = 0
    info_count = 0
    if fm:
        for r in fm.get("recommendations") or []:
            sev = r.get("severity")
            if sev == "blocker":
                blockers.append(r)
            elif sev == "warning":
                warnings_count += 1
            elif sev == "info":
                info_count += 1

    workspace_key_str = workspace_key(
        subscription_id=subscription_id,
        workspace_name=workspace_name,
    )

    # Steady-state CU contribution from pipeline integration activity
    # (DIU-hr + orchestration CU-hr). Mirrors Dashboard's calculation so the
    # estate-level "Estimated SKU needed" accounts for pipelines, not just
    # the dedicated-pool capacity projection.
    integration_daily_cu = _integration_daily_cu(pipelines)

    dw_cu = capacity.get("estimated_cu")
    if dw_cu is None and integration_daily_cu == 0.0:
        projected_fabric_cu: float | None = None
    else:
        projected_fabric_cu = float(dw_cu or 0.0) + integration_daily_cu

    return {
        "id": meta.get("id") or run_dir.name,
        "status": meta.get("status") or "ok",
        "finished_at": finished,
        # ``finished_at_sort`` is a comparable key with a stable tiebreak.
        "finished_at_sort": (finished, run_dir.name),
        "tenant_id": tenant_id,
        "subscription_id": subscription_id,
        "resource_group": resource_group,
        "workspace_name": workspace_name,
        "workspace_key": workspace_key_str,
        "modules_run": modules_run,
        "readiness_score": readiness.get("score"),
        "readiness_bucket": readiness.get("bucket"),
        "blocker_count": len(blockers),
        "warning_count": warnings_count,
        "info_count": info_count,
        "tsql_compatibility_pct": readiness.get("tsql_compatibility_pct"),
        "projected_fabric_cu": projected_fabric_cu,
        "projected_fabric_cu_dw": capacity.get("estimated_cu"),
        "projected_fabric_cu_pipelines": integration_daily_cu or None,
        "recommended_fabric_sku": capacity.get("recommended_sku"),
        "actual_monthly_cost": actual_monthly,
        "actual_currency": actual_currency,
        "fabric_estimated_monthly_cost": fabric_cmp.get("fabric_estimated_monthly_cost"),
        "fabric_cost_delta_abs": fabric_cmp.get("delta_abs"),
        "fabric_cost_delta_pct": fabric_cmp.get("delta_pct"),
        "effort_hours_p50": ((fm or {}).get("effort_summary") or {}).get("total_p50_hours"),
        "effort_hours_p90": ((fm or {}).get("effort_summary") or {}).get("total_p90_hours"),
        "effort_days_p50": ((fm or {}).get("effort_summary") or {}).get("total_p50_days"),
        "effort_days_p90": ((fm or {}).get("effort_summary") or {}).get("total_p90_days"),
        "blockers_raw": blockers,
    }


def _read_optional_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("estate: skipping unreadable %s: %s", path, exc)
        return None
    return data if isinstance(data, dict) else None


def _integration_daily_cu(pipelines: dict[str, Any] | None) -> float:
    """Steady-state CU/day from pipeline integration activity.

    Mirrors ``Dashboard.tsx``: prefers the 7-day window per pipeline (falls
    back to the first available window), sums DIU + orchestration CU-hours
    across pipelines, then converts CU-hr/window into sustained CU
    (``total / window_days / 24``). Returns ``0.0`` when ``pipelines.json``
    is absent or has no run-history rollup.
    """
    if not pipelines:
        return 0.0
    hist = pipelines.get("run_history") or {}
    by_pipeline = hist.get("by_pipeline") or []
    if not isinstance(by_pipeline, list) or not by_pipeline:
        return 0.0
    total_cu_hr = 0.0
    window_days = 0
    for p in by_pipeline:
        if not isinstance(p, dict):
            continue
        windows = p.get("windows") or []
        if not isinstance(windows, list) or not windows:
            continue
        w = next(
            (x for x in windows if isinstance(x, dict) and x.get("window_days") == 7),
            windows[0] if isinstance(windows[0], dict) else None,
        )
        if not w:
            continue
        try:
            total_cu_hr += float(w.get("est_cu_hours_from_diu") or 0.0)
            total_cu_hr += float(w.get("est_cu_hours_from_vcore") or 0.0)
            total_cu_hr += float(w.get("est_cu_hours_from_orchestration") or 0.0)
        except (TypeError, ValueError):
            continue
        wd = w.get("window_days")
        if isinstance(wd, (int, float)) and wd > window_days:
            window_days = int(wd)
    if window_days <= 0:
        return 0.0
    return (total_cu_hr / window_days) / 24.0


def _parse_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            # fromisoformat handles "2026-05-08T12:00:00+00:00" and
            # "2026-05-08T12:00:00Z" in Python 3.11+.
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _totals(workspaces: Iterable[EstateWorkspace]) -> EstateTotals:
    ws_list = list(workspaces)
    runs = sum(w.run_count for w in ws_list)
    ready = sum(1 for w in ws_list if w.readiness_bucket == "ready")
    ready_with_effort = sum(
        1 for w in ws_list if w.readiness_bucket == "ready-with-effort"
    )
    blocked = sum(1 for w in ws_list if w.readiness_bucket == "blocked")
    blockers_total = sum(w.blocker_count for w in ws_list)
    tsql_vals = [w.tsql_compatibility_pct for w in ws_list if w.tsql_compatibility_pct is not None]
    cu_vals = [w.projected_fabric_cu for w in ws_list if w.projected_fabric_cu is not None]
    cost_vals = [w.actual_monthly_cost for w in ws_list if w.actual_monthly_cost is not None]
    fabric_cost_vals = [
        w.fabric_estimated_monthly_cost
        for w in ws_list
        if w.fabric_estimated_monthly_cost is not None
    ]
    effort_p50_vals = [w.effort_hours_p50 for w in ws_list if w.effort_hours_p50 is not None]
    effort_p90_vals = [w.effort_hours_p90 for w in ws_list if w.effort_hours_p90 is not None]
    effort_days_p50_vals = [w.effort_days_p50 for w in ws_list if w.effort_days_p50 is not None]
    effort_days_p90_vals = [w.effort_days_p90 for w in ws_list if w.effort_days_p90 is not None]
    subs = {(w.subscription_id or "(unknown)") for w in ws_list}
    tenants = {(w.tenant_id or "(unknown)") for w in ws_list}
    return EstateTotals(
        workspaces=len(ws_list),
        runs=runs,
        tenants=len(tenants),
        subscriptions=len(subs),
        ready=ready,
        ready_with_effort=ready_with_effort,
        blocked=blocked,
        blockers_total=blockers_total,
        tsql_compatibility_pct_avg=(
            sum(tsql_vals) / len(tsql_vals) if tsql_vals else None
        ),
        projected_fabric_cu_total=sum(cu_vals) if cu_vals else None,
        actual_monthly_cost_total=sum(cost_vals) if cost_vals else None,
        fabric_estimated_monthly_cost_total=(
            sum(fabric_cost_vals) if fabric_cost_vals else None
        ),
        effort_hours_p50_total=sum(effort_p50_vals) if effort_p50_vals else None,
        effort_hours_p90_total=sum(effort_p90_vals) if effort_p90_vals else None,
        effort_days_p50_total=sum(effort_days_p50_vals) if effort_days_p50_vals else None,
        effort_days_p90_total=sum(effort_days_p90_vals) if effort_days_p90_vals else None,
    )


def _aggregate_top_blockers(extracts: list[dict[str, Any]]) -> list[EstateTopBlocker]:
    """De-duplicate blockers by (area, title) and count how many workspaces hit them."""
    # Map (area, title) -> dict
    bucket: dict[tuple[str, str], dict[str, Any]] = {}
    for ex in extracts:
        ws_key = ex["workspace_key"]
        for r in ex.get("blockers_raw") or []:
            key = (r.get("area") or "", r.get("title") or "")
            entry = bucket.setdefault(
                key,
                {
                    "area": key[0],
                    "title": key[1],
                    "fabric_action": r.get("fabric_action"),
                    "effort": r.get("effort", "medium"),
                    "workspaces": set(),
                    "occurrences": 0,
                    "example_run_id": ex["id"],
                },
            )
            entry["workspaces"].add(ws_key)
            entry["occurrences"] += 1
    rows = [
        EstateTopBlocker(
            area=v["area"],
            title=v["title"],
            fabric_action=v["fabric_action"],
            effort=v["effort"],
            workspaces=len(v["workspaces"]),
            occurrences=v["occurrences"],
            example_run_id=v["example_run_id"],
        )
        for v in bucket.values()
    ]
    rows.sort(key=lambda r: (-r.workspaces, -r.occurrences, r.area, r.title))
    return rows[:20]
