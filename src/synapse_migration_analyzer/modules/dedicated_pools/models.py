"""Pydantic models describing the analyzer output."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class PoolInventory(BaseModel):
    name: str
    location: str
    sku_name: str | None = None
    sku_capacity: int | None = None  # DWU
    status: str | None = None
    create_date: datetime | None = None
    storage_account_type: str | None = None
    collation: str | None = None
    max_size_bytes: int | None = None
    tags: dict[str, str] = Field(default_factory=dict)


class SchemaInfo(BaseModel):
    schema_name: str
    object_count: int = 0


class TableInfo(BaseModel):
    schema_name: str
    table_name: str
    distribution_policy: str | None = None  # HASH / ROUND_ROBIN / REPLICATE
    distribution_column: str | None = None
    is_partitioned: bool = False
    partition_count: int = 0
    row_count: int | None = None
    reserved_space_mb: float | None = None
    data_space_mb: float | None = None
    index_space_mb: float | None = None
    index_type: str | None = None  # CCI, HEAP, CI


class IndexInfo(BaseModel):
    schema_name: str
    table_name: str
    index_name: str | None = None
    index_type: str
    is_unique: bool = False
    is_primary_key: bool = False
    # v2: leading key column (populated when sys.index_columns is queryable).
    first_key_column: str | None = None


class UsageStat(BaseModel):
    metric: str
    value: float | int | str | None
    unit: str | None = None
    captured_at: datetime | None = None


class SecurityPrincipal(BaseModel):
    name: str
    type: str  # SQL_USER, AAD_USER, AAD_GROUP, ROLE, etc.
    role_memberships: list[str] = Field(default_factory=list)


class WorkloadGroup(BaseModel):
    name: str
    classifier_count: int = 0
    importance: str | None = None
    min_resource_pct: float | None = None
    cap_resource_pct: float | None = None
    request_min_resource_grant_pct: float | None = None


class CodeObject(BaseModel):
    schema_name: str
    object_name: str
    object_type: str  # SQL_STORED_PROCEDURE / VIEW / SQL_SCALAR_FUNCTION / SQL_INLINE_TABLE_VALUED_FUNCTION / SQL_TABLE_VALUED_FUNCTION
    definition: str | None = None
    # v2: stable identifier for cross-run diffs and per-object gap rollups.
    code_object_id: str | None = None


# --- v2 -----------------------------------------------------------------------

class ColumnCollation(BaseModel):
    schema_name: str
    table_name: str
    column_name: str
    data_type: str | None = None
    max_length: int | None = None
    collation_name: str | None = None
    db_collation: str | None = None
    differs_from_db: bool = False


class MaterializedView(BaseModel):
    schema_name: str
    view_name: str
    create_date: datetime | None = None
    modify_date: datetime | None = None
    definition: str | None = None


class StatisticInfo(BaseModel):
    schema_name: str
    table_name: str
    stat_name: str
    user_created: bool = False
    auto_created: bool = False
    last_updated: datetime | None = None
    rows: int | None = None
    rows_sampled: int | None = None
    modification_counter: int | None = None
    days_since_update: int | None = None


class ColumnStat(BaseModel):
    schema_name: str
    table_name: str
    column_name: str
    data_type: str | None = None
    max_length: int | None = None
    is_nullable: bool = True
    row_count: int | None = None
    distinct_count: int | None = None
    null_count: int | None = None
    max_frequency: int | None = None


class DistributionCandidate(BaseModel):
    """Output of :mod:`distribution_advisor` per (schema, table)."""
    schema_name: str
    table_name: str
    column_name: str
    score: int
    reasons: list[str] = Field(default_factory=list)


class TsqlSurfaceGap(BaseModel):
    """One T-SQL surface finding linked back to its code object via stable id."""
    code_object_id: str
    schema_name: str
    object_name: str
    object_type: str
    rule_id: str
    label: str
    severity: str
    matches: int = 0
    fabric_action: str | None = None


class PoolAnalysis(BaseModel):
    inventory: PoolInventory
    schemas: list[SchemaInfo] = Field(default_factory=list)
    tables: list[TableInfo] = Field(default_factory=list)
    indexes: list[IndexInfo] = Field(default_factory=list)
    usage: list[UsageStat] = Field(default_factory=list)
    security: list[SecurityPrincipal] = Field(default_factory=list)
    workload_groups: list[WorkloadGroup] = Field(default_factory=list)
    code_objects: list[CodeObject] = Field(default_factory=list)
    # v2 additions (all default to empty so existing tests + reports still work).
    column_collations: list[ColumnCollation] = Field(default_factory=list)
    materialized_views: list[MaterializedView] = Field(default_factory=list)
    statistics: list[StatisticInfo] = Field(default_factory=list)
    column_stats: list[ColumnStat] = Field(default_factory=list)
    distribution_candidates: list[DistributionCandidate] = Field(default_factory=list)
    tsql_surface_gaps: list[TsqlSurfaceGap] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class WorkspaceAnalysis(BaseModel):
    workspace_name: str
    subscription_id: str
    resource_group: str
    generated_at: datetime
    pools: list[PoolAnalysis] = Field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
