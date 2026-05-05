/**
 * TypeScript types mirroring the Pydantic v2 models under
 * src/synapse_migration_analyzer/modules/<module>/models.py. We intentionally
 * declare these by hand (not auto-generated) so the front end stays decoupled
 * from any one analyzer release; missing fields are tolerated via optionals.
 *
 * When the analyzer adds a field, add it here and the table renderers will
 * pick it up. When the analyzer renames a field, treat that as a breaking
 * change and bump the SPA's expected schema version.
 */

export type Severity = "blocker" | "warning" | "info";
export type Effort = "high" | "medium" | "low";
export type Compatibility = "compatible" | "needs_review" | "incompatible";

// ---------------------------------------------------------------------------
// fabric_mapping.json
// ---------------------------------------------------------------------------

export interface Recommendation {
  id: string;
  area: string;
  title: string;
  severity: Severity;
  effort: Effort;
  target?: string | null;
  detail: string;
  fabric_action?: string | null;
}

export interface ReadinessSummary {
  score: number;
  bucket: "ready" | "ready-with-effort" | "blocked";
  counts: Partial<Record<Severity, number>>;
  top_blockers: Recommendation[];
  tsql_compatibility_pct?: number | null;
  tsql_objects_total?: number;
  tsql_objects_incompatible?: number;
  tsql_objects_needs_review?: number;
}

export interface CapacityProjection {
  peak_dwu: number;
  peak_dwu_with_headroom: number;
  estimated_cu: number;
  recommended_sku: string;
  headroom_pct: number;
  notes: string[];
}

export interface RunbookStep {
  phase: string;
  order: number;
  title: string;
  detail: string;
  severity: string;
  effort: string;
  target?: string | null;
  rollback?: string | null;
  source_recommendation_id?: string | null;
}

export interface ModuleSummary {
  module: string;
  source_file: string;
  counts: Record<string, number>;
  notes?: string[];
}

export interface FabricMappingReport {
  workspace_name?: string | null;
  generated_at: string;
  inputs: ModuleSummary[];
  recommendations: Recommendation[];
  readiness?: ReadinessSummary | null;
  runbook: RunbookStep[];
  capacity_projection?: CapacityProjection | null;
}

// ---------------------------------------------------------------------------
// dedicated_pools.json
// ---------------------------------------------------------------------------

export interface CodeObjectParameter {
  schema_name: string;
  object_name: string;
  object_type: string;
  parameter_name: string;
  data_type?: string | null;
  max_length?: number | null;
  is_output: boolean;
  has_default: boolean;
  ordinal: number;
}

export interface CodeObject {
  schema_name: string;
  object_name: string;
  object_type: string;
  definition?: string | null;
  code_object_id?: string | null;
  create_date?: string | null;
  modify_date?: string | null;
  line_count?: number | null;
  definition_length?: number | null;
  parameter_count?: number;
  parameters?: CodeObjectParameter[];
  uses_ansi_nulls?: boolean | null;
  uses_quoted_identifier?: boolean | null;
  compatibility?: Compatibility;
  gap_severities?: string[];
  gap_count?: number;
}

export interface CodeObjectSummary {
  total: number;
  by_type: Record<string, number>;
  by_compatibility: Partial<Record<Compatibility, number>>;
  compatibility_pct?: number | null;
  incompatible_object_ids: string[];
  needs_review_object_ids: string[];
}

export interface TsqlSurfaceGap {
  code_object_id: string;
  schema_name: string;
  object_name: string;
  object_type: string;
  rule_id: string;
  label: string;
  severity: string;
  matches: number;
  fabric_action?: string | null;
}

export interface PoolInventory {
  name: string;
  status?: string;
  location?: string;
  collation?: string;
}

export interface PoolAnalysis {
  inventory: PoolInventory;
  tables?: unknown[];
  schemas?: unknown[];
  code_objects?: CodeObject[];
  tsql_surface_gaps?: TsqlSurfaceGap[];
  code_object_summary?: CodeObjectSummary | null;
  errors?: string[];
}

export interface DedicatedPoolsReport {
  workspace_name?: string | null;
  generated_at: string;
  pools: PoolAnalysis[];
}

// ---------------------------------------------------------------------------
// run_delta.json (incremental / delta runs)
// ---------------------------------------------------------------------------

export interface DeltaArtifact {
  module: string;
  path: string;
  status: "added" | "removed" | "changed" | "unchanged";
  size_bytes?: number;
  sha256?: string;
  record_count?: number | null;
  record_count_delta?: number | null;
}

export interface RunDelta {
  previous_run?: string | null;
  current_run: string;
  generated_at: string;
  artifacts: DeltaArtifact[];
  notes?: string[];
}

// ---------------------------------------------------------------------------
// storage.json
// ---------------------------------------------------------------------------

export interface StorageAccountInventory {
  name: string;
  resource_id: string;
  location?: string | null;
  sku?: string | null;
  kind?: string | null;
  access_tier?: string | null;
  is_hns_enabled?: boolean | null;
  is_workspace_default?: boolean;
  default_filesystem?: string | null;
}

export interface StorageCapacity {
  account_name: string;
  captured_at: string;
  used_capacity_bytes?: number | null;
  used_capacity_gb?: number | null;
  blob_capacity_gb?: number | null;
  blob_count?: number | null;
  container_count?: number | null;
}

export interface DedicatedPoolStorage {
  pool_name: string;
  captured_at: string;
  table_count: number;
  row_count: number;
  reserved_space_mb: number;
  data_space_mb: number;
  index_space_mb: number;
  unused_space_mb: number;
  reserved_space_gb: number;
  data_space_gb: number;
  index_space_gb: number;
  max_size_gb?: number | null;
  used_pct_of_max?: number | null;
}

export interface StorageReport {
  workspace_name?: string | null;
  generated_at: string;
  accounts: StorageAccountInventory[];
  capacities: StorageCapacity[];
  dedicated_pool_storage: DedicatedPoolStorage[];
  errors?: string[];
}

// ---------------------------------------------------------------------------
// pipelines.json
// ---------------------------------------------------------------------------

export interface PipelineRunWindowStats {
  window_days: number;
  run_count: number;
  succeeded: number;
  failed: number;
  other: number;
  success_rate?: number | null;
  avg_duration_ms?: number | null;
  p95_duration_ms?: number | null;
  avg_data_moved_mb_per_run?: number | null;
  total_data_moved_mb?: number | null;
}

export interface PipelineRunStats {
  pipeline: string;
  has_data_movement: boolean;
  last_run_at?: string | null;
  last_run_status?: string | null;
  windows: PipelineRunWindowStats[];
}

export interface PipelineRunHistory {
  window_start: string;
  window_end: string;
  fetched_run_count: number;
  fetched_activity_run_count: number;
  truncated: boolean;
  by_pipeline: PipelineRunStats[];
}

export interface PipelinesReport {
  workspace_name?: string | null;
  generated_at: string;
  pipelines: Array<{ name: string; activity_count?: number }>;
  run_history?: PipelineRunHistory | null;
  errors?: string[];
}
