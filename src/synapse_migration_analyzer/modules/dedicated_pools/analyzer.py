"""Orchestrator for the dedicated SQL pool analysis module."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from ...config import AppConfig
from .arm_client import SynapseArmClient
from . import distribution_advisor, query_pattern_extractor, tsql_surface_gap
from .collectors import (
    collect_code_objects,
    collect_column_collations,
    collect_column_stats,
    collect_indexes,
    collect_materialized_views,
    collect_schemas,
    collect_security,
    collect_statistics,
    collect_tables,
    collect_usage,
    collect_workload_groups,
)
from .models import DistributionCandidate, PoolAnalysis, WorkspaceAnalysis
from .sql_client import DedicatedPoolSqlClient

log = logging.getLogger(__name__)


class DedicatedPoolsAnalyzer:
    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg
        self._arm = SynapseArmClient(cfg.azure)

    def run(self) -> WorkspaceAnalysis:
        result = WorkspaceAnalysis(
            workspace_name=self._cfg.azure.workspace_name,
            subscription_id=self._cfg.azure.subscription_id,
            resource_group=self._cfg.azure.resource_group,
            generated_at=datetime.now(timezone.utc),
        )

        server = self._arm.workspace_sql_endpoint()
        for inventory in self._arm.list_dedicated_pools():
            log.info("Analyzing pool: %s (DWU=%s)", inventory.name, inventory.sku_capacity)
            analysis = PoolAnalysis(inventory=inventory)

            # Skip data-plane collection if pool is paused.
            if (inventory.status or "").lower() == "paused":
                analysis.errors.append("Pool is paused; skipped DMV collection.")
                result.pools.append(analysis)
                continue

            sql = DedicatedPoolSqlClient(self._cfg, server, inventory.name)
            for label, fn, target in (
                ("schemas", collect_schemas, "schemas"),
                ("tables", collect_tables, "tables"),
                ("indexes", collect_indexes, "indexes"),
                ("usage", collect_usage, "usage"),
                ("security", collect_security, "security"),
                ("workload_groups", collect_workload_groups, "workload_groups"),
                ("code_objects", collect_code_objects, "code_objects"),
                # v2 collectors — DMVs may not be available on every host;
                # the surrounding try/except keeps the run going.
                ("column_collations", collect_column_collations, "column_collations"),
                ("materialized_views", collect_materialized_views, "materialized_views"),
                ("statistics", collect_statistics, "statistics"),
                ("column_stats", collect_column_stats, "column_stats"),
            ):
                try:
                    setattr(analysis, target, fn(sql))
                except Exception as exc:  # noqa: BLE001 - capture per-collector failures
                    log.warning("Collector '%s' failed for pool %s: %s", label, inventory.name, exc)
                    analysis.errors.append(f"{label}: {exc}")

            # Distribution-key advisor — pure-python over what we already collected.
            try:
                filter_usage = query_pattern_extractor.extract_filter_usage(
                    [c.model_dump() for c in analysis.code_objects]
                )
                analysis.distribution_candidates = [
                    DistributionCandidate(
                        schema_name=c.schema_name, table_name=c.table_name,
                        column_name=c.column_name, score=c.score, reasons=list(c.reasons),
                    )
                    for c in distribution_advisor.score_columns(
                        tables=[t.model_dump() for t in analysis.tables],
                        indexes=[i.model_dump() for i in analysis.indexes],
                        column_stats=[c.model_dump() for c in analysis.column_stats],
                        filter_usage=filter_usage,
                    )
                ]
            except Exception as exc:  # noqa: BLE001
                log.warning("Distribution advisor failed for pool %s: %s", inventory.name, exc)
                analysis.errors.append(f"distribution_advisor: {exc}")

            # T-SQL surface gap rollup — link each finding to its code object id.
            try:
                analysis.tsql_surface_gaps = tsql_surface_gap.build_gaps(analysis.code_objects)
            except Exception as exc:  # noqa: BLE001
                log.warning("T-SQL surface gap rollup failed for pool %s: %s", inventory.name, exc)
                analysis.errors.append(f"tsql_surface_gap: {exc}")

            result.pools.append(analysis)

        return result
