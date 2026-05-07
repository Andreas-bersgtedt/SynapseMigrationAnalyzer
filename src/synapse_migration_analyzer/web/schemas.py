"""Pydantic schemas for the web control plane."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

ModuleState = Literal["queued", "running", "ok", "failed", "skipped", "cancelled"]
RunState = Literal["queued", "running", "ok", "failed", "cancelled"]

# The module names the API accepts. Sourced from the central analyzer
# registry so adding a new module in :mod:`..modules` automatically
# propagates here without a parallel edit.
from ..modules import KNOWN_MODULES  # re-exported below


class ModuleStatus(BaseModel):
    name: str
    state: ModuleState = "queued"
    started_at: datetime | None = None
    finished_at: datetime | None = None
    duration_ms: int | None = None
    error: str | None = None


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


class ValidateConfigResponse(BaseModel):
    ok: bool
    checks: list[ConfigCheck]


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
