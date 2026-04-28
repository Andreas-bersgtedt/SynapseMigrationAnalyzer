"""Cost Management / Consumption client (best-effort).

The collector is wired but kept conservative — it only issues the actual SDK
call when ``azure-mgmt-costmanagement`` is importable and live calls are not
disabled via ``SMA_COST_DISABLE_LIVE=1``. The pure-Python aggregation helpers
(``aggregate_rows``) are unit-tested against hand-built rows.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Iterable

from ...config import AzureConfig
from .models import MonthlyCostRow

log = logging.getLogger(__name__)


def _live_disabled() -> bool:
    return os.getenv("SMA_COST_DISABLE_LIVE", "").strip() in {"1", "true", "yes"}


def default_window(months: int = 3) -> tuple[datetime, datetime]:
    """Return [start, end] covering the last ``months`` *full* months + MTD."""
    now = datetime.now(timezone.utc)
    start = (now.replace(day=1) - timedelta(days=1)).replace(day=1)
    for _ in range(months - 1):
        start = (start - timedelta(days=1)).replace(day=1)
    return start, now


class CostClient:
    """Thin wrapper around ``CostManagementClient.query.usage``."""

    def __init__(self, cfg: AzureConfig) -> None:
        self._cfg = cfg

    def fetch_monthly_breakdown(
        self,
        start: datetime,
        end: datetime,
    ) -> list[MonthlyCostRow]:
        rows, _ = self.fetch_monthly_breakdown_with_status(start, end)
        return rows

    def fetch_monthly_breakdown_with_status(
        self,
        start: datetime,
        end: datetime,
    ) -> tuple[list[MonthlyCostRow], str]:
        """Return ``(rows, status)`` where status is one of
        ``ok`` | ``sdk_missing`` | ``live_disabled`` | ``empty_window`` | ``error``.
        """
        if _live_disabled():
            return [], "live_disabled"
        try:  # pragma: no cover - exercised only when SDK is installed
            from azure.identity import ClientSecretCredential
            from azure.mgmt.costmanagement import CostManagementClient
            from azure.mgmt.costmanagement.models import (
                QueryAggregation,
                QueryDataset,
                QueryDefinition,
                QueryGrouping,
                QueryTimePeriod,
            )
        except ImportError:
            log.debug("azure-mgmt-costmanagement not installed; skipping cost collect")
            return [], "sdk_missing"

        cred = ClientSecretCredential(
            tenant_id=self._cfg.tenant_id,
            client_id=self._cfg.client_id,
            client_secret=self._cfg.client_secret,
        )
        client = CostManagementClient(cred)
        scope = (
            f"/subscriptions/{self._cfg.subscription_id}"
            f"/resourceGroups/{self._cfg.resource_group}"
        )
        definition = QueryDefinition(
            type="Usage",
            timeframe="Custom",
            time_period=QueryTimePeriod(from_property=start, to=end),
            dataset=QueryDataset(
                granularity="Monthly",
                aggregation={
                    "totalCost": QueryAggregation(name="Cost", function="Sum"),
                    "usage": QueryAggregation(name="UsageQuantity", function="Sum"),
                },
                grouping=[
                    QueryGrouping(type="Dimension", name="ResourceId"),
                    QueryGrouping(type="Dimension", name="MeterCategory"),
                    QueryGrouping(type="Dimension", name="ServiceName"),
                ],
            ),
        )
        try:
            resp = client.query.usage(scope=scope, parameters=definition)
        except Exception as exc:  # noqa: BLE001
            log.warning("CostManagement query.usage failed: %s", exc)
            raise
        rows = _parse_query_response(resp)
        return rows, ("ok" if rows else "empty_window")


def _parse_query_response(resp: object) -> list[MonthlyCostRow]:
    """Convert the CostManagement query response to our normalized rows."""
    rows: list[MonthlyCostRow] = []
    columns = [c.name for c in getattr(resp, "columns", []) or []]
    for raw in getattr(resp, "rows", []) or []:
        record = dict(zip(columns, raw, strict=False))
        cost = float(record.get("totalCost") or record.get("Cost") or 0.0)
        usage = float(record.get("usage") or record.get("UsageQuantity") or 0.0)
        currency = str(record.get("Currency") or "USD")
        # The "Month" dimension is yyyymmdd-form integer when granularity=Monthly.
        month_raw = record.get("UsageDate") or record.get("BillingMonth")
        month = _coerce_month(month_raw)
        resource_id = str(record.get("ResourceId") or "")
        kind, name = _classify_resource_id(resource_id)
        rows.append(MonthlyCostRow(
            month=month,
            resource_kind=kind,
            resource_name=name,
            sku=str(record.get("ServiceName") or record.get("MeterCategory") or "") or None,
            cost=cost,
            currency=currency,
            usage_quantity=usage,
            usage_unit=record.get("UnitOfMeasure"),
        ))
    return rows


def _coerce_month(raw: object) -> str:
    if raw is None:
        return ""
    s = str(raw)
    # 20260101 -> 2026-01
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}"
    if len(s) >= 7 and s[4] == "-":
        return s[:7]
    return s


def _classify_resource_id(arm_id: str) -> tuple[str, str | None]:
    s = (arm_id or "").lower()
    if "/providers/microsoft.synapse/workspaces/" in s and "/sqlpools/" in s:
        return "dedicated_pool", arm_id.rsplit("/", 1)[-1]
    if "/providers/microsoft.synapse/workspaces/" in s and "/bigdatapools/" in s:
        return "spark_pool", arm_id.rsplit("/", 1)[-1]
    if "/providers/microsoft.synapse/workspaces/" in s:
        return "synapse_workspace", arm_id.rsplit("/", 1)[-1]
    if "/providers/microsoft.storage/storageaccounts/" in s:
        return "storage", arm_id.rsplit("/", 1)[-1]
    return "other", arm_id.rsplit("/", 1)[-1] if arm_id else None


# -- Pure-Python aggregation (unit tested) -------------------------------------

def aggregate_rows(rows: Iterable[MonthlyCostRow]) -> tuple[dict[str, float], dict[str, float]]:
    """Return ``(monthly_totals, by_resource_kind)``."""
    monthly: dict[str, float] = {}
    by_kind: dict[str, float] = {}
    for r in rows:
        monthly[r.month] = monthly.get(r.month, 0.0) + r.cost
        by_kind[r.resource_kind] = by_kind.get(r.resource_kind, 0.0) + r.cost
    return monthly, by_kind


def aggregate_by_resource_name(rows: Iterable[MonthlyCostRow]) -> dict[str, float]:
    """Return cost grouped by resource_name (skipping rows that have none)."""
    by_name: dict[str, float] = {}
    for r in rows:
        if not r.resource_name:
            continue
        by_name[r.resource_name] = by_name.get(r.resource_name, 0.0) + r.cost
    return by_name


def average_monthly_cost(monthly_totals: dict[str, float]) -> float:
    if not monthly_totals:
        return 0.0
    return sum(monthly_totals.values()) / len(monthly_totals)
