import { loadFabricMapping, loadMonitoring, loadPipelines, loadServerless, loadSparkPools, loadStorage, detectMode, getRunIdFromHash } from "../api/loader";
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
  const { data: monitoring, loading: monitoringLoading } = useAsync(loadMonitoring);
  const { data: mode } = useAsync(detectMode);
  const runMeta = useCurrentRunMeta();

  const loading =
    fmLoading || storageLoading || pipelinesLoading || serverlessLoading || sparkLoading || monitoringLoading;
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
      || (monitoring && (monitoring.series?.length || monitoring.dwu_days?.length))
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

      <DwuUtilizationSection monitoring={monitoring} runMeta={runMeta} />
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
// DWU utilization (Azure Monitor historical DWUUsedPercent per pool)
// ---------------------------------------------------------------------------

/**
 * Severity-coloured DWU % badge. Unlike `PctPill` (which is calibrated for
 * "higher is better" metrics like readiness score), high DWU % means
 * the pool is saturated — so we invert the colour ramp.
 */
function DwuPctTag({ value }: { value: number | null }) {
  if (value == null || !Number.isFinite(value)) return <span className="muted">—</span>;
  const cls = value >= 90 ? "err" : value >= 70 ? "warn" : "ok";
  return <span className={`pill ${cls}`}>{value.toFixed(0)}%</span>;
}

/**
 * Renders a 7d (or whatever the monitoring window is) timeseries of
 * `DWUUsedPercent` per dedicated SQL pool plus headline stats (peak %,
 * p95 %, peak DWU, active hours). Reads `monitoring.json` directly — no
 * backend changes needed, the monitoring module already collects this
 * data via Azure Monitor (`DWUUsed`, `DWUUsedPercent`, `DWULimit`).
 *
 * Hides itself when no monitoring artefact exists for the current run
 * (e.g. user skipped `--with monitoring`) or when no DWU series were
 * returned (e.g. paused pools, missing Monitoring Reader RBAC).
 */
function DwuUtilizationSection({
  monitoring,
  runMeta,
}: {
  monitoring: import("../types").MonitoringReport | null;
  runMeta?: import("../api/loader").RunMeta | null;
}) {
  if (!monitoring) return null;
  const series = monitoring.series ?? [];
  // We chart DWUUsedPercent (0–100, pool-size agnostic). Fall back to
  // computing it from DWUUsed/DWULimit if the provider only returned the
  // absolute metrics (older provider versions, custom retention pipelines).
  const pctByPool = new Map<string, Array<[string, number | null]>>();
  const limitByPool = new Map<string, number>();
  const usedByPool = new Map<string, Array<[string, number | null]>>();
  for (const s of series) {
    if (s.resource_kind !== "dedicated_pool") continue;
    if (s.metric_name === "DWUUsedPercent") {
      pctByPool.set(s.resource_name, s.points ?? []);
    } else if (s.metric_name === "DWULimit") {
      // Use max value as the steady-state DWU limit (limit can change if
      // someone scaled the pool inside the window — pick the recent peak
      // so the badge reflects current sizing).
      if (s.max_value != null) limitByPool.set(s.resource_name, s.max_value);
    } else if (s.metric_name === "DWUUsed") {
      usedByPool.set(s.resource_name, s.points ?? []);
    }
  }
  // Synthesise % from absolutes when needed.
  for (const [pool, used] of usedByPool) {
    if (pctByPool.has(pool)) continue;
    const lim = limitByPool.get(pool);
    if (!lim || lim <= 0) continue;
    pctByPool.set(
      pool,
      used.map(([t, v]) => [t, v == null ? null : (v / lim) * 100]),
    );
  }
  const pools = Array.from(pctByPool.keys()).sort();
  if (pools.length === 0) return null;

  const windowStart = new Date(monitoring.window_start);
  const windowEnd = new Date(monitoring.window_end);
  const windowDays = Math.max(
    1,
    Math.round((windowEnd.getTime() - windowStart.getTime()) / 86_400_000),
  );

  // Per-pool stats (peak, p95, avg) over the chart window.
  const stats = pools.map((pool) => {
    const pts = pctByPool.get(pool) ?? [];
    const vals = pts.map(([, v]) => v).filter((v): v is number => v != null && Number.isFinite(v));
    const peak = vals.length ? Math.max(...vals) : null;
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const sorted = vals.slice().sort((a, b) => a - b);
    const p95 = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))]
      : null;
    const limit = limitByPool.get(pool) ?? null;
    // Look up the corresponding dwu_days roll-up for active hours / peak DWU.
    const days = (monitoring.dwu_days ?? []).filter((d) => d.pool_name === pool);
    const activeHours = days.reduce((a, d) => a + (d.active_hours ?? 0), 0);
    const peakDwu = days.length ? Math.max(...days.map((d) => d.peak_dwu ?? 0)) : null;
    return { pool, peak, p95, avg, limit, activeHours, peakDwu };
  });

  // Headline cards: estate totals across all pools.
  const overallPeak = stats.reduce<number | null>(
    (acc, s) => (s.peak == null ? acc : Math.max(acc ?? 0, s.peak)),
    null,
  );
  const overallP95 = (() => {
    const all: number[] = [];
    for (const pool of pools) {
      const pts = pctByPool.get(pool) ?? [];
      for (const [, v] of pts) if (v != null && Number.isFinite(v)) all.push(v);
    }
    if (!all.length) return null;
    all.sort((a, b) => a - b);
    return all[Math.min(all.length - 1, Math.floor(0.95 * (all.length - 1)))];
  })();
  const totalActiveHours = stats.reduce((a, s) => a + s.activeHours, 0);

  return (
    <section className="section">
      <h2>
        DWU utilization
        <ProvenanceBadge meta={runMeta ?? null} module="monitoring" />
      </h2>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Azure Monitor <code>DWUUsedPercent</code> over the last {windowDays} day
        {windowDays === 1 ? "" : "s"} ({monitoring.interval} samples) — one line
        per dedicated SQL pool. Source: <code>monitoring.json</code>.
      </div>

      <div className="grid cols-4">
        <StatCard
          label="Peak DWU %"
          value={overallPeak != null ? `${overallPeak.toFixed(0)}%` : "—"}
          sub={`across ${pools.length} pool${pools.length === 1 ? "" : "s"}`}
        />
        <StatCard
          label="P95 DWU %"
          value={overallP95 != null ? `${overallP95.toFixed(0)}%` : "—"}
          sub={`window ${windowDays}d · ${monitoring.interval}`}
        />
        <StatCard
          label="Active hours"
          value={totalActiveHours > 0 ? totalActiveHours.toFixed(1) : "—"}
          sub={`pool-hours with DWU > 0`}
        />
        <StatCard
          label="Pools observed"
          value={pools.length}
          sub={pools.length === 1 ? pools[0] : `${pools.slice(0, 3).join(", ")}${pools.length > 3 ? "…" : ""}`}
        />
      </div>

      <DwuLineChart pools={pools} pctByPool={pctByPool} windowDays={windowDays} />

      {stats.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Pool</th>
              <th className="num">DWU limit</th>
              <th className="num">Peak DWU</th>
              <th className="num">Peak %</th>
              <th className="num">P95 %</th>
              <th className="num">Avg %</th>
              <th className="num">Active hours</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.pool}>
                <td><code>{s.pool}</code></td>
                <td className="num">{s.limit != null ? `DW${Math.round(s.limit)}c` : "—"}</td>
                <td className="num">{s.peakDwu != null ? fmtNum(s.peakDwu) : "—"}</td>
                <td className="num"><DwuPctTag value={s.peak ?? null} /></td>
                <td className="num"><DwuPctTag value={s.p95 ?? null} /></td>
                <td className="num">{s.avg != null ? `${s.avg.toFixed(0)}%` : "—"}</td>
                <td className="num">{s.activeHours > 0 ? s.activeHours.toFixed(1) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Inline-SVG multi-line chart of DWU % over the monitoring window. One
 * polyline per pool, plus a dashed 100 % reference. Same rendering
 * conventions as DailyRunsChart so the dashboard stays visually
 * consistent.
 */
function DwuLineChart({
  pools,
  pctByPool,
  windowDays,
}: {
  pools: string[];
  pctByPool: Map<string, Array<[string, number | null]>>;
  windowDays: number;
}) {
  // Collect every (t, v) across all pools to find the global x-range.
  const allTimes: number[] = [];
  for (const pool of pools) {
    for (const [t] of pctByPool.get(pool) ?? []) {
      const ms = Date.parse(t);
      if (Number.isFinite(ms)) allTimes.push(ms);
    }
  }
  if (allTimes.length === 0) return null;
  const tMin = Math.min(...allTimes);
  const tMax = Math.max(...allTimes);
  const tSpan = Math.max(1, tMax - tMin);

  // Y axis: clamp to >= 100 so the reference line is always visible, and
  // round up to nearest 25 so labels are tidy when DWU stays low.
  const observedMax = (() => {
    let m = 0;
    for (const pool of pools) {
      for (const [, v] of pctByPool.get(pool) ?? []) {
        if (v != null && Number.isFinite(v) && v > m) m = v;
      }
    }
    return m;
  })();
  const yMax = Math.max(100, Math.ceil(observedMax / 25) * 25);

  // Layout — mirrors DailyRunsChart.
  const width = 720;
  const height = 240;
  const padX = 56;
  const padTop = 16;
  const padBottom = 44;
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;

  const xOf = (ms: number) => padX + ((ms - tMin) / tSpan) * innerW;
  const yOf = (v: number) => padTop + innerH - (Math.max(0, Math.min(yMax, v)) / yMax) * innerH;

  // 5 colours cycled — uses CSS variables so dark/light themes work.
  const palette = [
    "var(--accent)",
    "var(--ok)",
    "var(--warn)",
    "var(--err)",
    "var(--muted)",
  ];

  // Y ticks at 0, 25, 50, 75, 100 (and yMax if > 100).
  const yTicks: number[] = [0, 25, 50, 75, 100];
  if (yMax > 100) yTicks.push(yMax);

  // X labels — show ~6 evenly spaced day boundaries within the window.
  const labelCount = Math.min(6, Math.max(2, windowDays));
  const xLabels: Array<{ x: number; label: string }> = [];
  for (let i = 0; i < labelCount; i++) {
    const ms = tMin + ((tMax - tMin) * i) / (labelCount - 1);
    const d = new Date(ms);
    xLabels.push({
      x: xOf(ms),
      label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
    });
  }

  const axisColor = "var(--border)";
  const textColor = "var(--muted)";

  return (
    <div style={{ marginTop: 12 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        DWU % over time per pool (100 % = DWU limit)
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Line chart of DWU utilization percent per pool over time"
        >
          {/* Y grid + tick labels */}
          {yTicks.map((t, i) => {
            const y = yOf(t);
            const is100 = t === 100;
            return (
              <g key={i}>
                <line
                  x1={padX}
                  x2={width - padX}
                  y1={y}
                  y2={y}
                  stroke={is100 ? "var(--err)" : axisColor}
                  strokeDasharray={t === 0 ? undefined : is100 ? "4,3" : "2,3"}
                  opacity={is100 ? 0.7 : 1}
                />
                <text x={padX - 6} y={y + 3} textAnchor="end" fontSize={10} fill={textColor}>
                  {t}%
                </text>
              </g>
            );
          })}

          {/* X tick labels */}
          {xLabels.map((l, i) => (
            <text
              key={i}
              x={l.x}
              y={height - padBottom + 14}
              textAnchor="middle"
              fontSize={10}
              fill={textColor}
            >
              {l.label}
            </text>
          ))}

          {/* One polyline per pool */}
          {pools.map((pool, idx) => {
            const color = palette[idx % palette.length];
            const pts = pctByPool.get(pool) ?? [];
            // Build path, breaking on null values so gaps render as gaps.
            const segments: string[] = [];
            let inSeg = false;
            for (const [t, v] of pts) {
              const ms = Date.parse(t);
              if (!Number.isFinite(ms) || v == null || !Number.isFinite(v)) {
                inSeg = false;
                continue;
              }
              const x = xOf(ms).toFixed(2);
              const y = yOf(v).toFixed(2);
              segments.push(`${inSeg ? "L" : "M"}${x},${y}`);
              inSeg = true;
            }
            if (segments.length === 0) return null;
            return (
              <path
                key={pool}
                d={segments.join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              >
                <title>{pool}</title>
              </path>
            );
          })}
        </svg>
      </div>
      {pools.length > 1 && (
        <div className="small muted" style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 4 }}>
          {pools.map((pool, idx) => (
            <span key={pool}>
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  background: palette[idx % palette.length],
                  borderRadius: 2,
                  marginRight: 4,
                  verticalAlign: "middle",
                }}
              />
              <code>{pool}</code>
            </span>
          ))}
        </div>
      )}
    </div>
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

      <DailyRunsChart history={history} />

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

/**
 * Stacked bar chart of daily pipeline run outcomes (succeeded / failed /
 * other) across the fetched run-history window. Renders inline SVG so it
 * works in print / static SPA mode without any chart library.
 */
function DailyRunsChart({ history }: { history: import("../types").PipelineRunHistory }) {
  const daily = history.daily_status;
  if (!daily) return null;

  // Fixed 28-day window ending at today (UTC inclusive) — mirrors the
  // Spark daily bars chart so the two visuals line up. The pipeline
  // analyzer's run-history window may be wider (90d max) but capping the
  // chart at 28 days keeps it consistent and avoids huge empty gutters
  // when only the trailing slice has data.
  const windowDays = 28;
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);
  const startDayUTC = new Date(
    todayUTC.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000,
  );

  const days: Array<{ date: string; succeeded: number; failed: number; other: number; total: number }> = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(startDayUTC.getTime() + i * 24 * 60 * 60 * 1000);
    const iso = d.toISOString().slice(0, 10);
    const v = daily[iso] ?? { succeeded: 0, failed: 0, other: 0 };
    days.push({
      date: iso,
      succeeded: v.succeeded ?? 0,
      failed: v.failed ?? 0,
      other: v.other ?? 0,
      total: (v.succeeded ?? 0) + (v.failed ?? 0) + (v.other ?? 0),
    });
  }
  // Don't render an empty chart when nothing was observed.
  const grandTotal = days.reduce((s, d) => s + d.total, 0);
  if (grandTotal === 0) return null;

  const maxTotal = Math.max(...days.map((d) => d.total), 1);
  // Y-axis tick (nearest "nice" value above maxTotal).
  const niceMax = niceCeil(maxTotal);

  // Layout — mirrors SparkDailyBars (width 720, height 240, padX 56).
  const width = 720;
  const height = 240;
  const padX = 56;
  const padTop = 16;
  const padBottom = 44;
  const innerH = height - padTop - padBottom;
  const groupW = (width - padX * 2) / days.length;
  const barW = Math.max(4, Math.min(24, groupW - 2));

  const colorOk = "var(--ok)";
  const colorErr = "var(--err)";
  const colorOther = "var(--muted)";
  const axisColor = "var(--border)";
  const textColor = "var(--muted)";

  // Y ticks: 0, niceMax/2, niceMax
  const yTicks = [0, niceMax / 2, niceMax];

  // X tick labels — pick ~6 evenly spaced days.
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));

  return (
    <div style={{ marginTop: 12 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        Daily pipeline run outcomes (last {windowDays} days)
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Stacked bar chart of daily pipeline run outcomes"
        >
          {/* Y-axis grid + labels */}
          {yTicks.map((t, i) => {
            const y = padTop + innerH - (t / niceMax) * innerH;
            return (
              <g key={i}>
                <line
                  x1={padX}
                  x2={width - padX}
                  y1={y}
                  y2={y}
                  stroke={axisColor}
                  strokeDasharray={i === 0 ? undefined : "2,3"}
                />
                <text x={padX - 6} y={y + 3} textAnchor="end" fontSize={10} fill={textColor}>
                  {Math.round(t)}
                </text>
              </g>
            );
          })}

          {/* Bars */}
          {days.map((d, i) => {
            const x = padX + i * groupW + (groupW - barW) / 2;
            const okH = (d.succeeded / niceMax) * innerH;
            const errH = (d.failed / niceMax) * innerH;
            const otherH = (d.other / niceMax) * innerH;
            const baseY = padTop + innerH;
            const okY = baseY - okH;
            const errY = okY - errH;
            const otherY = errY - otherH;
            const showLabel = i === 0 || i === days.length - 1 || i % labelEvery === 0;
            const title = `${d.date} — ${d.succeeded} ok · ${d.failed} failed${d.other ? ` · ${d.other} other` : ""}`;
            return (
              <g key={d.date}>
                <title>{title}</title>
                {d.succeeded > 0 && (
                  <rect x={x} y={okY} width={barW} height={okH} fill={colorOk} />
                )}
                {d.failed > 0 && (
                  <rect x={x} y={errY} width={barW} height={errH} fill={colorErr} />
                )}
                {d.other > 0 && (
                  <rect x={x} y={otherY} width={barW} height={otherH} fill={colorOther} opacity={0.6} />
                )}
                {showLabel && (
                  <text
                    x={x + barW / 2}
                    y={height - padBottom + 14}
                    textAnchor="middle"
                    fontSize={10}
                    fill={textColor}
                  >
                    {d.date.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="small muted" style={{ display: "flex", gap: 14, marginTop: 4 }}>
        <span><span style={{ display: "inline-block", width: 10, height: 10, background: colorOk, borderRadius: 2, marginRight: 4, verticalAlign: "middle" }} />Succeeded</span>
        <span><span style={{ display: "inline-block", width: 10, height: 10, background: colorErr, borderRadius: 2, marginRight: 4, verticalAlign: "middle" }} />Failed</span>
        <span><span style={{ display: "inline-block", width: 10, height: 10, background: colorOther, borderRadius: 2, marginRight: 4, verticalAlign: "middle", opacity: 0.6 }} />Other (in-progress, cancelled, queued)</span>
      </div>
    </div>
  );
}

function niceCeil(n: number): number {
  if (n <= 1) return 1;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const r = n / base;
  let nice: number;
  if (r <= 1) nice = 1;
  else if (r <= 2) nice = 2;
  else if (r <= 5) nice = 5;
  else nice = 10;
  return nice * base;
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
  // The top-queries table now lives on the SQL Surface page; this section
  // only renders the high-level KPIs + daily trend chart.
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
          this chart. Top queries (when available) are listed on the
          <strong> SQL Surface</strong> page.
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
