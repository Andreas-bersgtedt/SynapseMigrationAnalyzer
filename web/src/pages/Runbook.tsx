import { useMemo } from "react";
import { loadFabricMapping } from "../api/loader";
import { useAsync } from "../hooks/useAsync";
import { Empty, SeverityPill } from "../components/Atoms";
import HelpLink from "../components/HelpLink";

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

  return (
    <>
      <h1>Migration runbook <HelpLink slug="07-runbook" /></h1>
      {Array.from(byPhase.entries()).map(([phase, steps]) => (
        <section className="section" key={phase}>
          <h2>{phase}</h2>
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Step</th>
                <th>Severity</th>
                <th>Effort</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
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
                    </details>
                  </td>
                  <td><SeverityPill severity={s.severity} /></td>
                  <td>{s.effort}</td>
                  <td className="small muted">{s.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
