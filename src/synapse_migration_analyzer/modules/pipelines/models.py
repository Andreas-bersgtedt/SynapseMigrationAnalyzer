from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

ActivitySupport = Literal["supported", "partial", "unsupported", "unknown"]


class Activity(BaseModel):
    pipeline: str
    name: str
    type: str
    depends_on: list[str] = Field(default_factory=list)
    support: ActivitySupport = "supported"
    references_pipeline: str | None = None
    references_dataset: str | None = None
    references_linked_service: str | None = None
    notes: list[str] = Field(default_factory=list)
    # v3 — richer compatibility analysis (see fabric_compat.analyze_activity)
    support_reasons: list[str] = Field(default_factory=list)
    support_caveats: list[str] = Field(default_factory=list)
    fabric_equivalent: str | None = None
    migration_action: str | None = None
    doc_url: str | None = None


class Pipeline(BaseModel):
    name: str
    folder: str | None = None
    activity_count: int = 0
    activity_types: list[str] = Field(default_factory=list)
    annotations: list[str] = Field(default_factory=list)
    unsupported_activity_count: int = 0
    partial_activity_count: int = 0


class LinkedService(BaseModel):
    name: str
    type: str
    connect_via: str | None = None  # integration runtime reference
    annotations: list[str] = Field(default_factory=list)
    fabric_supported: bool = True


class Dataset(BaseModel):
    name: str
    type: str
    linked_service: str | None = None
    folder: str | None = None


class Trigger(BaseModel):
    name: str
    type: str
    runtime_state: str | None = None
    pipelines: list[str] = Field(default_factory=list)


class IntegrationRuntime(BaseModel):
    name: str
    type: str  # Managed / SelfHosted
    description: str | None = None


# --- v2 -----------------------------------------------------------------------

class ExpressionFinding(BaseModel):
    rule_id: str
    label: str
    severity: str   # info | warning | blocker
    pipeline: str
    activity: str
    expression: str


class ScheduleMapping(BaseModel):
    trigger_name: str
    trigger_type: str
    fabric_kind: str   # recurring | tumbling | event | manual | unknown
    every_n: int | None = None
    interval: str | None = None
    days_of_week: list[str] = Field(default_factory=list)
    start_time_utc: datetime | None = None
    end_time_utc: datetime | None = None
    notes: list[str] = Field(default_factory=list)
    summary: str | None = None


class PipelinesAnalysis(BaseModel):
    workspace_name: str
    subscription_id: str
    resource_group: str
    artifacts_endpoint: str
    generated_at: datetime
    pipelines: list[Pipeline] = Field(default_factory=list)
    activities: list[Activity] = Field(default_factory=list)
    linked_services: list[LinkedService] = Field(default_factory=list)
    datasets: list[Dataset] = Field(default_factory=list)
    triggers: list[Trigger] = Field(default_factory=list)
    integration_runtimes: list[IntegrationRuntime] = Field(default_factory=list)
    # v2
    expression_findings: list[ExpressionFinding] = Field(default_factory=list)
    schedule_mappings: list[ScheduleMapping] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
