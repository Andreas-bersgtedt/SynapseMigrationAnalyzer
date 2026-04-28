"""Orchestrator for the monitoring module."""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from ...config import AppConfig
from . import dwu_hours
from .models import DwuDayStat, MonitoringAnalysis
from .monitor_client import (
    DEFAULT_AGGREGATION,
    DEFAULT_DEDICATED_POOL_METRICS,
    DEFAULT_INTERVAL,
    MonitoringClient,
    build_series,
    default_window,
)

log = logging.getLogger(__name__)


class MonitoringAnalyzer:
    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg
        self._client = MonitoringClient(cfg.azure)

    def run(self) -> MonitoringAnalysis:
        days = int(os.getenv("SMA_MONITORING_DAYS", "7"))
        interval = os.getenv("SMA_MONITORING_INTERVAL", DEFAULT_INTERVAL)
        aggregation = os.getenv("SMA_MONITORING_AGG", DEFAULT_AGGREGATION)
        start, end = default_window(days)

        result = MonitoringAnalysis(
            workspace_name=self._cfg.azure.workspace_name,
            subscription_id=self._cfg.azure.subscription_id,
            resource_group=self._cfg.azure.resource_group,
            generated_at=datetime.now(timezone.utc),
            window_start=start,
            window_end=end,
            interval=interval,
        )

        try:
            pools = self._client.list_dedicated_pool_resource_ids()
        except Exception as exc:  # noqa: BLE001
            log.warning("Failed to list dedicated pools: %s", exc)
            result.errors.append(f"list_dedicated_pools: {exc}")
            return result

        for pool_name, resource_id in pools:
            try:
                metrics = self._client.fetch_metrics(
                    resource_id,
                    DEFAULT_DEDICATED_POOL_METRICS,
                    start,
                    end,
                    interval=interval,
                    aggregation=aggregation,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("Failed to fetch metrics for pool %s: %s", pool_name, exc)
                result.errors.append(f"metrics[{pool_name}]: {exc}")
                continue
            for metric_name, unit, points in metrics:
                result.series.append(build_series(
                    resource_id=resource_id,
                    pool_name=pool_name,
                    metric_name=metric_name,
                    unit=unit,
                    aggregation=aggregation,
                    interval=interval,
                    points=points,
                ))

        # v2 — derive active DWU hours per day.
        try:
            for d in dwu_hours.derive_dwu_days(
                [s.model_dump(mode="json") for s in result.series],
                interval=interval,
            ):
                result.dwu_days.append(DwuDayStat(
                    pool_name=d.pool_name,
                    day=d.day.isoformat(),
                    active_hours=d.active_hours,
                    active_dwu_hours=d.active_dwu_hours,
                    peak_dwu=d.peak_dwu,
                    peak_pct=d.peak_pct,
                ))
        except Exception as exc:  # noqa: BLE001
            log.warning("dwu_hours derivation failed: %s", exc)
            result.errors.append(f"dwu_hours: {exc}")

        return result
