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

    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg

    def run(self) -> FabricMappingReport:
        report = FabricMappingReport(
            workspace_name=self._cfg.azure.workspace_name,
            generated_at=datetime.now(timezone.utc),
        )

        loaded: dict[str, dict[str, Any]] = {}
        for module, fname in _INPUT_FILES.items():
            path = self._cfg.output_dir / fname
            if not path.is_file():
                log.info("Skipping %s; %s not found.", module, path)
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001
                log.warning("Failed to load %s: %s", path, exc)
                report.inputs.append(ModuleSummary(
                    module=module, source_file=str(path), notes=[f"load error: {exc}"]
                ))
                continue

            loaded[module] = payload
            report.inputs.append(_summarize(module, payload, path))
            try:
                report.recommendations.extend(_RULES[module](payload))
            except Exception as exc:  # noqa: BLE001
                log.warning("Rules for %s failed: %s", module, exc)
                report.inputs[-1].notes.append(f"rules error: {exc}")

        # v2 — readiness score.
        try:
            r = readiness.score_recommendations(report.recommendations)
            report.readiness = ReadinessSummary(
                score=r.score, bucket=r.bucket, counts=r.counts,
                top_blockers=list(r.top_blockers),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("readiness scoring failed: %s", exc)

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

        # v2 — Fabric capacity projection (needs monitoring data).
        try:
            mon = loaded.get("monitoring") or {}
            proj = cu_projection.project_capacity(mon.get("series") or [])
            if proj is not None:
                report.capacity_projection = CapacityProjection(
                    peak_dwu=proj.peak_dwu,
                    peak_dwu_with_headroom=proj.peak_dwu_with_headroom,
                    estimated_cu=proj.estimated_cu,
                    recommended_sku=proj.recommended_sku,
                    headroom_pct=proj.headroom_pct,
                    notes=list(proj.notes),
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("capacity projection failed: %s", exc)

        return report
