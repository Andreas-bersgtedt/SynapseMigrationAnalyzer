"""Orchestrator for the dedicated SQL pool analysis module."""
from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from ...config import AppConfig
from ...progress import NullProgress, ProgressReporter
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
    collect_top_consumed_objects,
    collect_top_queries,
    collect_usage,
    collect_workload_groups,
)
from .models import DistributionCandidate, PoolAnalysis, WorkspaceAnalysis
from .sql_client import DedicatedPoolSqlClient

log = logging.getLogger(__name__)


def _pool_concurrency() -> int:
    """How many dedicated pools to analyze in parallel.

    Defaults to 4. Each worker opens its own pyodbc connection — keep the
    number modest to avoid hammering the AAD endpoint.
    """
    try:
        return max(1, int(os.getenv("SMA_DEDICATED_POOL_CONCURRENCY", "4")))
    except ValueError:
        return 4


class DedicatedPoolsAnalyzer:
    def __init__(
        self,
        cfg: AppConfig,
        *,
        progress: ProgressReporter | None = None,
    ) -> None:
        self._cfg = cfg
        self._arm = SynapseArmClient(cfg.azure)
        self._progress = progress or NullProgress()

    def run(self) -> WorkspaceAnalysis:
        result = WorkspaceAnalysis(
            workspace_name=self._cfg.azure.workspace_name,
            subscription_id=self._cfg.azure.subscription_id,
            resource_group=self._cfg.azure.resource_group,
            generated_at=datetime.now(timezone.utc),
        )

        server = self._arm.workspace_sql_endpoint()
        inventories = list(self._arm.list_dedicated_pools())
        if not inventories:
            self._progress.start(0, label="no pools")
            return result

        # 13 collectors + advisor + tsql gap rollup = 15 sub-steps per pool.
        self._progress.start(len(inventories) * 15, label=f"{len(inventories)} pool(s)")

        max_workers = min(len(inventories), _pool_concurrency())
        if max_workers <= 1:
            result.pools = [self._analyze_pool(server, inv) for inv in inventories]
        else:
            log.info("Analyzing %d dedicated pool(s) with concurrency=%d",
                     len(inventories), max_workers)
            with ThreadPoolExecutor(max_workers=max_workers,
                                    thread_name_prefix="sma-ded-pool") as ex:
                result.pools = list(ex.map(
                    lambda inv: self._analyze_pool(server, inv), inventories
                ))
        return result

    def _analyze_pool(self, server: str, inventory) -> PoolAnalysis:
        log.info("Analyzing pool: %s (DWU=%s)", inventory.name, inventory.sku_capacity)
        analysis = PoolAnalysis(inventory=inventory)
        pool_name = inventory.name

        # Skip data-plane collection if pool is paused.
        if (inventory.status or "").lower() == "paused":
            analysis.errors.append("Pool is paused; skipped DMV collection.")
            # Still consume the 15 budgeted steps so totals stay accurate.
            self._progress.step(15, label=f"{pool_name} (paused)")
            return analysis

        sql = DedicatedPoolSqlClient(self._cfg, server, inventory.name)
        # One persistent connection for all DMV queries on this pool.
        with sql.session():
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
                ("top_queries", collect_top_queries, "top_queries"),
                ("top_consumed_objects", collect_top_consumed_objects, "top_consumed_objects"),
            ):
                try:
                    setattr(analysis, target, fn(sql))
                except Exception as exc:  # noqa: BLE001 - capture per-collector failures
                    log.warning("Collector '%s' failed for pool %s: %s", label, inventory.name, exc)
                    analysis.errors.append(f"{label}: {exc}")
                finally:
                    self._progress.step(label=f"{pool_name}/{label}")

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
        finally:
            self._progress.step(label=f"{pool_name}/distribution_advisor")

        # T-SQL surface gap rollup -- link each finding to its code object id,
        # then stamp per-object compatibility + build the per-pool summary.
        try:
            analysis.tsql_surface_gaps = tsql_surface_gap.build_gaps(analysis.code_objects)
            tsql_surface_gap.stamp_compatibility(
                analysis.code_objects, analysis.tsql_surface_gaps,
            )
            analysis.code_object_summary = tsql_surface_gap.summarize_code_objects(
                analysis.code_objects,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("T-SQL surface gap rollup failed for pool %s: %s", inventory.name, exc)
            analysis.errors.append(f"tsql_surface_gap: {exc}")
        finally:
            self._progress.step(label=f"{pool_name}/tsql_surface_gap")

        return analysis
