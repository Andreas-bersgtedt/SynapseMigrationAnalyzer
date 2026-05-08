import { loadFabricMapping, loadPipelines, loadServerless, loadStorage, detectMode, getRunIdFromHash } from "../api/loader";
import { useAsync } from "../hooks/useAsync";
import { Empty, PctPill, ScorePill, SeverityPill, StatCard } from "../components/Atoms";
import HelpLink from "../components/HelpLink";
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

export default function Dashboard() {
  const { data: fm, loading } = useAsync(loadFabricMapping);
  const { data: storage } = useAsync(loadStorage);
  const { data: pipelines } = useAsync(loadPipelines);
  const { data: serverless } = useAsync(loadServerless);
  const { data: mode } = useAsync(detectMode);

  if (loading) return <div className="empty">Loading…</div>;
  if (!fm) {
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
          No <code>fabric_mapping.json</code> for run <code>{runId}</code>.
          Either the run is still in progress, the <code>fabric_mapping</code>
          module wasn't selected, or the run failed before <code>fabric_mapping</code>
          ran. See the <code>Runs</code> page for status.
        </Empty>
      );
    }
    return (
      <Empty>
        No <code>fabric_mapping.json</code> found. Run{" "}
        <code>sma analyze-all</code> first, then point the SPA at the output
        directory (see <code>web/README.md</code>).
      </Empty>
    );
  }

  const rd = fm.readiness;
  const cp = fm.capacity_projection;
  const sevCount = (s: Severity) =>
    rd?.counts?.[s] ?? fm.recommendations.filter((r: Recommendation) => r.severity === s).length;

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
      totalCuHr += w.est_cu_hours_from_orchestration ?? 0;
      window = w.window_days;
    }
    if (window <= 0) return 0;
    return (totalCuHr / window) / 24;
  })();

  return (
    <>
      <h1 style={{ margin: "0 0 4px" }}>
        {fm.workspace_name ?? "(workspace)"} <HelpLink slug="04-dashboard" />
      </h1>
      <div className="muted small" style={{ marginBottom: 16 }}>
        Generated {new Date(fm.generated_at).toLocaleString()}
      </div>

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
              ? `peak DWU ${Math.round(cp.peak_dwu)} → CU ${cp.estimated_cu.toFixed(1)} (${cp.headroom_pct}% headroom)${
                  integrationDailyCu > 0
                    ? ` · + ${integrationDailyCu.toFixed(2)} CU/day from pipelines`
                    : ""
                }`
              : integrationDailyCu > 0
                ? `no monitoring data · ${integrationDailyCu.toFixed(2)} CU/day from pipelines`
                : "no monitoring data"
          }
        />
      </div>

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

      <StorageSection storage={storage} />
      <PipelinesSection pipelines={pipelines} />
      <ServerlessSection serverless={serverless} />

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
    </>
  );
}

// ---------------------------------------------------------------------------
// Storage statistics
// ---------------------------------------------------------------------------

function StorageSection({ storage }: { storage: import("../types").StorageReport | null }) {
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
      <h2>Storage</h2>
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

function PipelinesSection({ pipelines }: { pipelines: import("../types").PipelinesReport | null }) {
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
  const totalCuHoursOrch = stats.reduce((s, r) => s + (r.w?.est_cu_hours_from_orchestration ?? 0), 0);
  const totalNonCopyRuns = stats.reduce((s, r) => s + (r.w?.est_non_copy_activity_runs ?? 0), 0);
  const totalCuHours = totalCuHoursDm + totalCuHoursOrch;
  const dataMovingPipelines = stats.filter((r) => r.has_data_movement && (r.w?.total_data_moved_mb ?? 0) > 0).length;
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
      <h2>Pipeline activity (last {window} days)</h2>
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
            ? `${totalCuHoursDm.toFixed(2)} from data movement (${totalDiuHours.toFixed(2)} DIU-hr) · ${totalCuHoursOrch.toFixed(2)} from orchestration (${fmtNum(totalNonCopyRuns)} non-copy runs) · ≈ ${dailyCuEquivalent.toFixed(2)} CU sustained`
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
// Serverless SQL query statistics
// ---------------------------------------------------------------------------

function ServerlessSection({ serverless }: { serverless: import("../types").ServerlessReport | null }) {
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
  const windowDays = sorted.length;
  const avgDailyRequests = windowDays > 0 ? totalRequests / windowDays : 0;
  const avgQueryMb = totalRequests > 0 ? totalDataMb / totalRequests : 0;

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
      <h2>Serverless SQL ({windowDays} days observed)</h2>
      <div className="grid cols-4">
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
