/**
 * Data loader.
 *
 * Two modes:
 *
 *   1. Static / "deliverable" mode (default). The SPA is served alongside
 *      JSON files (e.g. `output/webui/index.html` next to
 *      `output/fabric_mapping.json`). Loaders fetch `./fabric_mapping.json`
 *      relative to the bundle.
 *
 *   2. Control-plane mode. The SPA is served by `sma serve --with-api` and
 *      the FastAPI backend is reachable at `/api`. Loaders detect this at
 *      startup (`GET /api/healthz`) and switch to
 *      `/api/runs/<id>/modules/<module>` against the currently selected run.
 *
 * The selected run id lives in the URL hash (`#run=<id>`) so it survives
 * deep-links and refreshes.
 */
import type {
  CostReport,
  DedicatedPoolsReport,
  EstateReport,
  EstateWorkspace,
  FabricMappingReport,
  GovernanceReport,
  PipelinesReport,
  RunDelta,
  SecurityReport,
  ServerlessReport,
  SparkPoolsReport,
  StorageReport,
} from "../types";

export type ApiMode = "static" | "control-plane";
export type Health = { status: string; version: string };

let _modeProbe: Promise<ApiMode> | null = null;

export async function detectMode(): Promise<ApiMode> {
  if (_modeProbe) return _modeProbe;
  _modeProbe = (async () => {
    try {
      const r = await fetch("/api/healthz", { cache: "no-store" });
      if (r.ok) {
        const body = (await r.json()) as Health;
        if (body.status === "ok") return "control-plane" as const;
      }
    } catch {
      /* fall through */
    }
    return "static" as const;
  })();
  return _modeProbe;
}

const BASE = (import.meta.env.VITE_SMA_DATA_BASE as string | undefined) ?? "./";

function staticUrl(name: string): string {
  if (BASE.startsWith("/")) return `${BASE.replace(/\/$/, "")}/${name}`;
  return new URL(name, new URL(BASE, window.location.href)).toString();
}

export function getRunIdFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const fromHash = params.get("run");
  if (fromHash) return fromHash;
  // Fallback: React Router's <NavLink to="/code-objects"> drops the hash
  // when the user navigates between tabs, so persist the selected run in
  // sessionStorage so the data pages can still resolve it.
  try {
    return window.sessionStorage.getItem("sma:runId");
  } catch {
    return null;
  }
}

export function setRunIdInHash(runId: string | null): void {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  if (runId) params.set("run", runId);
  else params.delete("run");
  const next = params.toString();
  window.location.hash = next ? `#${next}` : "";
  try {
    if (runId) window.sessionStorage.setItem("sma:runId", runId);
    else window.sessionStorage.removeItem("sma:runId");
  } catch {
    /* sessionStorage unavailable — hash-only is fine */
  }
}

const _cache = new Map<string, Promise<unknown | null>>();

function cacheKey(mode: ApiMode, runId: string | null, name: string): string {
  return `${mode}|${runId ?? ""}|${name}`;
}

async function fetchJson<T>(name: string): Promise<T | null> {
  const mode = await detectMode();
  const runId = mode === "control-plane" ? getRunIdFromHash() : null;
  // In control-plane mode we *only* fetch via the run-id-aware endpoint.
  // If no run is selected yet, return null so the page renders an empty
  // state instead of trying ./fabric_mapping.json on the server (which
  // would 404 because the control-plane server only serves /api/* and
  // the SPA bundle).
  if (mode === "control-plane" && !runId) {
    return null;
  }
  const key = cacheKey(mode, runId, name);
  const cached = _cache.get(key);
  if (cached) return cached as Promise<T | null>;
  const promise = (async () => {
    const url =
      mode === "control-plane" && runId
        ? `/api/runs/${encodeURIComponent(runId)}/modules/${name.replace(/\.json$/, "")}`
        : staticUrl(name);
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) {
        console.warn(`[sma] ${name} not available (HTTP ${r.status} at ${url})`);
        return null;
      }
      return (await r.json()) as T;
    } catch (err) {
      console.warn(`[sma] ${name} fetch failed at ${url}:`, err);
      return null;
    }
  })();
  _cache.set(key, promise);
  return promise;
}

export function clearLoaderCache(): void {
  _cache.clear();
}

export const loadFabricMapping = () =>
  fetchJson<FabricMappingReport>("fabric_mapping.json");

export const loadDedicatedPools = () =>
  fetchJson<DedicatedPoolsReport>("dedicated_pools.json");

export const loadRunDelta = () => fetchJson<RunDelta>("run_delta.json");

export const loadStorage = () => fetchJson<StorageReport>("storage.json");

export const loadPipelines = () => fetchJson<PipelinesReport>("pipelines.json");

export const loadSparkPools = () => fetchJson<SparkPoolsReport>("spark_pools.json");

export const loadServerless = () => fetchJson<ServerlessReport>("serverless_pools.json");

export const loadCost = () => fetchJson<CostReport>("cost.json");

export const loadGovernance = () => fetchJson<GovernanceReport>("governance.json");

export const loadSecurity = () => fetchJson<SecurityReport>("security.json");

export const loadModule = <T,>(filename: string) => fetchJson<T>(filename);

// ---------------------------------------------------------------------------
// Module availability probe (powers dynamic nav tabs)
// ---------------------------------------------------------------------------

/**
 * Module slugs that map 1:1 to a JSON artefact in the run output. Used to
 * decide which top-bar tabs to show: a tab whose required module is not
 * present in the current run (static mode) or whose state isn't ok/carried
 * (control-plane mode) is hidden.
 */
const PROBE_MODULES: ReadonlyArray<string> = [
  "fabric_mapping",
  "dedicated_pools",
  "run_delta",
  "cost",
  "governance",
  "security",
  "storage",
  "pipelines",
  "spark_pools",
  "serverless_pools",
];

let _availabilityProbe: Promise<Set<string>> | null = null;

/**
 * Returns the set of module slugs that have produced data for the current
 * run. Result is cached for the lifetime of the page (the RunPicker
 * triggers a full reload when the user selects a different run, so the
 * cache lifetime matches the selected run).
 */
export async function detectAvailableModules(): Promise<Set<string>> {
  if (_availabilityProbe) return _availabilityProbe;
  _availabilityProbe = (async () => {
    const mode = await detectMode();
    const runId = mode === "control-plane" ? getRunIdFromHash() : null;
    if (mode === "control-plane") {
      if (!runId) return new Set<string>();
      try {
        const meta = await apiGetRun(runId);
        const available = new Set<string>();
        for (const m of meta.modules ?? []) {
          // Treat any state that produced output as "available". The
          // backend reports "ok" for fresh runs, "carried" for artefacts
          // inherited from a previous run, and may also report cached
          // variants. Anything else (queued/running/failed/skipped) means
          // there is no artefact for the user to drill into yet.
          const state = (m.state ?? "").toLowerCase();
          if (state === "ok" || state === "carried" || state.startsWith("ok-")) {
            available.add(m.name);
          }
        }
        return available;
      } catch {
        return new Set<string>();
      }
    }
    // Static mode: probe each known JSON in parallel. Loader cache means
    // pages re-using these loaders won't refetch.
    const probes: Array<[string, () => Promise<unknown | null>]> = [
      ["fabric_mapping", loadFabricMapping],
      ["dedicated_pools", loadDedicatedPools],
      ["run_delta", loadRunDelta],
      ["cost", loadCost],
      ["governance", loadGovernance],
      ["security", loadSecurity],
      ["storage", loadStorage],
      ["pipelines", loadPipelines],
      ["spark_pools", loadSparkPools],
      ["serverless_pools", loadServerless],
    ];
    const results = await Promise.all(
      probes.map(async ([name, fn]) => {
        try {
          return (await fn()) ? name : null;
        } catch {
          return null;
        }
      }),
    );
    return new Set(results.filter((x): x is string => x !== null));
  })();
  return _availabilityProbe;
}

// Re-export so unit tests / dev tooling can poke at the probe list.
export const _PROBE_MODULES_FOR_TESTS = PROBE_MODULES;

// ---------------------------------------------------------------------------
// Control-plane API helpers
// ---------------------------------------------------------------------------

const API_HEADERS: HeadersInit = { "Content-Type": "application/json", "X-SMA-API": "1" };

export type RunMeta = {
  id: string;
  label: string | null;
  status: "queued" | "running" | "ok" | "failed" | "cancelled";
  started_at: string;
  finished_at: string | null;
  config_hash: string;
  modules: Array<{
    name: string;
    // "carried" indicates the artefact was inherited from a prior run
    // for the same workspace identity rather than produced in this run.
    state: string;
    started_at?: string | null;
    finished_at?: string | null;
    duration_ms?: number | null;
    error?: string | null;
    progress?: {
      current: number;
      total: number;
      label?: string | null;
      message?: string | null;
    } | null;
    carried_from_run_id?: string | null;
    carried_from_started_at?: string | null;
  }>;
  readiness_score: number | null;
  errors_count: number;
  tenant_id?: string | null;
  subscription_id?: string | null;
  resource_group?: string | null;
  workspace_name?: string | null;
  /** Map module name -> source run id for carried-forward artefacts. */
  carried_from?: Record<string, string>;
};

export type AppConfig = {
  azure: {
    tenant_id: string | null;
    client_id: string | null;
    client_secret: "set" | "unset";
    subscription_id: string | null;
    resource_group: string | null;
    workspace_name: string | null;
    dedicated_pool: string | null;
  };
  sql: { odbc_driver: string; login_timeout: number; query_timeout: number };
  output_dir: string;
  env_file: string;
  env_file_exists: boolean;
};

export type ConfigCheck = { name: string; ok: boolean; detail: string | null; category?: string | null };
export type WorkspaceSummary = {
  name: string;
  resource_group: string;
  location: string | null;
  sql_endpoint: string | null;
  sql_on_demand_endpoint: string | null;
  is_current: boolean;
};
export type ValidateResponse = {
  ok: boolean;
  checks: ConfigCheck[];
  workspaces?: WorkspaceSummary[] | null;
};

export async function apiListRuns(limit = 50): Promise<RunMeta[]> {
  const r = await fetch(`/api/runs?limit=${limit}`);
  if (!r.ok) throw new Error(`/api/runs: HTTP ${r.status}`);
  return r.json() as Promise<RunMeta[]>;
}

export async function apiGetRun(id: string): Promise<RunMeta> {
  const r = await fetch(`/api/runs/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`/api/runs/${id}: HTTP ${r.status}`);
  return r.json() as Promise<RunMeta>;
}

export async function apiStartRun(modules: string[], label?: string): Promise<{ id: string }> {
  const r = await fetch("/api/runs", {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({ modules, label: label ?? null }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`POST /api/runs ${r.status}: ${detail}`);
  }
  return r.json() as Promise<{ id: string }>;
}

export async function apiCancelRun(id: string): Promise<{ cancelled: boolean }> {
  const r = await fetch(`/api/runs/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: API_HEADERS,
  });
  if (!r.ok) throw new Error(`DELETE /api/runs/${id}: HTTP ${r.status}`);
  return r.json() as Promise<{ cancelled: boolean }>;
}

export async function apiDeleteRunData(id: string): Promise<{ deleted: boolean }> {
  const r = await fetch(`/api/runs/${encodeURIComponent(id)}/data`, {
    method: "DELETE",
    headers: API_HEADERS,
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`DELETE /api/runs/${id}/data ${r.status}: ${detail}`);
  }
  return r.json() as Promise<{ deleted: boolean }>;
}

export async function apiGetConfig(): Promise<AppConfig> {
  const r = await fetch("/api/config");
  if (!r.ok) throw new Error(`/api/config: HTTP ${r.status}`);
  return r.json() as Promise<AppConfig>;
}

export async function apiPutConfig(update: unknown): Promise<{ saved_to: string; warnings: string[] }> {
  const r = await fetch("/api/config", {
    method: "PUT",
    headers: API_HEADERS,
    body: JSON.stringify(update),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`PUT /api/config ${r.status}: ${detail}`);
  }
  return r.json();
}

export async function apiValidateConfig(opts: { live?: boolean } = {}): Promise<ValidateResponse> {
  const qs = opts.live ? "?live=true" : "";
  const r = await fetch(`/api/config/validate${qs}`, { method: "POST", headers: API_HEADERS });
  if (!r.ok) throw new Error(`POST /api/config/validate: HTTP ${r.status}`);
  return r.json() as Promise<ValidateResponse>;
}

export async function apiGetDiff(runId: string, base?: string): Promise<unknown> {
  const qs = base ? `?base=${encodeURIComponent(base)}` : "";
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/diff${qs}`);
  if (!r.ok) throw new Error(`GET /api/runs/${runId}/diff: HTTP ${r.status}`);
  return r.json();
}

export async function apiGetEstate(opts: { refresh?: boolean } = {}): Promise<EstateReport> {
  const qs = opts.refresh ? "?refresh=1" : "";
  const r = await fetch(`/api/estate${qs}`);
  if (!r.ok) throw new Error(`GET /api/estate: HTTP ${r.status}`);
  return r.json() as Promise<EstateReport>;
}

export async function apiGetEstateWorkspace(key: string): Promise<EstateWorkspace> {
  const r = await fetch(`/api/estate/workspaces/${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error(`GET /api/estate/workspaces/${key}: HTTP ${r.status}`);
  return r.json() as Promise<EstateWorkspace>;
}

export function apiEstateCsvUrl(): string {
  return "/api/estate/export.csv";
}

export async function apiGetRunModule<T>(runId: string, name: string): Promise<T | null> {
  const slug = name.replace(/\.json$/, "");
  const r = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/modules/${encodeURIComponent(slug)}`,
    { cache: "no-store" },
  );
  if (!r.ok) return null;
  return r.json() as Promise<T>;
}

