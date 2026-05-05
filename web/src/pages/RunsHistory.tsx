import { useEffect, useState } from "react";
import { apiListRuns, setRunIdInHash, type RunMeta } from "../api/loader";

export default function RunsHistory(): JSX.Element {
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiListRuns(50).then(setRuns).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="empty">Error: {error}</div>;
  if (!runs) return <div className="empty">Loading…</div>;
  if (runs.length === 0) return <div className="empty">No runs yet. Start one from the Run page.</div>;

  return (
    <section className="page">
      <h1>Runs</h1>
      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Label</th>
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Errors</th>
            <th>Score</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const dur =
              r.finished_at && r.started_at
                ? (
                    (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) /
                    1000
                  ).toFixed(1) + "s"
                : "—";
            return (
              <tr key={r.id}>
                <td><code>{r.id}</code></td>
                <td>{r.label ?? <span className="muted">—</span>}</td>
                <td>
                  <span className={`pill ${r.status === "ok" ? "ok" : r.status === "failed" ? "err" : "warn"}`}>
                    {r.status}
                  </span>
                </td>
                <td className="muted">{r.started_at}</td>
                <td>{dur}</td>
                <td>{r.errors_count}</td>
                <td>{r.readiness_score != null ? r.readiness_score.toFixed(0) : "—"}</td>
                <td>
                  <button
                    onClick={() => {
                      setRunIdInHash(r.id);
                      window.location.hash = `#run=${r.id}`;
                      window.location.pathname = "/";
                    }}
                  >
                    Open
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
