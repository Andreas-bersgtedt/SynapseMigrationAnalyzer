"""Project a Fabric capacity (CU) SKU from observed Synapse DWU usage.

Heuristic only. Derives a recommended Fabric capacity SKU from peak observed DWU and
a configurable safety headroom (default 30 %). The mapping table is approximate and
reflects published Microsoft sizing guidance at time of writing — confirm with the
current Fabric capacity sizing calculator.

Approach:

1. Pick the highest p95 of ``DWUUsedPercent * DWULimit / 100`` across all pools
   (= peak active DWU consumed).
2. Apply headroom (default 1.3x).
3. Look up the smallest Fabric F-SKU that covers that DWU equivalent.

Why DWU → F-SKU?  Microsoft's published guidance is roughly 1 DWU ≈ ~0.6 CU for
analytical Warehouse workloads; we use 0.7 to be slightly conservative. Mileage will
vary heavily by query mix — this is a *starting* SKU, not a final one.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

# Microsoft's Fabric capacity F-SKUs in Capacity Units (CU). F2/F4/... up to F2048.
# Subset most relevant for Synapse DW migrations.
_FSKU_TABLE: tuple[tuple[str, int], ...] = (
    ("F2",   2),  ("F4",   4),  ("F8",   8),  ("F16",  16),
    ("F32",  32), ("F64",  64), ("F128", 128), ("F256", 256),
    ("F512", 512), ("F1024", 1024), ("F2048", 2048),
)

DWU_TO_CU = 0.7  # see module docstring


@dataclass(frozen=True)
class CapacityProjection:
    peak_dwu: float
    peak_dwu_with_headroom: float
    estimated_cu: float
    recommended_sku: str
    headroom_pct: int
    notes: tuple[str, ...] = ()


def project_capacity(
    series: Iterable[dict],
    *,
    headroom_pct: int = 30,
) -> CapacityProjection | None:
    """Compute the projection from monitoring metric series. Returns ``None`` when there
    is not enough data to compute a peak.
    """
    peak_dwu = 0.0
    has_limit = False
    has_pct = False

    # Cross-reference DWULimit and DWUUsedPercent points by timestamp per pool.
    by_pool_metric: dict[tuple[str, str], dict] = {}
    for s in series:
        by_pool_metric[(s.get("resource_name", "?"), s.get("metric_name", "?"))] = s

    for (pool, metric), s in by_pool_metric.items():
        if metric != "DWUUsedPercent":
            continue
        has_pct = True
        limit_series = by_pool_metric.get((pool, "DWULimit"), {})
        limit_points = {ts: val for ts, val in (
            _norm_point(p) for p in (limit_series.get("points", []) or [])
        ) if ts}
        if limit_points:
            has_limit = True
        for p in s.get("points", []) or []:
            ts, pct = _norm_point(p)
            if ts is None or pct is None:
                continue
            limit = limit_points.get(ts)
            if limit is None:
                continue
            peak_dwu = max(peak_dwu, limit * pct / 100.0)

    if not (has_pct and has_limit) or peak_dwu <= 0:
        return None

    with_headroom = peak_dwu * (1 + headroom_pct / 100.0)
    cu_estimate = with_headroom * DWU_TO_CU
    sku = _smallest_sku_covering(cu_estimate)

    notes: list[str] = [
        f"Peak observed active DWU = {peak_dwu:.0f}.",
        f"Applied {headroom_pct}% headroom → {with_headroom:.0f} DWU equivalent.",
        f"Converted at {DWU_TO_CU} CU/DWU → {cu_estimate:.0f} CU.",
        "Heuristic only; confirm with the Fabric capacity sizing calculator.",
    ]
    return CapacityProjection(
        peak_dwu=round(peak_dwu, 1),
        peak_dwu_with_headroom=round(with_headroom, 1),
        estimated_cu=round(cu_estimate, 1),
        recommended_sku=sku,
        headroom_pct=headroom_pct,
        notes=tuple(notes),
    )


def _smallest_sku_covering(cu: float) -> str:
    for name, sku_cu in _FSKU_TABLE:
        if sku_cu >= cu:
            return name
    return _FSKU_TABLE[-1][0]  # cap


def _norm_point(p: object) -> tuple[object | None, float | None]:
    if isinstance(p, (list, tuple)) and len(p) == 2:
        ts, val = p
        try:
            return ts, float(val) if val is not None else None
        except (TypeError, ValueError):
            return ts, None
    return None, None
