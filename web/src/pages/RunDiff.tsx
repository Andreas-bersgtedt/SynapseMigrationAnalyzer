import { useEffect, useState } from "react";
import { apiGetDiff, apiListRuns, getRunIdFromHash, type RunMeta } from "../api/loader";
import HelpLink from "../components/HelpLink";

type DiffResponse = {
  base: string | null;
  head: string;
  summary: Record<string, number>;
  delta: Array<{
    path: string;
    kind: string;
    detail?: string;
    count_before?: number | null;
    count_after?: number | null;
  }>;
};

export default function RunDiff(): JSX.Element {
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [head, setHead] = useState<string | null>(getRunIdFromHash());
  const [base, setBase] = useState<string | undefined>(undefined);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiListRuns(50)
      .then((list) => {
        setRuns(list);
        if (!head && list[0]) setHead(list[0].id);
      })
      .catch((e: Error) => setError(e.message));
  }, [head]);

  useEffect(() => {
    if (!head) return;
    setDiff(null);
    apiGetDiff(head, base).then((d) => setDiff(d as DiffResponse)).catch((e: Error) => setError(e.message));
  }, [head, base]);

  if (error) return <div className="empty">Error: {error}</div>;

  return (
    <section className="page">
      <h1>Run delta <HelpLink slug="11-diff-page" /></h1>
      <div className="actions">
        <label>
          <span>Head</span>{" "}
          <select value={head ?? ""} onChange={(e) => setHead(e.target.value || null)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>{r.id}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Base</span>{" "}
          <select value={base ?? ""} onChange={(e) => setBase(e.target.value || undefined)}>
            <option value="">previous run (auto)</option>
            {runs.filter((r) => r.id !== head).map((r) => (
              <option key={r.id} value={r.id}>{r.id}</option>
            ))}
          </select>
        </label>
      </div>

      {!diff && head && <div className="empty">Loading…</div>}

      {diff && (
        <>
          <div className="card">
            <div className="label">Summary</div>
            <ul>
              {Object.entries(diff.summary).map(([k, v]) => (
                <li key={k}><code>{k}</code>: {v}</li>
              ))}
            </ul>
            <div className="muted">base: {diff.base ?? "—"} → head: {diff.head}</div>
          </div>

          <table className="table" style={{ marginTop: "1rem" }}>
            <thead>
              <tr>
                <th>Path</th>
                <th>Kind</th>
                <th>Before</th>
                <th>After</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {diff.delta.map((d, i) => (
                <tr key={i}>
                  <td><code>{d.path}</code></td>
                  <td>
                    <span className={`pill ${d.kind === "added" ? "ok" : d.kind === "removed" ? "err" : "warn"}`}>
                      {d.kind}
                    </span>
                  </td>
                  <td>{d.count_before ?? "—"}</td>
                  <td>{d.count_after ?? "—"}</td>
                  <td className="muted">{d.detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
