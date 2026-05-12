"""Aggregator that maps prior module outputs to Fabric Warehouse recommendations."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ...config import AppConfig
from . import cu_projection, readiness, runbook, rules
from .models import (
    CapacityProjection,
    FabricMappingReport,
    ModuleSummary,
    ReadinessSummary,
    Recommendation,
    RunbookStep,
)

log = logging.getLogger(__name__)


_INPUT_FILES: dict[str, str] = {
    "dedicated_pools": "dedicated_pools.json",
    "serverless_pools": "serverless_pools.json",
    "spark_pools": "spark_pools.json",
    "pipelines": "pipelines.json",
    "monitoring": "monitoring.json",
}

_RULES: dict[str, Callable[[dict[str, Any]], list[Recommendation]]] = {
    "dedicated_pools": rules.rules_for_dedicated_pools,
    "serverless_pools": rules.rules_for_serverless,
    "spark_pools": rules.rules_for_spark,
    "pipelines": rules.rules_for_pipelines,
    "monitoring": rules.rules_for_monitoring,
}


def _summarize(module: str, payload: dict[str, Any], path: Path) -> ModuleSummary:
    counts: dict[str, int] = {}
    for k, v in payload.items():
        if isinstance(v, list):
            counts[k] = len(v)
    return ModuleSummary(module=module, source_file=str(path), counts=counts)


class FabricMappingAnalyzer:
    """Reads JSON outputs of other modules from `cfg.output_dir` and emits a recommendation report."""

    def __init__(
        self,
        cfg: AppConfig,
        *,
        progress: "ProgressReporter | None" = None,
    ) -> None:
        from ...progress import NullProgress

        self._cfg = cfg
        self._progress = progress or NullProgress()

    def run(self) -> FabricMappingReport:
        report = FabricMappingReport(
            workspace_name=self._cfg.azure.workspace_name,
            generated_at=datetime.now(timezone.utc),
        )

        # 1 step per upstream module load + 4 rollups (readiness, tsql, runbook,
        # capacity projection).
        self._progress.start(len(_INPUT_FILES) + 4, label="loading module outputs")

        loaded: dict[str, dict[str, Any]] = {}
        for module, fname in _INPUT_FILES.items():
            path = self._cfg.output_dir / fname
            if not path.is_file():
                log.info("Skipping %s; %s not found.", module, path)
                self._progress.step(label=f"{module} (missing)")
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001
                log.warning("Failed to load %s: %s", path, exc)
                report.inputs.append(ModuleSummary(
                    module=module, source_file=str(path), notes=[f"load error: {exc}"]
                ))
                self._progress.step(label=f"{module} (error)")
                continue

            loaded[module] = payload
            report.inputs.append(_summarize(module, payload, path))
            try:
                report.recommendations.extend(_RULES[module](payload))
            except Exception as exc:  # noqa: BLE001
                log.warning("Rules for %s failed: %s", module, exc)
                report.inputs[-1].notes.append(f"rules error: {exc}")
            self._progress.step(label=module)

        # v2 — readiness score.
        try:
            r = readiness.score_recommendations(report.recommendations)
            report.readiness = ReadinessSummary(
                score=r.score, bucket=r.bucket, counts=r.counts,
                top_blockers=list(r.top_blockers),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("readiness scoring failed: %s", exc)
        self._progress.step(label="readiness")

        # v2 — T-SQL surface compatibility rollup across all dedicated pools.
        # The dedicated_pools module already classifies each code object as
        # compatible / needs_review / incompatible; here we sum across pools
        # so the executive summary can show "% T-SQL compatible".
        try:
            dp = loaded.get("dedicated_pools") or {}
            total = 0
            compatible = 0
            incompatible = 0
            needs_review = 0
            for pool in dp.get("pools") or []:
                for obj in pool.get("code_objects") or []:
                    total += 1
                    compat = obj.get("compatibility") or "compatible"
                    if compat == "compatible":
                        compatible += 1
                    elif compat == "needs_review":
                        needs_review += 1
                    elif compat == "incompatible":
                        incompatible += 1
            if total and report.readiness is not None:
                report.readiness.tsql_compatibility_pct = round(
                    compatible / total * 100, 1,
                )
                report.readiness.tsql_objects_total = total
                report.readiness.tsql_objects_incompatible = incompatible
                report.readiness.tsql_objects_needs_review = needs_review
        except Exception as exc:  # noqa: BLE001
            log.warning("T-SQL compatibility rollup failed: %s", exc)
        self._progress.step(label="tsql_rollup")

        # v2 — sequenced migration runbook.
        try:
            steps = runbook.build_runbook(report.recommendations)
            report.runbook = [
                RunbookStep(
                    phase=s.phase, order=s.order, title=s.title, detail=s.detail,
                    severity=s.severity, effort=s.effort, target=s.target,
                    rollback=s.rollback,
                    source_recommendation_id=s.source_recommendation_id,
                )
                for s in steps
            ]
        except Exception as exc:  # noqa: BLE001
            log.warning("runbook generation failed: %s", exc)
        self._progress.step(label="runbook")

        # v2 — Fabric capacity projection. Combines DW DWU peak with
        # Spark Livy + Pipelines sustained CU-hours so the recommended
        # SKU covers all three workload classes that share a Fabric
        # capacity, not just the dedicated SQL pool peak.
        try:
            mon = loaded.get("monitoring") or {}
            proj = cu_projection.project_capacity(
                mon.get("series") or [],
                spark_payload=loaded.get("spark_pools"),
                pipelines_payload=loaded.get("pipelines"),
                serverless_payload=loaded.get("serverless_pools"),
            )
            if proj is not None:
                report.capacity_projection = CapacityProjection(
                    peak_dwu=proj.peak_dwu,
                    peak_dwu_with_headroom=proj.peak_dwu_with_headroom,
                    estimated_cu=proj.estimated_cu,
                    recommended_sku=proj.recommended_sku,
                    headroom_pct=proj.headroom_pct,
                    notes=list(proj.notes),
                    dwu_cu_contribution=proj.dwu_cu_contribution,
                    spark_cu_contribution=proj.spark_cu_contribution,
                    pipelines_cu_contribution=proj.pipelines_cu_contribution,
                    serverless_cu_contribution=proj.serverless_cu_contribution,
                    serverless_peak_day_cu_hours=proj.serverless_peak_day_cu_hours,
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("capacity projection failed: %s", exc)
        self._progress.step(label="capacity_projection")

        return report
