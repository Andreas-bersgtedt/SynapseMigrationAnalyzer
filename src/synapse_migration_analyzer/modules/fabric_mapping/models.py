from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

Severity = Literal["info", "warning", "blocker"]
Effort = Literal["low", "medium", "high"]


class Recommendation(BaseModel):
    id: str
    area: str                              # e.g. dedicated_pools.tables
    title: str
    severity: Severity = "info"
    effort: Effort = "medium"
    target: str | None = None              # specific entity (table, pool, ...)
    detail: str
    fabric_action: str | None = None       # what the user should do in Fabric


class ModuleSummary(BaseModel):
    module: str
    source_file: str
    counts: dict[str, int] = Field(default_factory=dict)
    notes: list[str] = Field(default_factory=list)


# --- v2 -----------------------------------------------------------------------

class ReadinessSummary(BaseModel):
    score: int                              # 0..100
    bucket: str                             # ready | ready-with-effort | blocked
    counts: dict[str, int] = Field(default_factory=dict)
    top_blockers: list[Recommendation] = Field(default_factory=list)
    # T-SQL surface compatibility (computed from dedicated_pools code_objects).
    tsql_compatibility_pct: float | None = None
    tsql_objects_total: int = 0
    tsql_objects_incompatible: int = 0
    tsql_objects_needs_review: int = 0


class RunbookStep(BaseModel):
    phase: str
    order: int
    title: str
    detail: str
    severity: str
    effort: str
    target: str | None = None
    rollback: str | None = None
    source_recommendation_id: str | None = None


class CapacityProjection(BaseModel):
    peak_dwu: float
    peak_dwu_with_headroom: float
    estimated_cu: float
    recommended_sku: str
    headroom_pct: int
    notes: list[str] = Field(default_factory=list)
    # v2.6.2 — split components so the SPA can show the breakdown.
    # All three are sustained-CU contributions to ``estimated_cu`` and
    # default to 0.0 when the corresponding upstream module's data is
    # not available.
    dwu_cu_contribution: float = 0.0
    spark_cu_contribution: float = 0.0
    pipelines_cu_contribution: float = 0.0
    serverless_cu_contribution: float = 0.0
    # Pre-smoothing peak-day CU-hours for serverless SQL (sized at 0.02 CU
    # per 60 GB scanned x duration). Exposed alongside the sustained CU so
    # the SPA can surface the raw "worst day" number.
    serverless_peak_day_cu_hours: float = 0.0


class FabricMappingReport(BaseModel):
    workspace_name: str | None = None
    generated_at: datetime
    inputs: list[ModuleSummary] = Field(default_factory=list)
    recommendations: list[Recommendation] = Field(default_factory=list)
    # v2
    readiness: ReadinessSummary | None = None
    runbook: list[RunbookStep] = Field(default_factory=list)
    capacity_projection: CapacityProjection | None = None

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
