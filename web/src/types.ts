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
  // v2.6.2 — per-component CU contribution (post-headroom). Older runs
  // serialised before this release will be missing these fields.
  dwu_cu_contribution?: number;
  spark_cu_contribution?: number;
  pipelines_cu_contribution?: number;
  // Serverless SQL contribution (heuristic 0.02 CU per 60 GB × duration).
  serverless_cu_contribution?: number;
  // Raw peak-day CU-hours for serverless SQL (pre-24h smoothing).
  serverless_peak_day_cu_hours?: number;
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
  // v2.10 — effort estimator output. Older artefacts will be missing
  // these fields (the SPA falls back to the qualitative ``effort`` label).
  effort_hours_p50?: number | null;
  effort_hours_p90?: number | null;
  effort_breakdown?: {
    area?: string | null;
    components?: string[];
    area_total_hours?: number;
    phase_share_hours?: number;
    fallback_used?: boolean;
    capped?: boolean;
  } | null;
}

export interface PhaseEffortSummary {
  phase: string;
  p50_hours: number;
  p90_hours: number;
  step_count: number;
  p50_days?: number | null;
  p90_days?: number | null;
}

export interface EffortSummary {
  total_p50_hours: number;
  total_p90_hours: number;
  total_p50_days?: number | null;
  total_p90_days?: number | null;
  per_phase: PhaseEffortSummary[];
  card_source: string;
  card_version: number;
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
  effort_summary?: EffortSummary | null;
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
  top_queries?: DedicatedTopQuery[];
  top_consumed_objects?: DedicatedTopConsumedObject[];
  errors?: string[];
}

export interface DedicatedTopQuery {
  request_id?: string | null;
  session_id?: string | null;
  status?: string | null;
  submit_time?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  total_elapsed_ms?: number | null;
  resource_class?: string | null;
  importance?: string | null;
  query_label?: string | null;
  error_id?: string | null;
  login_name?: string | null;
  command_text?: string | null;
}

/**
 * A table or view that appears frequently in recent workload SQL on a
 * dedicated SQL pool. Derived from `sys.dm_pdw_sql_requests`; counts are a
 * relative heat signal, not an absolute query count.
 */
export interface DedicatedTopConsumedObject {
  object_name: string;
  object_type: string;
  usage_count: number;
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
  // Azure-IR Data Integration Units consumed in the window (sum of
  // billableDuration[].duration entries with unit "DIUHours").
  avg_diu_hours_per_run?: number | null;
  total_diu_hours?: number | null;
  // Heuristic Fabric CU-hours equivalent (= total_diu_hours * 1.5).
  est_cu_hours_from_diu?: number | null;
  // Mapping Data Flow Spark cluster compute (vCore-hours from Azure-IR
  // billing entries with unit coreHour / vCoreHour). Projected to Fabric
  // Spark CU at 1 vCore-second = 0.5 CU-second (= total * 0.5).
  avg_vcore_hours_per_run?: number | null;
  total_vcore_hours?: number | null;
  est_cu_hours_from_vcore?: number | null;
  // Data Orchestration meter (Microsoft-published 0.0056 CU-hr per non-copy
  // activity run). Estimated as static non-copy activity count × pipeline runs.
  est_non_copy_activity_runs?: number;
  est_cu_hours_from_orchestration?: number;
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

// ---------------------------------------------------------------------------
// spark_pools.json
// ---------------------------------------------------------------------------

export interface SparkRunRecord {
  livy_id: number;
  kind: "scheduled" | "interactive";
  pool: string;
  name?: string | null;
  app_id?: string | null;
  submitter_id?: string | null;
  submitter_name?: string | null;
  artifact_id?: string | null;
  state?: string | null;
  result?: string | null;
  outcome: "succeeded" | "failed" | "in_progress";
  submitted_at?: string | null;
  ended_at?: string | null;
  duration_seconds?: number | null;
  driver_cores?: number | null;
  executor_cores?: number | null;
  num_executors?: number | null;
  total_vcores?: number | null;
  vcore_seconds?: number | null;
  vcore_hours?: number | null;
  // Fabric CU-hours = vcore_hours * 0.5 (1 CU = 2 Spark vCores).
  est_cu_hours_fabric_spark?: number | null;
}

export interface SparkRunWindowStats {
  window_days: number;
  run_count: number;
  succeeded: number;
  failed: number;
  in_progress: number;
  total_duration_hours: number;
  total_vcore_hours: number;
  est_cu_hours_fabric_spark: number;
  avg_vcore_hours_per_run?: number | null;
}

export interface SparkPoolRunStats {
  pool: string;
  kind: "scheduled" | "interactive";
  windows: SparkRunWindowStats[];
}

export interface SparkPoolsReport {
  workspace_name?: string | null;
  subscription_id?: string | null;
  resource_group?: string | null;
  generated_at: string;
  pools?: Array<{
    name: string;
    spark_version?: string | null;
    node_size?: string | null;
    node_count?: number | null;
    auto_scale_enabled?: boolean;
  }>;
  notebooks?: Array<{ name: string }>;
  spark_job_definitions?: Array<{ name: string }>;
  spark_runs?: SparkRunRecord[];
  run_stats?: SparkPoolRunStats[];
  errors?: string[];
}

// ---------------------------------------------------------------------------
// serverless_pools.json
// ---------------------------------------------------------------------------

export interface ServerlessDailyUsage {
  day: string;                  // "YYYY-MM-DD" (UTC)
  request_count: number;
  data_processed_mb: number;
  // Sum of per-query execution time for the day (seconds). Optional for
  // back-compat with pre-v2.7 artefacts.
  duration_seconds?: number;
  // SUM(data_processed_mb * duration_seconds) for the day — used by the
  // Fabric CU heuristic. Optional for back-compat.
  mb_seconds?: number;
}

export interface ServerlessCostEstimate {
  window_days: number;
  total_data_processed_tb: number;
  list_price_usd_per_tb: number;
  estimated_cost_usd: number;
  notes?: string | null;
}

export interface ServerlessTopQuery {
  request_id?: string | null;
  login_name?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  duration_seconds?: number | null;
  status?: string | null;
  error_code?: string | null;
  data_processed_mb?: number | null;
  command_text?: string | null;
}

export interface ServerlessReport {
  workspace_name?: string | null;
  endpoint_fqdn?: string | null;
  generated_at: string;
  databases?: Array<{ name: string }>;
  external_tables?: Array<unknown>;
  daily_usage?: ServerlessDailyUsage[];
  top_queries?: ServerlessTopQuery[];
  cost_estimate?: ServerlessCostEstimate | null;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// cost.json
// ---------------------------------------------------------------------------

export interface MonthlyCostRow {
  month: string;
  resource_kind: string;
  resource_name?: string | null;
  sku?: string | null;
  cost: number;
  currency: string;
  usage_quantity: number;
  usage_unit?: string | null;
}

export interface FabricCostComparison {
  synapse_avg_monthly_cost: number;
  fabric_capacity_sku?: string | null;
  fabric_estimated_monthly_cost?: number | null;
  delta_abs?: number | null;
  delta_pct?: number | null;
  notes?: string | null;
}

export interface CostFinding {
  rule_id: string;
  severity: string;
  title: string;
  detail?: string | null;
  resource?: string | null;
}

export interface CostReport {
  workspace_name: string;
  subscription_id: string;
  resource_group: string;
  generated_at: string;
  window_start: string;
  window_end: string;
  rows: MonthlyCostRow[];
  monthly_totals: Record<string, number>;
  by_resource_kind: Record<string, number>;
  by_resource_name: Record<string, number>;
  fabric_comparison?: FabricCostComparison | null;
  findings: CostFinding[];
  errors?: string[];
  collection_status: string;
}

// ---------------------------------------------------------------------------
// governance.json
// ---------------------------------------------------------------------------

export interface RoleAssignment {
  scope: string;
  scope_kind: string;
  role_name: string;
  role_definition_id: string;
  principal_id: string;
  principal_type?: string | null;
  principal_display_name?: string | null;
  assignment_id: string;
  plane?: string;
}

export interface ManagedPrivateEndpoint {
  name: string;
  target_resource_id?: string | null;
  target_resource_type?: string | null;
  group_id?: string | null;
  provisioning_state?: string | null;
  connection_state?: string | null;
  fqdns?: string[];
}

export interface CustomerManagedKey {
  resource_id: string;
  resource_kind: string;
  enabled: boolean;
  key_vault_uri?: string | null;
  key_name?: string | null;
  key_version?: string | null;
  user_assigned_identity_id?: string | null;
  notes?: string | null;
}

export interface GovernanceFinding {
  rule_id: string;
  severity: string;
  resource_id?: string | null;
  title: string;
  detail?: string | null;
}

export interface GovernanceReport {
  workspace_name: string;
  subscription_id: string;
  resource_group: string;
  generated_at: string;
  role_assignments: RoleAssignment[];
  managed_private_endpoints: ManagedPrivateEndpoint[];
  customer_managed_keys: CustomerManagedKey[];
  purview_account?: string | null;
  purview_lineage?: unknown[];
  findings: GovernanceFinding[];
  errors?: string[];
}

// ---------------------------------------------------------------------------
// security.json
// ---------------------------------------------------------------------------

export interface FirewallRule {
  resource_id: string;
  resource_kind: string;
  name: string;
  start_ip?: string | null;
  end_ip?: string | null;
  is_allow_all?: boolean;
  is_allow_azure_services?: boolean;
}

export interface WorkspaceSecuritySettings {
  workspace_name: string;
  aad_only_authentication?: boolean | null;
  public_network_access?: string | null;
  minimum_tls_version?: string | null;
  encryption_at_rest?: string | null;
  managed_vnet?: boolean | null;
  notes?: string | null;
}

export interface CredentialEntry {
  container: string;
  container_name: string;
  credential_kind: string;
  secret_reference?: string | null;
  has_inline_secret?: boolean;
  notes?: string | null;
}

export interface PoolTdeStatus {
  pool_name: string;
  resource_id: string;
  status: string;
}

export interface SecurityFinding {
  rule_id: string;
  severity: string;
  resource_id?: string | null;
  title: string;
  detail?: string | null;
}

export interface SecurityReport {
  workspace_name: string;
  subscription_id: string;
  resource_group: string;
  generated_at: string;
  workspace_settings?: WorkspaceSecuritySettings | null;
  firewall_rules: FirewallRule[];
  credentials: CredentialEntry[];
  pool_tde_status: PoolTdeStatus[];
  aad_admins: string[];
  findings: SecurityFinding[];
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Estate Overview (control-plane: GET /api/estate)
// ---------------------------------------------------------------------------

export interface EstateHistoryPoint {
  run_id: string;
  finished_at: string;
  status: 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';
  readiness_score: number | null;
  blocker_count: number;
  warning_count: number;
  actual_monthly_cost: number | null;
}

export interface EstateWorkspace {
  key: string;
  tenant_id: string | null;
  subscription_id: string | null;
  resource_group: string | null;
  workspace_name: string;
  run_count: number;
  latest_run_id: string;
  latest_status: 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';
  latest_finished_at: string;
  modules_run: string[];
  readiness_score: number | null;
  readiness_bucket: string | null;
  blocker_count: number;
  warning_count: number;
  info_count: number;
  tsql_compatibility_pct: number | null;
  projected_fabric_cu: number | null;
  recommended_fabric_sku: string | null;
  actual_monthly_cost: number | null;
  actual_currency: string | null;
  fabric_estimated_monthly_cost: number | null;
  fabric_cost_delta_abs: number | null;
  fabric_cost_delta_pct: number | null;
  effort_hours_p50: number | null;
  effort_hours_p90: number | null;
  effort_days_p50: number | null;
  effort_days_p90: number | null;
  history: EstateHistoryPoint[];
}

export interface EstateTotals {
  workspaces: number;
  runs: number;
  tenants: number;
  subscriptions: number;
  ready: number;
  ready_with_effort: number;
  blocked: number;
  blockers_total: number;
  tsql_compatibility_pct_avg: number | null;
  projected_fabric_cu_total: number | null;
  actual_monthly_cost_total: number | null;
  fabric_estimated_monthly_cost_total: number | null;
  effort_hours_p50_total: number | null;
  effort_hours_p90_total: number | null;
  effort_days_p50_total: number | null;
  effort_days_p90_total: number | null;
}

export interface EstateTopBlocker {
  area: string;
  title: string;
  fabric_action: string | null;
  effort: string;
  workspaces: number;
  occurrences: number;
  example_run_id: string | null;
}

export interface EstateReport {
  generated_at: string;
  totals: EstateTotals;
  workspaces: EstateWorkspace[];
  top_blockers: EstateTopBlocker[];
}

