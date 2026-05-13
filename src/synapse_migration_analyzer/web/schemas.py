"""Pydantic schemas for the web control plane."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

# The module names the API accepts. Sourced from the central analyzer
# registry so adding a new module in :mod:`..modules` automatically
# propagates here without a parallel edit.
from ..modules import KNOWN_MODULES as KNOWN_MODULES  # re-exported

ModuleState = Literal[
    "queued", "running", "ok", "failed", "skipped", "cancelled", "carried",
]
RunState = Literal["queued", "running", "ok", "failed", "cancelled"]


class ModuleProgress(BaseModel):
    """Latest sub-step counters for a running module.

    Persisted on :class:`ModuleStatus` so the runs-history view can show
    in-flight progress without replaying the full SSE stream.
    """
    current: int = 0
    total: int = 0
    label: str | None = None
    message: str | None = None


class ModuleStatus(BaseModel):
    name: str
    state: ModuleState = "queued"
    started_at: datetime | None = None
    finished_at: datetime | None = None
    duration_ms: int | None = None
    error: str | None = None
    progress: ModuleProgress | None = None
    # When ``state == "carried"`` this is the run id whose artefact was
    # copied forward, plus the wall-clock time at which that artefact was
    # originally produced. ``None`` for modules executed by this run.
    carried_from_run_id: str | None = None
    carried_from_started_at: datetime | None = None


class RunMeta(BaseModel):
    id: str
    label: str | None = None
    status: RunState = "queued"
    started_at: datetime
    finished_at: datetime | None = None
    config_hash: str
    modules: list[ModuleStatus] = Field(default_factory=list)
    readiness_score: float | None = None
    errors_count: int = 0
    # Workspace identity captured at run-start so the Estate Overview can
    # group runs across workspaces / subscriptions / tenants without
    # re-reading every module artefact. Optional for back-compat with
    # runs created before these fields were persisted.
    tenant_id: str | None = None
    subscription_id: str | None = None
    resource_group: str | None = None
    workspace_name: str | None = None
    # Map of module name -> source run id for artefacts that were inherited
    # from a previous run (because the user did not select them in this run
    # and a prior workspace-matched run produced them). Empty for fresh runs.
    carried_from: dict[str, str] = Field(default_factory=dict)


class StartRunRequest(BaseModel):
    modules: list[str] = Field(
        ...,
        description="Module names to run, e.g. ['dedicated_pools', 'pipelines'].",
        min_length=1,
    )
    label: str | None = Field(
        None,
        description="Optional human label shown in the run history UI.",
        max_length=120,
    )


class StartRunResponse(BaseModel):
    id: str
    status: RunState


# ---------------------------------------------------------------------------
# Configuration (PR-4)
# ---------------------------------------------------------------------------


class AzureConfigPublic(BaseModel):
    tenant_id: str | None = None
    client_id: str | None = None
    client_secret: Literal["set", "unset"] = "unset"
    subscription_id: str | None = None
    resource_group: str | None = None
    workspace_name: str | None = None
    dedicated_pool: str | None = None


class SqlConfigPublic(BaseModel):
    odbc_driver: str = "ODBC Driver 18 for SQL Server"
    login_timeout: int = 30
    query_timeout: int = 120


class AppConfigPublic(BaseModel):
    azure: AzureConfigPublic
    sql: SqlConfigPublic
    output_dir: Path
    env_file: Path
    env_file_exists: bool


class AzureConfigUpdate(BaseModel):
    tenant_id: str | None = None
    client_id: str | None = None
    client_secret: str | None = Field(
        None,
        description="Write-only. When present, written through to .env. "
        "Reads always return 'set' / 'unset'.",
    )
    subscription_id: str | None = None
    resource_group: str | None = None
    workspace_name: str | None = None
    dedicated_pool: str | None = None


class SqlConfigUpdate(BaseModel):
    odbc_driver: str | None = None
    login_timeout: int | None = None
    query_timeout: int | None = None


class AppConfigUpdate(BaseModel):
    azure: AzureConfigUpdate | None = None
    sql: SqlConfigUpdate | None = None
    output_dir: Path | None = None


class ConfigCheck(BaseModel):
    name: str
    ok: bool
    detail: str | None = None
    category: str | None = None


class WorkspaceSummary(BaseModel):
    name: str
    resource_group: str
    location: str | None = None
    sql_endpoint: str | None = None
    sql_on_demand_endpoint: str | None = None
    is_current: bool = False


class ValidateConfigResponse(BaseModel):
    ok: bool
    checks: list[ConfigCheck]
    workspaces: list[WorkspaceSummary] | None = None


class SaveConfigResponse(BaseModel):
    saved_to: Path
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Diff (PR-8) – pass-through to existing run_manifest helpers
# ---------------------------------------------------------------------------


class RunDiffEnvelope(BaseModel):
    base: str
    head: str
    delta: dict[str, Any]


# ---------------------------------------------------------------------------
# Estate Overview (cross-workspace, cross-time aggregation)
# ---------------------------------------------------------------------------


class EstateHistoryPoint(BaseModel):
    """One run's contribution to a workspace's timeline."""
    run_id: str
    finished_at: datetime
    status: RunState
    readiness_score: float | None = None
    blocker_count: int = 0
    warning_count: int = 0
    actual_monthly_cost: float | None = None


class EstateWorkspace(BaseModel):
    """A single workspace as seen across all of its runs."""
    key: str
    tenant_id: str | None = None
    subscription_id: str | None = None
    resource_group: str | None = None
    workspace_name: str
    run_count: int
    latest_run_id: str
    latest_status: RunState
    latest_finished_at: datetime
    modules_run: list[str] = Field(default_factory=list)
    # Latest-run metrics
    readiness_score: float | None = None
    readiness_bucket: str | None = None
    blocker_count: int = 0
    warning_count: int = 0
    info_count: int = 0
    tsql_compatibility_pct: float | None = None
    # Capacity / forecast (fabric_mapping)
    projected_fabric_cu: float | None = None
    recommended_fabric_sku: str | None = None
    # Spend / cost (cost module)
    actual_monthly_cost: float | None = None
    actual_currency: str | None = None
    fabric_estimated_monthly_cost: float | None = None
    fabric_cost_delta_abs: float | None = None
    fabric_cost_delta_pct: float | None = None
    # Estimated migration effort (fabric_mapping.effort_summary)
    effort_hours_p50: float | None = None
    effort_hours_p90: float | None = None
    effort_days_p50: int | None = None
    effort_days_p90: int | None = None
    history: list[EstateHistoryPoint] = Field(default_factory=list)


class EstateTotals(BaseModel):
    workspaces: int = 0
    runs: int = 0
    tenants: int = 0
    subscriptions: int = 0
    ready: int = 0
    ready_with_effort: int = 0
    blocked: int = 0
    blockers_total: int = 0
    tsql_compatibility_pct_avg: float | None = None
    projected_fabric_cu_total: float | None = None
    actual_monthly_cost_total: float | None = None
    fabric_estimated_monthly_cost_total: float | None = None
    effort_hours_p50_total: float | None = None
    effort_hours_p90_total: float | None = None
    effort_days_p50_total: int | None = None
    effort_days_p90_total: int | None = None


class EstateTopBlocker(BaseModel):
    area: str
    title: str
    fabric_action: str | None = None
    effort: str = "medium"
    workspaces: int = 0
    occurrences: int = 0
    example_run_id: str | None = None


class EstateReport(BaseModel):
    generated_at: datetime
    totals: EstateTotals
    workspaces: list[EstateWorkspace] = Field(default_factory=list)
    top_blockers: list[EstateTopBlocker] = Field(default_factory=list)
