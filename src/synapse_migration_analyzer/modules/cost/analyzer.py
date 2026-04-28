"""Orchestrator for the cost module (mid-term v0)."""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from ...config import AppConfig
from ...errors import format_error
from . import cost_client as _client
from . import fabric_compare
from . import rules as _rules
from .cost_client import CostClient, default_window
from .models import CostAnalysis

log = logging.getLogger(__name__)


class CostAnalyzer:
    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg
        self._cc = CostClient(cfg.azure)

    def run(self) -> CostAnalysis:
        months = int(os.getenv("SMA_COST_MONTHS", "3"))
        start, end = default_window(months=months)

        result = CostAnalysis(
            workspace_name=self._cfg.azure.workspace_name,
            subscription_id=self._cfg.azure.subscription_id,
            resource_group=self._cfg.azure.resource_group,
            generated_at=datetime.now(timezone.utc),
            window_start=start,
            window_end=end,
        )

        try:
            result.rows, result.collection_status = (
                self._cc.fetch_monthly_breakdown_with_status(start, end)
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("fetch_monthly_breakdown failed: %s", exc)
            result.errors.append(format_error("monthly_breakdown", exc))
            result.collection_status = "error"

        try:
            result.monthly_totals, result.by_resource_kind = _client.aggregate_rows(result.rows)
            result.by_resource_name = _client.aggregate_by_resource_name(result.rows)
        except Exception as exc:  # noqa: BLE001
            log.warning("aggregate_rows failed: %s", exc)
            result.errors.append(format_error("aggregate", exc))

        # Optional: compare against the Fabric CU projection from the
        # fabric_mapping module (loaded from fabric_mapping.json if present).
        try:
            avg = _client.average_monthly_cost(result.monthly_totals)
            projection = _load_fabric_projection(self._cfg.output_dir)
            result.fabric_comparison = fabric_compare.compare_to_fabric(avg, projection)
        except Exception as exc:  # noqa: BLE001
            log.warning("fabric comparison failed: %s", exc)
            result.errors.append(format_error("fabric_compare", exc))

        try:
            result.findings = _rules.evaluate(result)
        except Exception as exc:  # noqa: BLE001
            log.warning("rules.evaluate failed: %s", exc)
            result.errors.append(format_error("rules", exc))

        return result


def _load_fabric_projection(out_dir: Path) -> dict | None:
    path = Path(out_dir) / "fabric_mapping.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    return payload.get("cu_projection") or payload.get("capacity_projection")
