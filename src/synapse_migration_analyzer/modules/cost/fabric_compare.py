"""Pure-Python TCO comparison: Synapse vs Fabric capacity projection."""
from __future__ import annotations

from typing import Any

from .models import FabricCostComparison


# Indicative Fabric capacity sticker prices (pay-as-you-go, monthly, USD).
# These are best-effort scaffolding values; the real numbers should come from
# the live SKU price list before this module is GA'd.
_FABRIC_MONTHLY_PRICE_USD: dict[str, float] = {
    "F2":   263.0,
    "F4":   526.0,
    "F8":  1052.0,
    "F16": 2104.0,
    "F32": 4208.0,
    "F64": 8416.0,
}


def estimate_fabric_monthly_cost(sku: str | None) -> float | None:
    if not sku:
        return None
    return _FABRIC_MONTHLY_PRICE_USD.get(sku.upper())


def compare_to_fabric(
    synapse_avg_monthly_cost: float,
    fabric_projection: dict[str, Any] | None,
) -> FabricCostComparison | None:
    """Build a :class:`FabricCostComparison` from the fabric_mapping CU projection.

    ``fabric_projection`` is the dict shape produced by
    ``fabric_mapping.cu_projection``. We tolerate missing keys.
    """
    if fabric_projection is None:
        return None
    sku = fabric_projection.get("recommended_sku") or fabric_projection.get("sku")
    fabric_cost = estimate_fabric_monthly_cost(sku)
    delta_abs: float | None = None
    delta_pct: float | None = None
    if fabric_cost is not None:
        delta_abs = fabric_cost - synapse_avg_monthly_cost
        if synapse_avg_monthly_cost:
            delta_pct = delta_abs / synapse_avg_monthly_cost
    return FabricCostComparison(
        synapse_avg_monthly_cost=synapse_avg_monthly_cost,
        fabric_capacity_sku=sku,
        fabric_estimated_monthly_cost=fabric_cost,
        delta_abs=delta_abs,
        delta_pct=delta_pct,
        notes=(
            "Sticker-price comparison only — does not include reservation discounts, "
            "F-SKU pause windows, or Synapse compute pause behavior."
        ),
    )
