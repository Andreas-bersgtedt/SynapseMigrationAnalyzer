/**
 * Display-name helpers.
 *
 * The analyzer uses snake_case identifiers internally (module names,
 * runbook phases, recommendation areas, severity / effort enums). They
 * leak through to the UI in many places and read like system identifiers.
 * These helpers translate them to title-cased, human-friendly labels
 * while leaving the raw value reachable as a `title=` tooltip when
 * callers want it.
 */

const MODULE_LABELS: Record<string, string> = {
  dedicated_pools: "Dedicated SQL pools",
  serverless_pools: "Serverless SQL pools",
  spark_pools: "Spark pools",
  pipelines: "Pipelines",
  monitoring: "Monitoring",
  storage: "Storage",
  fabric_mapping: "Fabric mapping",
  governance: "Governance",
  security: "Security",
  cost: "Cost",
  fabric_validation: "Fabric validation",
};

const PHASE_LABELS: Record<string, string> = {
  foundation: "Foundation",
  data_plane_prep: "Data plane preparation",
  ingest_shortcuts: "Ingest & shortcuts",
  compute_migration: "Compute migration",
  orchestration_migration: "Orchestration migration",
  verification: "Verification",
};

const SEVERITY_LABELS: Record<string, string> = {
  blocker: "Blocker",
  warning: "Warning",
  info: "Info",
  high: "High",
  medium: "Medium",
  low: "Low",
  incompatible: "Incompatible",
  needs_review: "Needs review",
  compatible: "Compatible",
};

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const STATE_LABELS: Record<string, string> = {
  ok: "OK",
  failed: "Failed",
  running: "Running",
  cancelled: "Cancelled",
  partial: "Partial",
  queued: "Queued",
};

/** Title-case a snake_case / kebab-case identifier as a fallback. */
function titleCase(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function moduleLabel(raw: string): string {
  return MODULE_LABELS[raw] ?? titleCase(raw);
}

export function phaseLabel(raw: string): string {
  return PHASE_LABELS[raw] ?? titleCase(raw);
}

export function severityLabel(raw: string): string {
  return SEVERITY_LABELS[raw] ?? titleCase(raw);
}

export function effortLabel(raw: string): string {
  return EFFORT_LABELS[raw] ?? titleCase(raw);
}

export function stateLabel(raw: string): string {
  return STATE_LABELS[raw] ?? titleCase(raw);
}

/**
 * Recommendation/finding "area" identifiers are dotted snake_case like
 * `dedicated_pools.tsql_surface`. Render the module half via
 * `moduleLabel` so callers get "Dedicated SQL pools \u2192 T-SQL surface".
 */
export function areaLabel(raw: string): string {
  if (!raw) return raw;
  const [head, ...rest] = raw.split(".");
  const tail = rest.join(".");
  const left = moduleLabel(head);
  if (!tail) return left;
  return `${left} \u2192 ${titleCase(tail)}`;
}
