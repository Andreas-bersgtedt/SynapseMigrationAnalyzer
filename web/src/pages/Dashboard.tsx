import { loadFabricMapping, loadPipelines, loadStorage, detectMode, getRunIdFromHash } from "../api/loader";
import { useAsync } from "../hooks/useAsync";
import { Empty, PctPill, ScorePill, SeverityPill, StatCard } from "../components/Atoms";
import HelpLink from "../components/HelpLink";
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
              ? `peak DWU ${Math.round(cp.peak_dwu)} → CU ${cp.estimated_cu.toFixed(1)} (${cp.headroom_pct}% headroom)`
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
                  <td>{b.effort}</td>
                  <td><code>{b.area}</code></td>
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

      <section className="section">
        <h2>Inputs analyzed</h2>
        <table>
          <thead>
            <tr><th>Module</th><th>Source</th><th>Counts</th></tr>
          </thead>
          <tbody>
            {fm.inputs.map((i: ModuleSummary) => (
              <tr key={i.module}>
                <td><code>{i.module}</code></td>
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
  const dataMovingPipelines = stats.filter((r) => r.has_data_movement && (r.w?.total_data_moved_mb ?? 0) > 0).length;
  const dailyRuns = totalRuns / window;
  const dailyDataMb = totalDataMb / window;
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
      <div className="grid cols-4">
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
