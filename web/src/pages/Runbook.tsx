import { useMemo } from "react";
import { loadFabricMapping } from "../api/loader";
import { useAsync } from "../hooks/useAsync";
import { Empty, SeverityPill } from "../components/Atoms";
import HelpLink from "../components/HelpLink";
import { effortLabel, phaseLabel } from "../lib/labels";

export default function Runbook() {
  const { data, loading } = useAsync(loadFabricMapping);

  const byPhase = useMemo(() => {
    const out = new Map<string, typeof data extends null ? never : NonNullable<typeof data>["runbook"]>();
    for (const s of data?.runbook ?? []) {
      const arr = out.get(s.phase) ?? [];
      arr.push(s);
      out.set(s.phase, arr);
    }
    for (const arr of out.values()) arr.sort((a, b) => a.order - b.order);
    return out;
  }, [data]);

  if (loading) return <div className="empty">Loading…</div>;
  if (!data || (data.runbook ?? []).length === 0)
    return <Empty>No runbook generated.</Empty>;

  const es = data.effort_summary;

  return (
    <>
      <h1>Migration runbook <HelpLink slug="07-runbook" /></h1>
      {es && (
        <section className="card" style={{ margin: "0.5rem 0 1rem 0" }}>
          <div className="label" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span>
              Estimated effort:{" "}
              <strong>{es.total_p50_hours.toFixed(1)} h P50</strong>{" /"}
              {" "}<strong>{es.total_p90_hours.toFixed(1)} h P90</strong>
              {es.total_p50_days != null && es.total_p90_days != null && (
                <>
                  {" — "}
                  <strong>{es.total_p50_days} P50</strong>
                  {" / "}
                  <strong>{es.total_p90_days} P90</strong>{" resource-days"}
                </>
              )}
            </span>
            <span className="small muted">
              · rate card{" "}
              {es.card_source === "default" ? (
                <span className="pill info">shipped default</span>
              ) : (
                <code title={es.card_source}>override</code>
              )}{" "}
              (v{es.card_version})
              {" · "}
              <a href="/configuration">edit on Configuration ▸ Effort card</a>
              {" · "}
              <HelpLink slug="19-effort" />
            </span>
            {es.total_p50_days != null && (
              <span
                className="small muted"
                title="Resource-days = ceil((hours / 8) × 1.15) — 8 h/day plus 15 % spillage."
                style={{ width: "100%" }}
              >
                Days computed as <code>ceil((hours / 8) × 1.15)</code> — 8 h/day plus 15 % spillage.
              </span>
            )}
          </div>
          {es.per_phase.length > 0 && (
            <table className="small" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th>Phase</th>
                  <th className="num">Steps</th>
                  <th className="num">P50 (h)</th>
                  <th className="num">P90 (h)</th>
                  <th className="num" title="Resource-days at P50">P50 (d)</th>
                  <th className="num" title="Resource-days at P90">P90 (d)</th>
                </tr>
              </thead>
              <tbody>
                {es.per_phase.map((p) => (
                  <tr key={p.phase}>
                    <td>{phaseLabel(p.phase)}</td>
                    <td className="num">{p.step_count}</td>
                    <td className="num">{p.p50_hours.toFixed(1)}</td>
                    <td className="num">{p.p90_hours.toFixed(1)}</td>
                    <td className="num">{p.p50_days ?? "—"}</td>
                    <td className="num">{p.p90_days ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {Array.from(byPhase.entries()).map(([phase, steps]) => (
        <section className="section" key={phase}>
          <h2 title={phase}>{phaseLabel(phase)}</h2>
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Step</th>
                <th>Severity</th>
                <th>Effort</th>
                <th className="num" title="50th-percentile estimate">P50 (h)</th>
                <th className="num" title="90th-percentile estimate">P90 (h)</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => {
                const breakdown = s.effort_breakdown;
                const tooltip = breakdown?.components?.length
                  ? breakdown.components.join(" + ")
                  : undefined;
                return (
                  <tr key={`${phase}-${s.order}`}>
                    <td className="num">{s.order}</td>
                    <td>
                      <details>
                        <summary>{s.title}</summary>
                        <div className="small" style={{ marginTop: 6 }}>{s.detail}</div>
                        {s.rollback && (
                          <div className="small muted" style={{ marginTop: 6 }}>
                            <strong>Rollback:</strong> {s.rollback}
                          </div>
                        )}
                        {breakdown?.components && breakdown.components.length > 0 && (
                          <div className="small muted" style={{ marginTop: 6 }}>
                            <strong>Effort breakdown:</strong> {breakdown.components.join(" + ")}
                            {breakdown.capped ? " (capped)" : ""}
                          </div>
                        )}
                      </details>
                    </td>
                    <td><SeverityPill severity={s.severity} /></td>
                    <td title={s.effort}>{effortLabel(s.effort)}</td>
                    <td className="num" title={tooltip}>
                      {s.effort_hours_p50 != null ? s.effort_hours_p50.toFixed(1) : ""}
                    </td>
                    <td className="num" title={tooltip}>
                      {s.effort_hours_p90 != null ? s.effort_hours_p90.toFixed(1) : ""}
                    </td>
                    <td className="small muted">{s.target}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
