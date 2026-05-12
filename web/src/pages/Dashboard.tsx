import { loadFabricMapping, loadPipelines, loadServerless, loadSparkPools, loadStorage, detectMode, getRunIdFromHash } from "../api/loader";
import { useAsync } from "../hooks/useAsync";
import { Empty, PctPill, ScorePill, SeverityPill, StatCard } from "../components/Atoms";
import HelpLink from "../components/HelpLink";
import { ProvenanceBadge, useCurrentRunMeta } from "../components/Provenance";
import { areaLabel, effortLabel, moduleLabel } from "../lib/labels";
import type { Recommendation, Severity, ModuleSummary } from "../types";

function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtBytesGb(gb: number | null | undefined): string {
  if (gb == null || !Number.isFinite(gb)) return "—";
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(gb * 1024).toFixed(0)} MB`;
}

function fmtMb(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return "—";
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(2)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 10) return `${mb.toFixed(0)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  if (mb > 0) return `${mb.toFixed(2)} MB`;
  return `0 MB`;
}

/**
 * Renders a one-line banner under the workspace title when one or more
 * module artefacts on the current run were carried forward from a prior
 * workspace-matched run. Silent in static mode and when nothing was
 * carried, so it never adds noise to a "clean" full run.
 */
function CarryForwardBanner({ runMeta }: { runMeta: import("../api/loader").RunMeta | null }) {
  if (!runMeta) return null;
  const carried = (runMeta.modules ?? []).filter((m) => m.state === "carried");
  if (carried.length === 0) return null;
  const refreshed = (runMeta.modules ?? [])
    .filter((m) => m.state !== "carried" && m.state !== "queued")
    .map((m) => m.name);
  return (
    <div
      className="muted small"
      style={{
        marginBottom: 16,
        padding: "6px 10px",
        borderLeft: "3px solid #888",
        background: "rgba(127,127,127,0.08)",
      }}
    >
      ↺ Incremental run — refreshed{" "}
      <strong>{refreshed.length > 0 ? refreshed.join(", ") : "(none)"}</strong>;
      carried <strong>{carried.length}</strong> module{carried.length === 1 ? "" : "s"} forward
      from prior run(s) (look for the <em>carried</em> pill on each section header).
    </div>
  );
}

export default function Dashboard() {
  const { data: fm, loading: fmLoading } = useAsync(loadFabricMapping);
  const { data: storage, loading: storageLoading } = useAsync(loadStorage);
  const { data: pipelines, loading: pipelinesLoading } = useAsync(loadPipelines);
  const { data: serverless, loading: serverlessLoading } = useAsync(loadServerless);
  const { data: sparkPools, loading: sparkLoading } = useAsync(loadSparkPools);
  const { data: mode } = useAsync(detectMode);
  const runMeta = useCurrentRunMeta();

  const loading =
    fmLoading || storageLoading || pipelinesLoading || serverlessLoading || sparkLoading;
  if (loading) return <div className="empty">Loading…</div>;

  // Has *any* module produced data? If so, render the dashboard with the
  // sections that exist instead of bailing out because fabric_mapping.json
  // is missing — e.g. when only the `spark_pools` module ran, we still want
  // to show the Spark section instead of a hard error.
  const hasAny = Boolean(
    fm
      || (storage && (storage.dedicated_pool_storage?.length || storage.accounts?.length || storage.capacities?.length))
      || (pipelines?.run_history && pipelines.run_history.by_pipeline?.length)
      || (sparkPools && (sparkPools.pools?.length || sparkPools.run_stats?.length || sparkPools.spark_runs?.length))
      || (serverless && (serverless.databases?.length || serverless.daily_usage?.length))
  );

  if (!hasAny) {
    if (mode === "control-plane") {
      const runId = getRunIdFromHash();
      if (!runId) {
        return (
          <Empty>
            No run selected. Pick one from the run picker in the top bar,
            or kick off a new analyzer run from the <code>Run</code> page.
          </Empty>
        );
      }
      return (
        <Empty>
          No module output available for run <code>{runId}</code> yet.
          The run may still be in progress, no modules were selected, or
          the run failed before producing any artifacts. See the{" "}
          <code>Runs</code> page for status.
        </Empty>
      );
    }
    return (
      <Empty>
        No analyzer output found. Run <code>sma analyze-all</code> (or a
        specific module like <code>sma analyze-spark-pools</code>) first,
        then point the SPA at the output directory (see{" "}
        <code>web/README.md</code>).
      </Empty>
    );
  }

  const rd = fm?.readiness ?? null;
  const cp = fm?.capacity_projection ?? null;
  const sevCount = (s: Severity) =>
    rd?.counts?.[s] ?? (fm?.recommendations.filter((r: Recommendation) => r.severity === s).length ?? 0);

  // Steady-state CU from pipeline integration activity (DIU-hr + Orch CU-hr).
  // 1 CU sustained = 24 CU-hr / day, so daily_CU = (Σ est CU-hr ÷ window_days) ÷ 24.
  const integrationDailyCu = (() => {
    const hist = pipelines?.run_history;
    if (!hist || !hist.by_pipeline?.length) return 0;
    let totalCuHr = 0;
    let window = 0;
    for (const p of hist.by_pipeline) {
      const w = p.windows.find((w) => w.window_days === 7) ?? p.windows[0];
      if (!w) continue;
      totalCuHr += w.est_cu_hours_from_diu ?? 0;
      totalCuHr += w.est_cu_hours_from_vcore ?? 0;
      totalCuHr += w.est_cu_hours_from_orchestration ?? 0;
      window = w.window_days;
    }
    if (window <= 0) return 0;
    return (totalCuHr / window) / 24;
  })();

  // Steady-state CU from Spark Livy job history (notebook sessions + scheduled
  // batches). vCore-hours are already converted to Fabric CU-hours by the
  // analyzer using the documented 1 CU = 2 Spark vCores rate, so we just sum
  // the per-pool / per-kind 7-day window totals.
  const sparkDailyCu = (() => {
    const stats = sparkPools?.run_stats;
    if (!stats || stats.length === 0) return 0;
    let totalCuHr = 0;
    let window = 0;
    for (const s of stats) {
      const w = s.windows.find((w) => w.window_days === 7) ?? s.windows[0];
      if (!w) continue;
      totalCuHr += w.est_cu_hours_fabric_spark ?? 0;
      window = w.window_days;
    }
    if (window <= 0) return 0;
    return (totalCuHr / window) / 24;
  })();

  return (
    <>
      <h1 style={{ margin: "0 0 4px" }}>
        {fm?.workspace_name ?? "(workspace)"} <HelpLink slug="04-dashboard" />
      </h1>
      <div className="muted small" style={{ marginBottom: 16 }}>
        {fm
          ? `Generated ${new Date(fm.generated_at).toLocaleString()}`
          : "Partial run — fabric_mapping module did not run, showing available sections."}
      </div>
      <CarryForwardBanner runMeta={runMeta} />

      {fm && (
        <div className="grid cols-4">
        <StatCard
          label="Readiness score"
          value={rd ? <ScorePill score={rd.score} /> : "—"}
          sub={rd?.bucket}
        />
        <StatCard
          label="T-SQL compatible"
          value={<PctPill pct={rd?.tsql_compatibility_pct} />}
          sub={
            rd?.tsql_objects_total
              ? `${rd.tsql_objects_total} objects · ${rd.tsql_objects_incompatible ?? 0} incompatible · ${rd.tsql_objects_needs_review ?? 0} needs review`
              : "no code objects collected"
          }
        />
        <StatCard
          label="Recommendations"
          value={fm.recommendations.length}
          sub={
            <>
              <span className="pill err">{sevCount("blocker")}</span>{" "}
              <span className="pill warn">{sevCount("warning")}</span>{" "}
              <span className="pill info">{sevCount("info")}</span>
            </>
          }
        />
        <StatCard
          label="Recommended SKU"
          value={cp?.recommended_sku ?? "—"}
          sub={
            cp
              ? (() => {
                  // v2.6.2 — backend now includes Spark + Pipelines CU
                  // in estimated_cu. Show the breakdown when available.
                  // Adaptive precision: contributions can be sub-CU for
                  // light workloads (esp. serverless), so we keep 2–3 dp
                  // when they would otherwise round to 0.0.
                  const fmtCu = (v: number) => {
                    if (v >= 1) return v.toFixed(1);
                    if (v >= 0.1) return v.toFixed(2);
                    if (v >= 0.01) return v.toFixed(3);
                    if (v > 0) return "<0.01";
                    return v.toFixed(1);
                  };
                  const dwuCu = cp.dwu_cu_contribution ?? 0;
                  const sparkCu = cp.spark_cu_contribution ?? 0;
                  const pipeCu = cp.pipelines_cu_contribution ?? 0;
                  const slessCu = cp.serverless_cu_contribution ?? 0;
                  const slessPeakDayCuH = cp.serverless_peak_day_cu_hours ?? 0;
                  const parts: string[] = [];
                  if (dwuCu > 0) parts.push(`DW ${fmtCu(dwuCu)}`);
                  if (sparkCu > 0) parts.push(`Spark ${fmtCu(sparkCu)}`);
                  if (pipeCu > 0) parts.push(`Pipelines ${fmtCu(pipeCu)}`);
                  if (slessCu > 0) parts.push(`Serverless ${fmtCu(slessCu)}`);
                  const breakdown = parts.length > 0 ? ` · ${parts.join(" + ")} CU` : "";
                  const slessNote = slessPeakDayCuH > 0
                    ? ` · Serverless peak day ≈ ${slessPeakDayCuH.toFixed(2)} CU-h (smoothed over 24 h)`
                    : "";
                  return `${cp.estimated_cu.toFixed(1)} CU (${cp.headroom_pct}% headroom)${breakdown}${slessNote}`;
                })()
              : integrationDailyCu > 0 || sparkDailyCu > 0
                ? `no monitoring data${
                    integrationDailyCu > 0
                      ? ` · ${integrationDailyCu.toFixed(2)} CU/day from pipelines`
                      : ""
                  }${
                    sparkDailyCu > 0
                      ? ` · ${sparkDailyCu.toFixed(2)} CU/day from Spark`
                      : ""
                  }`
                : "no monitoring data"
          }
        />
      </div>
      )}

      {rd?.top_blockers && rd.top_blockers.length > 0 && (
        <section className="section">
          <h2>Top blockers</h2>
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Effort</th>
                <th>Area</th>
                <th>Title</th>
                <th>Fabric action</th>
              </tr>
            </thead>
            <tbody>
              {rd.top_blockers.map((b: Recommendation) => (
                <tr key={b.id}>
                  <td><SeverityPill severity={b.severity} /></td>
                  <td title={b.effort}>{effortLabel(b.effort)}</td>
                  <td className="small" title={b.area}>{areaLabel(b.area)}</td>
                  <td>{b.title}</td>
                  <td className="small muted">{b.fabric_action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <StorageSection storage={storage} runMeta={runMeta} />
      <PipelinesSection pipelines={pipelines} runMeta={runMeta} />
      <SparkPoolsSection sparkPools={sparkPools} runMeta={runMeta} />
      <ServerlessSection serverless={serverless} runMeta={runMeta} />

      {fm && (
        <section className="section">
          <h2>Inputs analyzed</h2>
          <table>
            <thead>
              <tr><th>Module</th><th>Source</th><th>Counts</th></tr>
            </thead>
            <tbody>
              {fm.inputs.map((i: ModuleSummary) => (
                <tr key={i.module}>
                  <td title={i.module}>{moduleLabel(i.module)}</td>
                  <td className="small muted">{i.source_file}</td>
                  <td className="small">
                    {Object.entries(i.counts || {})
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([k, v]) => `${k}=${v}`)
                      .join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Storage statistics
// ---------------------------------------------------------------------------

function StorageSection({ storage, runMeta }: { storage: import("../types").StorageReport | null; runMeta?: import("../api/loader").RunMeta | null }) {
  if (!storage) return null;
  const pools = storage.dedicated_pool_storage ?? [];
  const accounts = storage.accounts ?? [];
  const capacities = storage.capacities ?? [];
  if (pools.length === 0 && accounts.length === 0 && capacities.length === 0) return null;

  const poolReservedGb = pools.reduce((s, p) => s + (p.reserved_space_gb ?? 0), 0);
  const poolDataGb = pools.reduce((s, p) => s + (p.data_space_gb ?? 0), 0);
  const poolIndexGb = pools.reduce((s, p) => s + (p.index_space_gb ?? 0), 0);
  const totalRows = pools.reduce((s, p) => s + (p.row_count ?? 0), 0);
  const totalTables = pools.reduce((s, p) => s + (p.table_count ?? 0), 0);
  const adlsUsedGb = capacities.reduce((s, c) => s + (c.used_capacity_gb ?? 0), 0);
  const adlsBlobs = capacities.reduce((s, c) => s + (c.blob_count ?? 0), 0);

  return (
    <section className="section">
      <h2>Storage<ProvenanceBadge meta={runMeta ?? null} module="storage" /></h2>
      <div className="grid cols-4">
        <StatCard
          label="Dedicated pool data"
          value={fmtBytesGb(poolDataGb)}
          sub={`${fmtNum(totalTables)} tables · ${fmtNum(totalRows)} rows`}
        />
        <StatCard
          label="Dedicated pool indexes"
          value={fmtBytesGb(poolIndexGb)}
          sub={`reserved ${fmtBytesGb(poolReservedGb)}`}
        />
        <StatCard
          label="ADLS used"
          value={accounts.length ? fmtBytesGb(adlsUsedGb) : "—"}
          sub={
            accounts.length
              ? `${accounts.length} account${accounts.length === 1 ? "" : "s"} · ${fmtNum(adlsBlobs)} blobs`
              : "no storage accounts discovered"
          }
        />
        <StatCard
          label="Storage accounts"
          value={accounts.length}
          sub={accounts.find((a) => a.is_workspace_default)?.name ?? "no workspace default"}
        />
      </div>

      {pools.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Pool</th>
              <th className="num">Tables</th>
              <th className="num">Rows</th>
              <th className="num">Data</th>
              <th className="num">Indexes</th>
              <th className="num">Reserved</th>
              <th className="num">% of max</th>
            </tr>
          </thead>
          <tbody>
            {pools.map((p) => (
              <tr key={p.pool_name}>
                <td><code>{p.pool_name}</code></td>
                <td className="num">{fmtNum(p.table_count)}</td>
                <td className="num">{fmtNum(p.row_count)}</td>
                <td className="num">{fmtBytesGb(p.data_space_gb)}</td>
                <td className="num">{fmtBytesGb(p.index_space_gb)}</td>
                <td className="num">{fmtBytesGb(p.reserved_space_gb)}</td>
                <td className="num">{p.used_pct_of_max != null ? `${p.used_pct_of_max.toFixed(2)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pipeline activity (daily run rate, data movement)
// ---------------------------------------------------------------------------

function PipelinesSection({ pipelines, runMeta }: { pipelines: import("../types").PipelinesReport | null; runMeta?: import("../api/loader").RunMeta | null }) {
  if (!pipelines) return null;
  const history = pipelines.run_history;
  if (!history || history.by_pipeline.length === 0) return null;

  // Prefer the 7-day window for "daily" stats; fall back to the shortest window.
  const stats = history.by_pipeline.map((p) => {
    const w = p.windows.find((w) => w.window_days === 7) ?? p.windows[0];
    return { pipeline: p.pipeline, has_data_movement: p.has_data_movement, last: p.last_run_at, lastStatus: p.last_run_status, w };
  }).filter((r) => r.w != null);

  const window = stats[0]?.w?.window_days ?? 7;
  const totalRuns = stats.reduce((s, r) => s + (r.w?.run_count ?? 0), 0);
  const totalSucceeded = stats.reduce((s, r) => s + (r.w?.succeeded ?? 0), 0);
  const totalFailed = stats.reduce((s, r) => s + (r.w?.failed ?? 0), 0);
  const totalDataMb = stats.reduce((s, r) => s + (r.w?.total_data_moved_mb ?? 0), 0);
  const totalDiuHours = stats.reduce((s, r) => s + (r.w?.total_diu_hours ?? 0), 0);
  const totalCuHoursDm = stats.reduce((s, r) => s + (r.w?.est_cu_hours_from_diu ?? 0), 0);
  const totalVcoreHours = stats.reduce((s, r) => s + (r.w?.total_vcore_hours ?? 0), 0);
  const totalCuHoursDf = stats.reduce((s, r) => s + (r.w?.est_cu_hours_from_vcore ?? 0), 0);
  const totalCuHoursOrch = stats.reduce((s, r) => s + (r.w?.est_cu_hours_from_orchestration ?? 0), 0);
  const totalNonCopyRuns = stats.reduce((s, r) => s + (r.w?.est_non_copy_activity_runs ?? 0), 0);
  const totalCuHours = totalCuHoursDm + totalCuHoursDf + totalCuHoursOrch;
  const dataMovingPipelines = stats.filter((r) => r.has_data_movement && (r.w?.total_data_moved_mb ?? 0) > 0).length;
  const dataFlowPipelines = stats.filter((r) => (r.w?.total_vcore_hours ?? 0) > 0).length;
  const dailyRuns = totalRuns / window;
  const dailyDataMb = totalDataMb / window;
  // Convert avg daily CU-hours into a steady-state CU equivalent
  // (1 CU sustained = 24 CU-hr / day, so daily_CU = daily_CU-hr / 24).
  const dailyCuHours = window > 0 ? totalCuHours / window : 0;
  const dailyCuEquivalent = dailyCuHours / 24;
  const successRate = totalSucceeded + totalFailed > 0
    ? (totalSucceeded / (totalSucceeded + totalFailed)) * 100
    : null;

  // Top pipelines by daily activity.
  const top = [...stats]
    .sort((a, b) => (b.w!.run_count - a.w!.run_count))
    .slice(0, 10);

  return (
    <section className="section">
      <h2>Pipeline activity (last {window} days)<ProvenanceBadge meta={runMeta ?? null} module="pipelines" /></h2>
      <div className="grid cols-5">
        <StatCard
          label="Daily pipeline runs"
          value={dailyRuns.toFixed(1)}
          sub={`${fmtNum(totalRuns)} total · ${stats.length} pipelines`}
        />
        <StatCard
          label="Success rate"
          value={<PctPill pct={successRate != null ? Math.round(successRate * 10) / 10 : null} />}
          sub={`${fmtNum(totalSucceeded)} ok · ${fmtNum(totalFailed)} failed`}
        />
        <StatCard
          label={`Data moved (last ${window} days)`}
          value={fmtMb(totalDataMb)}
          sub={dataMovingPipelines > 0
            ? `~ ${fmtMb(dailyDataMb)} / day avg · ${dataMovingPipelines} pipeline${dataMovingPipelines === 1 ? "" : "s"} with data activity`
            : "no data-movement activity observed"}
        />
        <StatCard
          label={`Integration capacity (last ${window} days)`}
          value={totalCuHours > 0 ? `${totalCuHours.toFixed(2)} CU-hr` : "—"}
          sub={totalCuHours > 0
            ? `${totalCuHoursDm.toFixed(2)} from data movement (${totalDiuHours.toFixed(2)} DIU-hr) · ${totalCuHoursDf.toFixed(2)} from data flows (${totalVcoreHours.toFixed(2)} vCore-hr${dataFlowPipelines > 0 ? `, ${dataFlowPipelines} DF pipeline${dataFlowPipelines === 1 ? "" : "s"}` : ""}) · ${totalCuHoursOrch.toFixed(2)} from orchestration (${fmtNum(totalNonCopyRuns)} non-copy runs) · ≈ ${dailyCuEquivalent.toFixed(2)} CU sustained`
            : "no integration activity observed"}
        />
        <StatCard
          label="Window"
          value={`${new Date(history.window_start).toLocaleDateString()} → ${new Date(history.window_end).toLocaleDateString()}`}
          sub={`${fmtNum(history.fetched_run_count)} runs · ${fmtNum(history.fetched_activity_run_count)} activity runs${history.truncated ? " (truncated)" : ""}`}
        />
      </div>

      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Pipeline</th>
            <th className="num">Runs / day</th>
            <th className="num">Success</th>
            <th className="num">Failed</th>
            <th className="num">Data moved / run</th>
            <th className="num">Total moved</th>
            <th className="num">DIU-hr</th>
            <th className="num">CU-hr (DM)</th>
            <th className="num">vCore-hr</th>
            <th className="num">CU-hr (DF)</th>
            <th className="num">CU-hr (Orch)</th>
            <th>Last run</th>
          </tr>
        </thead>
        <tbody>
          {top.map((r) => (
            <tr key={r.pipeline}>
              <td><code>{r.pipeline}</code></td>
              <td className="num">{(r.w!.run_count / window).toFixed(2)}</td>
              <td className="num">{fmtNum(r.w!.succeeded)}</td>
              <td className="num">{fmtNum(r.w!.failed)}</td>
              <td className="num">{r.has_data_movement ? fmtMb(r.w!.avg_data_moved_mb_per_run) : "—"}</td>
              <td className="num">{r.has_data_movement ? fmtMb(r.w!.total_data_moved_mb) : "—"}</td>
              <td className="num">{r.w?.total_diu_hours != null ? r.w.total_diu_hours.toFixed(2) : "—"}</td>
              <td className="num">{r.w?.est_cu_hours_from_diu != null ? r.w.est_cu_hours_from_diu.toFixed(2) : "—"}</td>
              <td className="num">{r.w?.total_vcore_hours != null ? r.w.total_vcore_hours.toFixed(2) : "—"}</td>
              <td className="num">{r.w?.est_cu_hours_from_vcore != null ? r.w.est_cu_hours_from_vcore.toFixed(2) : "—"}</td>
              <td className="num">{(r.w?.est_cu_hours_from_orchestration ?? 0).toFixed(3)}</td>
              <td className="small muted">
                {r.last ? new Date(r.last).toLocaleString() : "—"}
                {r.lastStatus && <> · <SeverityPill severity={r.lastStatus.toLowerCase() === "succeeded" ? "info" : r.lastStatus.toLowerCase() === "failed" ? "blocker" : "warning"} /></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {stats.length > top.length && (
        <div className="small muted" style={{ marginTop: 6 }}>
          Showing top {top.length} of {stats.length} pipelines by run count.
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Spark Livy job history (interactive sessions + scheduled batches)
// ---------------------------------------------------------------------------

function SparkPoolsSection({ sparkPools, runMeta }: { sparkPools: import("../types").SparkPoolsReport | null; runMeta?: import("../api/loader").RunMeta | null }) {
  if (!sparkPools) return null;
  const stats = sparkPools.run_stats ?? [];
  const pools = sparkPools.pools ?? [];
  const errors = sparkPools.errors ?? [];
  const sparkHistoryErrors = errors.filter((e) => e.includes("spark_history"));

  // Render an explicit "no data" diagnostic panel when pools exist but the
  // Livy history collection produced no rows. This is much better UX than
  // silently dropping the section — it tells the user WHY there are no
  // Spark execution stats (typically a 403 on bigDataPools/useCompute/action,
  // or the SMA_SPARK_RUN_HISTORY env-var being disabled).
  if (stats.length === 0) {
    if (pools.length === 0) return null;
    return (
      <section className="section">
        <h2>Spark execution</h2>
        <div className="grid cols-2">
          <StatCard
            label="Spark pools discovered"
            value={fmtNum(pools.length)}
            sub={pools.slice(0, 3).map((p) => p.name).join(", ") + (pools.length > 3 ? `, …` : "")}
          />
          <StatCard
            label="Spark Livy history"
            value={sparkHistoryErrors.length > 0 ? "blocked" : "empty"}
            sub={sparkHistoryErrors.length > 0
              ? `${sparkHistoryErrors.length} Livy fetch error(s) — see below`
              : "no batch jobs or sessions found in the configured window"}
          />
        </div>
        {sparkHistoryErrors.length > 0 && (
          <div
            style={{
              marginTop: 12,
              padding: "10px 12px",
              border: "1px solid rgba(210,153,34,.4)",
              background: "rgba(210,153,34,.08)",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <strong>Spark Livy collection failed.</strong> The analyzer could
            list pools but could not read job / session history. Most common
            cause: the service principal lacks{" "}
            <code>Microsoft.Synapse/workspaces/bigDataPools/useCompute/action</code>{" "}
            (grant <em>Synapse Compute Operator</em> or higher on the
            workspace). Run <code>sma doctor</code> to confirm.
            <details style={{ marginTop: 8 }}>
              <summary>Errors ({sparkHistoryErrors.length})</summary>
              <ul style={{ marginTop: 6 }}>
                {sparkHistoryErrors.map((e, i) => (
                  <li key={i}><code>{e}</code></li>
                ))}
              </ul>
            </details>
          </div>
        )}
        {sparkHistoryErrors.length === 0 && (
          <div className="small muted" style={{ marginTop: 8 }}>
            Spark history collection runs by default. To disable, set{" "}
            <code>SMA_SPARK_RUN_HISTORY=0</code>. To widen the window, set{" "}
            <code>SMA_SPARK_RUN_DAYS</code> (default 90).
          </div>
        )}
      </section>
    );
  }

  // Prefer the 7-day window; fall back to the shortest available.
  // Aggregate per-pool. The interactive-vs-scheduled trigger dimension
  // is not displayed: Synapse Studio's Livy telemetry doesn't expose a
  // 100%-reliable discriminator for all run types (the `spark.synapse
  // .context.*` conf keys cover pipeline/SJD-triggered notebook runs
  // but other scheduled paths can still slip through), so we'd rather
  // omit the split than show a number that doesn't match Studio.
  //
  // Success/failure counts are intentionally omitted from the Spark
  // panel: most Spark runs in Synapse are interactive notebook sessions
  // where "failed" includes user-cancelled cells / SIGTERM-on-idle, so
  // the rate is a noisy signal that doesn't help capacity planning.
  type PerPool = {
    pool: string;
    runs: number;
    durationHours: number;
    vcoreHours: number;
    cuHours: number;
    windowDays: number;
  };
  const perPool: PerPool[] = (() => {
    const byPool = new Map<string, PerPool>();
    for (const s of stats) {
      const w = s.windows.find((x) => x.window_days === 7) ?? s.windows[0];
      if (!w) continue;
      let row = byPool.get(s.pool);
      if (!row) {
        row = {
          pool: s.pool, runs: 0,
          durationHours: 0, vcoreHours: 0, cuHours: 0,
          windowDays: w.window_days,
        };
        byPool.set(s.pool, row);
      }
      row.runs += w.run_count;
      row.durationHours += w.total_duration_hours;
      row.vcoreHours += w.total_vcore_hours;
      row.cuHours += w.est_cu_hours_fabric_spark;
    }
    return Array.from(byPool.values());
  })();
  if (perPool.length === 0) return null;

  const window = perPool[0].windowDays;
  const totalRuns = perPool.reduce((s, r) => s + r.runs, 0);
  const totalDurationHours = perPool.reduce((s, r) => s + r.durationHours, 0);
  const totalVcoreHours = perPool.reduce((s, r) => s + r.vcoreHours, 0);
  const totalCuHours = perPool.reduce((s, r) => s + r.cuHours, 0);
  const dailyCuHours = window > 0 ? totalCuHours / window : 0;
  const dailyCuEquivalent = dailyCuHours / 24;

  // Sort by CU-hours desc (largest consumer first).
  const top = [...perPool].sort((a, b) => b.cuHours - a.cuHours);

  return (
    <section className="section">
      <h2>Spark execution (last {window} days)<ProvenanceBadge meta={runMeta ?? null} module="spark_pools" /></h2>
      <div className="grid cols-3">
        <StatCard
          label="Spark runs"
          value={fmtNum(totalRuns)}
          sub={`${perPool.length} pool${perPool.length === 1 ? "" : "s"} · ${(window > 0 ? totalRuns / window : 0).toFixed(1)} runs/day`}
        />
        <StatCard
          label="Spark compute"
          value={`${totalVcoreHours.toFixed(2)} vCore-hr`}
          sub={`${totalDurationHours.toFixed(2)} wall-clock hr · ${(window > 0 ? totalVcoreHours / window : 0).toFixed(2)} vCore-hr/day`}
        />
        <StatCard
          label="Est. Fabric capacity"
          value={totalCuHours > 0 ? `${totalCuHours.toFixed(2)} CU-hr` : "—"}
          sub={totalCuHours > 0
            ? `≈ ${dailyCuEquivalent.toFixed(2)} CU sustained (1 CU = 2 Spark vCores)`
            : "no Spark Livy history collected"}
        />
      </div>

      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Pool</th>
            <th className="num">Runs</th>
            <th className="num">Duration hr</th>
            <th className="num">vCore-hr</th>
            <th className="num">CU-hr (Spark)</th>
            <th className="num">Avg vCore-hr / run</th>
          </tr>
        </thead>
        <tbody>
          {top.map((r) => {
            const avgVcore = r.runs > 0 ? r.vcoreHours / r.runs : null;
            return (
              <tr key={r.pool}>
                <td><code>{r.pool}</code></td>
                <td className="num">{fmtNum(r.runs)}</td>
                <td className="num">{r.durationHours.toFixed(2)}</td>
                <td className="num">{r.vcoreHours.toFixed(2)}</td>
                <td className="num">{r.cuHours.toFixed(2)}</td>
                <td className="num">{avgVcore != null ? avgVcore.toFixed(2) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sparkPools.spark_runs && sparkPools.spark_runs.length > 0 && (
        <SparkDailyBars runs={sparkPools.spark_runs} windowDays={28} />
      )}
      {sparkPools.errors && sparkPools.errors.length > 0 && (
        <div className="small muted" style={{ marginTop: 6 }}>
          {sparkPools.errors.length} collection error(s) — see <code>spark_pools.json</code>.
        </div>
      )}
    </section>
  );
}

function SparkDailyBars({
  runs,
  windowDays = 28,
}: {
  runs: import("../types").SparkRunRecord[];
  windowDays?: number;
}) {
  // Per-pool stacked daily vCore-hours. Each day is a single stacked bar
  // with one segment per Spark pool — this is what users want to see for
  // capacity sizing (which pool is driving compute, on which day?).
  //
  // Day bucketing uses UTC-midnight boundaries so the window is exactly
  // ``windowDays`` bins ending **today (UTC) inclusive**. Previously the
  // loop produced bins ``[now-28d, now-1d]`` (28 entries starting at the
  // millisecond ``now - 28d``) and today's runs silently dropped because
  // the lookup key (UTC date of today) did not exist in the bin map.
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);
  const startDayUTC = new Date(
    todayUTC.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000,
  );
  // Runs are kept when their submitted_at falls on or after the start day
  // (midnight UTC); this avoids losing a partial first day vs. using
  // ``now - 28d`` which slides every second.
  const cutoff = startDayUTC;

  // Per-run CU contribution: prefer the directly measured vCore-hours,
  // fall back to ``est_cu_hours_fabric_spark / 0.5`` (=> vCore-hours
  // equivalent) for interactive sessions where Livy returns CU-hours
  // but no raw vCore-seconds.
  const vCoreOf = (r: import("../types").SparkRunRecord): number => {
    if (typeof r.vcore_hours === "number" && r.vcore_hours > 0) return r.vcore_hours;
    if (typeof r.est_cu_hours_fabric_spark === "number" && r.est_cu_hours_fabric_spark > 0) {
      return r.est_cu_hours_fabric_spark / 0.5;
    }
    return 0;
  };

  // Discover the set of pools that contributed any runs in the window.
  // Include pools even when their per-run vCore-hours are 0 so the
  // legend reflects all observed pools (a Spark pool with only
  // failed-immediately runs still belongs on the chart).
  const pools = (() => {
    const seen = new Set<string>();
    for (const r of runs) {
      if (!r.submitted_at) continue;
      const t = new Date(r.submitted_at);
      if (Number.isNaN(t.getTime()) || t < cutoff) continue;
      seen.add(r.pool);
    }
    return Array.from(seen).sort();
  })();
  if (pools.length === 0) return null;

  // Pre-seed every day so the x-axis is continuous, **including today**.
  type DayBin = { day: string; perPool: Record<string, number>; total: number };
  const bins = new Map<string, DayBin>();
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(startDayUTC.getTime() + i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const perPool: Record<string, number> = {};
    for (const p of pools) perPool[p] = 0;
    bins.set(key, { day: key, perPool, total: 0 });
  }

  for (const r of runs) {
    if (!r.submitted_at) continue;
    const t = new Date(r.submitted_at);
    if (Number.isNaN(t.getTime()) || t < cutoff) continue;
    const key = t.toISOString().slice(0, 10);
    const bin = bins.get(key);
    if (!bin) continue;
    const v = vCoreOf(r);
    bin.perPool[r.pool] = (bin.perPool[r.pool] ?? 0) + v;
    bin.total += v;
  }

  const days = Array.from(bins.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
  const maxV = Math.max(0.001, ...days.map((d) => d.total));
  const total = days.reduce((s, d) => s + d.total, 0);
  if (total <= 0) return null;

  // Stable per-pool color (deterministic by index so refreshes don't shuffle).
  const PALETTE = ["#2f81f7", "#3fb950", "#d29922", "#a371f7", "#db61a2", "#e36b6b", "#1f9ea3", "#bf6a02"];
  const colorFor = (pool: string) => PALETTE[pools.indexOf(pool) % PALETTE.length];

  const width = 720;
  const height = 240;
  const padX = 56;
  const padTop = 16;
  const padBottom = 44;
  const innerH = height - padTop - padBottom;
  const groupW = (width - padX * 2) / days.length;
  const barW = Math.max(4, Math.min(24, groupW - 2));

  return (
    <div style={{ marginTop: 16, overflowX: "auto" }}>
      <div className="small muted" style={{ marginBottom: 6 }}>
        {pools.map((p) => (
          <span key={p} style={{ marginRight: 12, display: "inline-block" }}>
            <span style={{ display: "inline-block", width: 10, height: 10, background: colorFor(p), marginRight: 4, verticalAlign: "middle" }} />
            <code>{p}</code>
          </span>
        ))}
        <span>Spark vCore-hr per day</span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ maxWidth: width, fontSize: 10 }}
        role="img"
        aria-label={`Spark vCore-hours per day per pool for the last ${windowDays} days`}
      >
        <line x1={padX} x2={width - padX} y1={height - padBottom} y2={height - padBottom} stroke="currentColor" opacity={0.3} />
        <line x1={padX} x2={padX} y1={padTop} y2={height - padBottom} stroke="currentColor" opacity={0.3} />
        {[0, 0.5, 1].map((t, i) => (
          <g key={i}>
            <text x={padX - 6} y={height - padBottom - innerH * t + 3} textAnchor="end" fill="currentColor" opacity={0.7}>
              {(maxV * t).toFixed(maxV >= 10 ? 0 : 1)}
            </text>
            <line
              x1={padX}
              x2={width - padX}
              y1={height - padBottom - innerH * t}
              y2={height - padBottom - innerH * t}
              stroke="currentColor"
              opacity={i === 0 ? 0.3 : 0.08}
            />
          </g>
        ))}
        {days.map((d, i) => {
          const cx = padX + groupW * i + groupW / 2;
          const baseY = height - padBottom;
          const labelEvery = Math.max(1, Math.ceil(days.length / 8));
          let acc = 0;
          return (
            <g key={d.day}>
              {pools.map((p) => {
                const v = d.perPool[p] ?? 0;
                if (v <= 0) return null;
                const h = (v / maxV) * innerH;
                const y = baseY - acc - h;
                acc += h;
                return (
                  <rect
                    key={p}
                    x={cx - barW / 2}
                    y={y}
                    width={barW}
                    height={h}
                    fill={colorFor(p)}
                  >
                    <title>{`${d.day} — ${p}: ${v.toFixed(2)} vCore-hr`}</title>
                  </rect>
                );
              })}
              {i % labelEvery === 0 && (
                <text x={cx} y={height - padBottom + 14} textAnchor="middle" fill="currentColor" opacity={0.8}>
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="small muted" style={{ marginTop: 4 }}>
        Window: last {windowDays} days · {total.toFixed(2)} vCore-hr total ·{" "}
        {pools
          .map((p) => {
            const s = days.reduce((acc, d) => acc + (d.perPool[p] ?? 0), 0);
            return `${p}: ${s.toFixed(2)}`;
          })
          .join(" · ")}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Serverless SQL query statistics
// ---------------------------------------------------------------------------

function ServerlessSection({ serverless, runMeta }: { serverless: import("../types").ServerlessReport | null; runMeta?: import("../api/loader").RunMeta | null }) {
  if (!serverless) return null;
  const daily = serverless.daily_usage ?? [];
  const dbCount = serverless.databases?.length ?? 0;
  const tableCount = serverless.external_tables?.length ?? 0;
  // If there's no serverless inventory at all, hide the section entirely.
  if (daily.length === 0 && dbCount === 0 && tableCount === 0) return null;

  // Sort ascending by day so charts read left-to-right.
  const sorted = [...daily].sort((a, b) => a.day.localeCompare(b.day));
  const last7 = sorted.slice(-7);

  const totalRequests = sorted.reduce((s, d) => s + (d.request_count ?? 0), 0);
  const totalDataMb = sorted.reduce((s, d) => s + (d.data_processed_mb ?? 0), 0);
  const totalDurationSeconds = sorted.reduce((s, d) => s + (d.duration_seconds ?? 0), 0);
  const windowDays = sorted.length;
  const avgDailyRequests = windowDays > 0 ? totalRequests / windowDays : 0;
  const avgQueryMb = totalRequests > 0 ? totalDataMb / totalRequests : 0;
  const avgQuerySeconds = totalRequests > 0 ? totalDurationSeconds / totalRequests : 0;
  const hasDuration = totalDurationSeconds > 0;

  const fmtDurationShort = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0 s";
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
    return `${(seconds / 86400).toFixed(1)} d`;
  };

  if (daily.length === 0) {
    return (
      <section className="section">
        <h2>Serverless SQL</h2>
        <div className="grid cols-3">
          <StatCard label="Databases" value={fmtNum(dbCount)} />
          <StatCard label="External tables" value={fmtNum(tableCount)} />
          <StatCard
            label="Endpoint"
            value={serverless.endpoint_fqdn ? <code className="small">{serverless.endpoint_fqdn}</code> : "—"}
          />
        </div>
        <div className="small muted" style={{ marginTop: 12 }}>
          No daily query history available. <code>sys.dm_exec_requests_history</code> only
          returns queries submitted by the current login unless the principal has
          <code> VIEW SERVER STATE</code> or is a Synapse SQL admin. Grant that
          permission and re-run <code>sma analyze-serverless-pools</code> to populate
          this chart.
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      <h2>Serverless SQL ({windowDays} days observed)<ProvenanceBadge meta={runMeta ?? null} module="serverless_pools" /></h2>
      <div className={hasDuration ? "grid cols-5" : "grid cols-4"}>
        <StatCard
          label="Avg daily queries"
          value={avgDailyRequests.toFixed(1)}
          sub={`${fmtNum(totalRequests)} succeeded queries`}
        />
        <StatCard
          label="Total data scanned"
          value={fmtMb(totalDataMb)}
          sub={`${fmtMb(totalDataMb / Math.max(1, windowDays))} / day avg`}
        />
        <StatCard
          label="Avg query data size"
          value={fmtMb(avgQueryMb)}
          sub="data scanned per query"
        />
        {hasDuration && (
          <StatCard
            label="Total execution time"
            value={fmtDurationShort(totalDurationSeconds)}
            sub={`${fmtDurationShort(totalDurationSeconds / Math.max(1, windowDays))} / day avg · ${fmtDurationShort(avgQuerySeconds)} / query avg`}
          />
        )}
        <StatCard
          label="Estimated cost"
          value={
            serverless.cost_estimate
              ? `$${serverless.cost_estimate.estimated_cost_usd.toFixed(2)}`
              : "—"
          }
          sub={
            serverless.cost_estimate
              ? `${serverless.cost_estimate.total_data_processed_tb.toFixed(3)} TB · $${serverless.cost_estimate.list_price_usd_per_tb}/TB list price`
              : "no cost estimate"
          }
        />
      </div>

      {last7.length > 0 && <ServerlessClusteredBars days={last7} />}
    </section>
  );
}

function ServerlessClusteredBars({ days }: { days: import("../types").ServerlessDailyUsage[] }) {
  // Clustered bar chart: queries vs MB per day. Two y-axes so we don't compare
  // apples to oranges; each bar pair is normalized against its own series max.
  const maxRequests = Math.max(1, ...days.map((d) => d.request_count ?? 0));
  const maxMb = Math.max(1, ...days.map((d) => d.data_processed_mb ?? 0));

  const width = 720;
  const height = 220;
  const padX = 56;
  const padTop = 16;
  const padBottom = 44;
  const innerH = height - padTop - padBottom;
  const groupW = (width - padX * 2) / days.length;
  const barW = Math.max(6, Math.min(28, (groupW - 8) / 2));

  return (
    <div style={{ marginTop: 16, overflowX: "auto" }}>
      <div className="small muted" style={{ marginBottom: 6 }}>
        <span style={{ display: "inline-block", width: 10, height: 10, background: "#2f81f7", marginRight: 4, verticalAlign: "middle" }} />
        Queries (left axis)
        {"  "}
        <span style={{ display: "inline-block", width: 10, height: 10, background: "#f7942f", margin: "0 4px 0 12px", verticalAlign: "middle" }} />
        MB scanned (right axis)
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ maxWidth: width, fontSize: 10 }} role="img" aria-label="Serverless SQL last 7 days clustered bar chart">
        <line x1={padX} x2={width - padX} y1={height - padBottom} y2={height - padBottom} stroke="currentColor" opacity={0.3} />
        <line x1={padX} x2={padX} y1={padTop} y2={height - padBottom} stroke="currentColor" opacity={0.3} />
        <line x1={width - padX} x2={width - padX} y1={padTop} y2={height - padBottom} stroke="currentColor" opacity={0.3} />
        {[0, 0.5, 1].map((t, i) => (
          <g key={i}>
            <text x={padX - 6} y={height - padBottom - innerH * t + 3} textAnchor="end" fill="currentColor" opacity={0.7}>
              {Math.round(maxRequests * t)}
            </text>
            <text x={width - padX + 6} y={height - padBottom - innerH * t + 3} textAnchor="start" fill="currentColor" opacity={0.7}>
              {fmtMb(maxMb * t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const cx = padX + groupW * i + groupW / 2;
          const reqH = ((d.request_count ?? 0) / maxRequests) * innerH;
          const mbH = ((d.data_processed_mb ?? 0) / maxMb) * innerH;
          const reqX = cx - barW - 1;
          const mbX = cx + 1;
          const baseY = height - padBottom;
          return (
            <g key={d.day}>
              <rect x={reqX} y={baseY - reqH} width={barW} height={reqH} fill="#2f81f7">
                <title>{`${d.day}: ${fmtNum(d.request_count)} queries`}</title>
              </rect>
              <rect x={mbX} y={baseY - mbH} width={barW} height={mbH} fill="#f7942f">
                <title>{`${d.day}: ${fmtMb(d.data_processed_mb)} scanned`}</title>
              </rect>
              <text x={cx} y={height - padBottom + 14} textAnchor="middle" fill="currentColor" opacity={0.8}>
                {d.day.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
