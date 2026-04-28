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
