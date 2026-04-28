"""Tests for the Fabric capacity (CU) projection."""
from datetime import datetime, timezone

from synapse_migration_analyzer.modules.fabric_mapping import cu_projection


def _ts(h):
    return datetime(2025, 1, 1, h, 0, 0, tzinfo=timezone.utc)


def test_returns_none_with_missing_data():
    assert cu_projection.project_capacity([]) is None


def test_picks_smallest_sku_covering_peak():
    series = [
        {
            "resource_name": "p1", "metric_name": "DWUUsedPercent",
            "points": [(_ts(0), 80.0)],
        },
        {
            "resource_name": "p1", "metric_name": "DWULimit",
            "points": [(_ts(0), 1000.0)],
        },
    ]
    proj = cu_projection.project_capacity(series, headroom_pct=30)
    assert proj is not None
    # peak active DWU = 1000 * 0.8 = 800. With 30% headroom → 1040. *0.7 → 728 CU.
    assert proj.peak_dwu == 800.0
    assert proj.recommended_sku in {"F1024", "F2048"}
