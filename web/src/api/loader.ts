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
  FabricMappingReport,
  GovernanceReport,
  PipelinesReport,
  RunDelta,
  SecurityReport,
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

export const loadCost = () => fetchJson<CostReport>("cost.json");

export const loadGovernance = () => fetchJson<GovernanceReport>("governance.json");

export const loadSecurity = () => fetchJson<SecurityReport>("security.json");

export const loadModule = <T,>(filename: string) => fetchJson<T>(filename);

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
    state: string;
    started_at?: string | null;
    finished_at?: string | null;
    duration_ms?: number | null;
    error?: string | null;
  }>;
  readiness_score: number | null;
  errors_count: number;
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

export type ConfigCheck = { name: string; ok: boolean; detail: string | null };
export type ValidateResponse = { ok: boolean; checks: ConfigCheck[] };

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

export async function apiValidateConfig(): Promise<ValidateResponse> {
  const r = await fetch("/api/config/validate", { method: "POST", headers: API_HEADERS });
  if (!r.ok) throw new Error(`POST /api/config/validate: HTTP ${r.status}`);
  return r.json() as Promise<ValidateResponse>;
}

export async function apiGetDiff(runId: string, base?: string): Promise<unknown> {
  const qs = base ? `?base=${encodeURIComponent(base)}` : "";
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/diff${qs}`);
  if (!r.ok) throw new Error(`GET /api/runs/${runId}/diff: HTTP ${r.status}`);
  return r.json();
}
