from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class MonthlyCostRow(BaseModel):
    """One row in the monthly breakdown — combination of (month, scope, kind, SKU)."""
    month: str  # ISO yyyy-mm
    resource_kind: str  # "synapse_workspace" | "dedicated_pool" | "serverless_pool" | "spark_pool" | "storage" | "other"
    resource_name: str | None = None
    sku: str | None = None
    cost: float = 0.0
    currency: str = "USD"
    usage_quantity: float = 0.0
    usage_unit: str | None = None


class FabricCostComparison(BaseModel):
    """Side-by-side TCO delta vs. the Fabric capacity projection."""
    synapse_avg_monthly_cost: float
    fabric_capacity_sku: str | None
    fabric_estimated_monthly_cost: float | None
    delta_abs: float | None
    delta_pct: float | None
    notes: str | None = None


class CostFinding(BaseModel):
    """Severity-tagged finding emitted by the cost rules engine."""
    rule_id: str
    severity: str  # high | medium | low | info
    title: str
    detail: str | None = None
    resource: str | None = None


class CostAnalysis(BaseModel):
    workspace_name: str
    subscription_id: str
    resource_group: str
    generated_at: datetime
    window_start: datetime
    window_end: datetime
    rows: list[MonthlyCostRow] = Field(default_factory=list)
    monthly_totals: dict[str, float] = Field(default_factory=dict)  # month -> cost
    by_resource_kind: dict[str, float] = Field(default_factory=dict)
    by_resource_name: dict[str, float] = Field(default_factory=dict)  # resource_name -> cost
    fabric_comparison: FabricCostComparison | None = None
    findings: list[CostFinding] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    collection_status: str = "ok"  # ok | sdk_missing | live_disabled | empty_window | error

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
