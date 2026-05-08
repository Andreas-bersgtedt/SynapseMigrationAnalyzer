import { useEffect, useState } from "react";
import {
  apiDeleteRunData,
  apiListRuns,
  getRunIdFromHash,
  setRunIdInHash,
  type RunMeta,
} from "../api/loader";
import HelpLink from "../components/HelpLink";

export default function RunsHistory(): JSX.Element {
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    apiListRuns(50).then(setRuns).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="empty">Error: {error}</div>;
  if (!runs) return <div className="empty">Loading…</div>;
  if (runs.length === 0) return <div className="empty">No runs yet. Start one from the Run page.</div>;

  const onDelete = async (id: string) => {
    if (!window.confirm(`Delete run ${id}? This permanently removes all artefacts on disk.`)) {
      return;
    }
    setBusyId(id);
    setActionMsg(null);
    try {
      await apiDeleteRunData(id);
      // If the deleted run was the currently selected one, drop the
      // hash/sessionStorage pin so other pages don't try to load it.
      if (getRunIdFromHash() === id) setRunIdInHash(null);
      const fresh = await apiListRuns(50);
      setRuns(fresh);
      setActionMsg(`Deleted ${id}`);
    } catch (e) {
      setActionMsg(`Delete failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="page">
      <h1>Runs <HelpLink slug="10-runs-history" /></h1>
      {actionMsg && <p className="muted">{actionMsg}</p>}
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
            const inFlight = r.status === "queued" || r.status === "running";
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
                <td style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => {
                      setRunIdInHash(r.id);
                      window.location.hash = `#run=${r.id}`;
                      window.location.pathname = "/";
                    }}
                  >
                    Open
                  </button>
                  <button
                    onClick={() => onDelete(r.id)}
                    disabled={busyId === r.id || inFlight}
                    title={
                      inFlight
                        ? "Cancel the run before deleting"
                        : "Permanently delete this run's data on disk"
                    }
                  >
                    {busyId === r.id ? "Deleting…" : "Delete"}
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
