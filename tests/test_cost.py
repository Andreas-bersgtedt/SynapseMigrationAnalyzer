"""Unit tests for the cost module's aggregation + Fabric comparison helpers."""
from __future__ import annotations

from synapse_migration_analyzer.modules.cost.cost_client import (
    _classify_resource_id,
    _coerce_month,
    aggregate_rows,
    average_monthly_cost,
)
from synapse_migration_analyzer.modules.cost.fabric_compare import (
    compare_to_fabric,
    estimate_fabric_monthly_cost,
)
from synapse_migration_analyzer.modules.cost.models import MonthlyCostRow


def _row(month: str, kind: str, cost: float) -> MonthlyCostRow:
    return MonthlyCostRow(
        month=month, resource_kind=kind, resource_name=None,
        sku=None, cost=cost, currency="USD",
        usage_quantity=0.0, usage_unit=None,
    )


def test_aggregate_rows_sums_per_month_and_kind() -> None:
    rows = [
        _row("2026-01", "dedicated_pool", 1000.0),
        _row("2026-01", "storage", 250.0),
        _row("2026-02", "dedicated_pool", 1100.0),
    ]
    monthly, by_kind = aggregate_rows(rows)
    assert monthly == {"2026-01": 1250.0, "2026-02": 1100.0}
    assert by_kind == {"dedicated_pool": 2100.0, "storage": 250.0}


def test_average_monthly_cost_handles_empty() -> None:
    assert average_monthly_cost({}) == 0.0
    assert average_monthly_cost({"2026-01": 100.0, "2026-02": 200.0}) == 150.0


def test_coerce_month_handles_int_and_iso() -> None:
    assert _coerce_month(20260101) == "2026-01"
    assert _coerce_month("2026-02-15") == "2026-02"
    assert _coerce_month(None) == ""


def test_classify_resource_id_dedicated_pool() -> None:
    arm = ("/subscriptions/x/resourceGroups/rg/providers/Microsoft.Synapse/"
           "workspaces/ws/sqlPools/p1")
    kind, name = _classify_resource_id(arm)
    assert kind == "dedicated_pool"
    assert name == "p1"


def test_classify_resource_id_spark_pool() -> None:
    arm = ("/subscriptions/x/resourceGroups/rg/providers/Microsoft.Synapse/"
           "workspaces/ws/bigDataPools/sp1")
    kind, name = _classify_resource_id(arm)
    assert kind == "spark_pool"
    assert name == "sp1"


def test_estimate_fabric_monthly_cost_known_sku() -> None:
    assert estimate_fabric_monthly_cost("F8") == 1052.0
    assert estimate_fabric_monthly_cost("f64") == 8416.0
    assert estimate_fabric_monthly_cost(None) is None
    assert estimate_fabric_monthly_cost("F999") is None


def test_compare_to_fabric_computes_delta() -> None:
    cmp = compare_to_fabric(2000.0, {"recommended_sku": "F8"})
    assert cmp is not None
    assert cmp.fabric_estimated_monthly_cost == 1052.0
    assert cmp.delta_abs == -948.0
    assert cmp.delta_pct is not None and abs(cmp.delta_pct + 0.474) < 0.01


def test_compare_to_fabric_handles_missing_projection() -> None:
    assert compare_to_fabric(1000.0, None) is None


def test_compare_to_fabric_unknown_sku_yields_no_delta() -> None:
    cmp = compare_to_fabric(1000.0, {"recommended_sku": "F999"})
    assert cmp is not None
    assert cmp.fabric_estimated_monthly_cost is None
    assert cmp.delta_abs is None
