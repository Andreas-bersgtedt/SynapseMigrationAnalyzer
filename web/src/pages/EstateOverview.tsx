import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  apiEstateCsvUrl,
  apiGetEstate,
  detectMode,
  setRunIdInHash,
} from "../api/loader";
import { Empty, PctPill, ScorePill, SeverityPill, StatCard } from "../components/Atoms";
import HelpLink from "../components/HelpLink";
import { useAsync } from "../hooks/useAsync";
import { areaLabel, effortLabel } from "../lib/labels";
import type { EstateHistoryPoint, EstateWorkspace } from "../types";

function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtCurrency(n: number | null | undefined, currency: string | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const code = (currency ?? "USD").toUpperCase();
  try {
    return n.toLocaleString(undefined, {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    });
  } catch {
    return `${code} ${fmtNum(n)}`;
  }
}

// Fabric F-SKUs in ascending CU. Pick the smallest one whose CU >= total.
const F_SKUS = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

function minFabricSku(totalCu: number | null | undefined): string {
  if (totalCu == null || !Number.isFinite(totalCu) || totalCu <= 0) return "—";
  for (const cu of F_SKUS) {
    if (cu >= totalCu) return `F${cu}`;
  }
  return `F${F_SKUS[F_SKUS.length - 1]}+`;
}

function Sparkline({
  history,
  width = 96,
  height = 24,
}: {
  history: EstateHistoryPoint[];
  width?: number;
  height?: number;
}) {
  const points = history
    .map((h) => h.readiness_score)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (points.length < 2) {
    return <span className="muted" title="Not enough history">—</span>;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = points.length === 1 ? 0 : width / (points.length - 1);
  const path = points
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / span) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points[points.length - 1];
  const trend = last >= points[0] ? "ok" : "warn";
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`sparkline ${trend}`}
      role="img"
      aria-label={`Readiness trend across ${points.length} runs`}
    >
      <path d={path} fill="none" strokeWidth={1.5} />
    </svg>
  );
}

function ReadinessChart({ workspaces }: { workspaces: EstateWorkspace[] }) {
  // Aggregate avg readiness per (calendar) day across all workspaces.
  const series = useMemo(() => {
    const buckets = new Map<string, { sum: number; n: number }>();
    for (const ws of workspaces) {
      for (const h of ws.history) {
        if (h.readiness_score == null) continue;
        const day = h.finished_at.slice(0, 10);
        const e = buckets.get(day) ?? { sum: 0, n: 0 };
        e.sum += h.readiness_score;
        e.n += 1;
        buckets.set(day, e);
      }
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, score: v.sum / v.n }));
  }, [workspaces]);

  if (series.length < 2) return null;

  const w = 720;
  const h = 140;
  const pad = 24;
  const min = Math.min(...series.map((p) => p.score));
  const max = Math.max(...series.map((p) => p.score));
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (series.length - 1);
  const path = series
    .map((p, i) => {
      const x = pad + i * stepX;
      const y = pad + (h - pad * 2) - ((p.score - min) / span) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <div className="label">Estate readiness over time</div>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="sparkline ok">
        <path d={path} fill="none" strokeWidth={1.75} />
      </svg>
      <div className="sub">
        Avg readiness per day across {workspaces.length} workspaces — earliest
        scan {series[0].day}, latest {series[series.length - 1].day}.
      </div>
    </div>
  );
}

export default function EstateOverview() {
  const { data: mode } = useAsync(detectMode);
  const { data: report, loading, error } = useAsync(() => apiGetEstate());

  if (mode && mode !== "control-plane") {
    return (
      <Empty>
        Estate overview is only available in control-plane mode (
        <code>sma serve --with-api</code>). Static-mode SPAs read a single
        run's <code>fabric_mapping.json</code> and have no way to enumerate
        other workspaces.
      </Empty>
    );
  }
  if (loading) return <div className="empty">Loading estate…</div>;
  if (error) {
    return (
      <Empty>
        Couldn't load <code>/api/estate</code>: {String(error)}
      </Empty>
    );
  }
  if (!report || report.totals.workspaces === 0) {
    return (
      <Empty>
        No completed runs found yet. Kick off a scan from the{" "}
        <Link to="/run">Run</Link> page — the overview rolls up every run on
        disk, so as soon as one finishes it'll appear here.
      </Empty>
    );
  }

  const t = report.totals;
  const cur = report.workspaces.find((w) => w.actual_currency)?.actual_currency ?? "USD";

  // Group rows by tenant + subscription so multi-tenant estates read cleanly.
  const groups = new Map<string, EstateWorkspace[]>();
  for (const ws of report.workspaces) {
    const k = `${ws.tenant_id ?? "—"} · ${ws.subscription_id ?? "—"}`;
    const arr = groups.get(k) ?? [];
    arr.push(ws);
    groups.set(k, arr);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) =>
      (a.workspace_name || "").localeCompare(b.workspace_name || ""),
    );
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div>
      <h1>
        Estate overview <HelpLink slug="overview" />
      </h1>
      <p className="muted">
        Cross-workspace, cross-time rollup of every analyzer run on disk.
        Headline numbers come from each workspace's most recent successful
        run; trend uses the last 50 runs per workspace.
      </p>

      <div className="grid cols-4">
        <StatCard label="Workspaces" value={fmtNum(t.workspaces)} />
        <StatCard label="Runs" value={fmtNum(t.runs)} />
        <StatCard label="Tenants" value={fmtNum(t.tenants)} />
        <StatCard label="Subscriptions" value={fmtNum(t.subscriptions)} />
        <StatCard
          label="Ready / w-effort / blocked"
          value={`${t.ready} / ${t.ready_with_effort} / ${t.blocked}`}
        />
        <StatCard
          label="Open blockers"
          value={fmtNum(t.blockers_total)}
          sub="across latest run per workspace"
        />
        <StatCard
          label="Avg T-SQL compatibility"
          value={
            t.tsql_compatibility_pct_avg == null ? (
              "—"
            ) : (
              <PctPill pct={Math.round(t.tsql_compatibility_pct_avg)} />
            )
          }
        />
        <StatCard
          label="Estimated SKU needed"
          value={minFabricSku(t.projected_fabric_cu_total)}
          sub={
            t.projected_fabric_cu_total == null
              ? "no capacity projection yet"
              : `min F-SKU to cover ${fmtNum(t.projected_fabric_cu_total, 1)} CU`
          }
        />
        <StatCard
          label="Actual monthly spend (Synapse)"
          value={fmtCurrency(t.actual_monthly_cost_total, cur)}
          sub="from cost module"
        />
        <StatCard
          label="Projected monthly spend (Fabric)"
          value={fmtCurrency(t.fabric_estimated_monthly_cost_total, cur)}
          sub="modeled equivalent"
        />
        <StatCard
          label="Estimated migration effort"
          value={
            t.effort_hours_p50_total == null
              ? "\u2014"
              : `${fmtNum(t.effort_hours_p50_total, 0)} h P50`
          }
          sub={
            t.effort_days_p50_total != null && t.effort_days_p90_total != null
              ? `${fmtNum(t.effort_days_p50_total, 0)} / ${fmtNum(t.effort_days_p90_total, 0)} resource-days (P50 / P90)`
              : t.effort_hours_p90_total == null
              ? "sum of runbook P50 across workspaces"
              : `${fmtNum(t.effort_hours_p90_total, 0)} h P90 \u00b7 sum of latest runs`
          }
        />
      </div>

      <ReadinessChart workspaces={report.workspaces} />

      <div className="toolbar" style={{ margin: "1rem 0 0.25rem 0" }}>
        <h2 style={{ margin: 0 }}>Workspaces</h2>
        <span style={{ flex: 1 }} />
        <Link className="btn" to="/report/print" target="_blank" rel="noreferrer">
          Export PDF report
        </Link>
        <a className="btn" href={apiEstateCsvUrl()} download>
          Export CSV
        </a>
      </div>

      {orderedGroups.map(([groupKey, rows]) => (
        <div key={groupKey} style={{ marginTop: "1rem" }}>
          <div className="label" style={{ marginBottom: "0.25rem" }}>
            <strong>Tenant · Subscription:</strong> {groupKey}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Resource group</th>
                  <th>Workspace</th>
                  <th>Last scan</th>
                  <th>Score</th>
                  <th>Bucket</th>
                  <th title="Open blockers in latest run">Blk</th>
                  <th title="Open warnings in latest run">Warn</th>
                  <th>T-SQL %</th>
                  <th title="Actual monthly Synapse spend">Actual $/mo (Synapse)</th>
                  <th title="Modeled Fabric capacity monthly spend">Projected $/mo (Fabric)</th>
                  <th title="Recommended Fabric capacity SKU">Fabric SKU</th>
                  <th title="Estimated Fabric capacity units">Proj. CU</th>
                  <th title="Estimated migration effort (runbook P50 / P90 hours)">Effort (h)</th>
                  <th title="Estimated resource-days = ceil((hours / 8) × 1.15)">Days (P50/P90)</th>
                  <th>Trend</th>
                  <th>Runs</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((ws) => (
                  <tr key={ws.key}>
                    <td className="mono">{ws.resource_group ?? "—"}</td>
                    <td>
                      <strong>{ws.workspace_name}</strong>
                    </td>
                    <td className="mono" title={ws.latest_run_id}>
                      {ws.latest_finished_at.replace("T", " ").slice(0, 16)}
                    </td>
                    <td>
                      {ws.readiness_score == null ? (
                        <span className="muted">—</span>
                      ) : (
                        <ScorePill score={Math.round(ws.readiness_score)} />
                      )}
                    </td>
                    <td>{ws.readiness_bucket ?? "—"}</td>
                    <td>{ws.blocker_count}</td>
                    <td>{ws.warning_count}</td>
                    <td>
                      <PctPill
                        pct={
                          ws.tsql_compatibility_pct == null
                            ? null
                            : Math.round(ws.tsql_compatibility_pct)
                        }
                      />
                    </td>
                    <td className="num">
                      {fmtCurrency(ws.actual_monthly_cost, ws.actual_currency)}
                    </td>
                    <td className="num">
                      {fmtCurrency(
                        ws.fabric_estimated_monthly_cost,
                        ws.actual_currency,
                      )}
                    </td>
                    <td>{ws.recommended_fabric_sku ?? "—"}</td>
                    <td className="num">{fmtNum(ws.projected_fabric_cu, 1)}</td>
                    <td
                      className="num"
                      title={
                        ws.effort_hours_p90 == null
                          ? undefined
                          : `P90: ${fmtNum(ws.effort_hours_p90, 0)} h`
                      }
                    >
                      {ws.effort_hours_p50 == null
                        ? "\u2014"
                        : `${fmtNum(ws.effort_hours_p50, 0)} / ${fmtNum(ws.effort_hours_p90, 0)}`}
                    </td>
                    <td
                      className="num"
                      title="ceil((hours / 8) × 1.15) — 8 h/day plus 15 % spillage"
                    >
                      {ws.effort_days_p50 == null
                        ? "\u2014"
                        : `${ws.effort_days_p50} / ${ws.effort_days_p90 ?? "\u2014"}`}
                    </td>
                    <td>
                      <Sparkline history={ws.history} />
                    </td>
                    <td className="num">{ws.run_count}</td>
                    <td>
                      <button
                        className="btn"
                        onClick={() => {
                          setRunIdInHash(ws.latest_run_id);
                          window.location.assign("/dashboard");
                        }}
                        title={`Open ${ws.latest_run_id} in dashboard`}
                      >
                        Open latest
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <h2 style={{ marginTop: "1.5rem" }}>Top blockers across the estate</h2>
      {report.top_blockers.length === 0 ? (
        <Empty>No open blockers across any workspace.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Area</th>
                <th>Title</th>
                <th>Fabric action</th>
                <th>Effort</th>
                <th>Workspaces</th>
                <th>Occurrences</th>
              </tr>
            </thead>
            <tbody>
              {report.top_blockers.map((b, i) => (
                <tr key={`${b.area}|${b.title}|${i}`}>
                  <td>
                    <SeverityPill severity="blocker" />
                  </td>
                  <td>{areaLabel(b.area)}</td>
                  <td>{b.title}</td>
                  <td>{b.fabric_action ?? "—"}</td>
                  <td>{effortLabel(b.effort)}</td>
                  <td className="num">{b.workspaces}</td>
                  <td className="num">{b.occurrences}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
