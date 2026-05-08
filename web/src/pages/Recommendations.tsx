import { useMemo, useState } from "react";
import { loadFabricMapping } from "../api/loader";
import { useAsync } from "../hooks/useAsync";
import { Empty, SeverityPill } from "../components/Atoms";
import HelpLink from "../components/HelpLink";
import { areaLabel, effortLabel } from "../lib/labels";

const SEV_ORDER = { blocker: 0, warning: 1, info: 2 } as Record<string, number>;

export default function Recommendations() {
  const { data, loading } = useAsync(loadFabricMapping);
  const [filter, setFilter] = useState("");
  const [sev, setSev] = useState("");
  const [area, setArea] = useState("");

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    return data.recommendations
      .filter((r) => {
        if (sev && r.severity !== sev) return false;
        if (area && r.area !== area) return false;
        if (!q) return true;
        return [r.id, r.title, r.detail, r.area, r.target ?? "", r.fabric_action ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .sort(
        (a, b) =>
          (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) ||
          a.area.localeCompare(b.area),
      );
  }, [data, filter, sev, area]);

  if (loading) return <div className="empty">Loading…</div>;
  if (!data || data.recommendations.length === 0)
    return <Empty>No recommendations to show.</Empty>;

  const areas = Array.from(new Set(data.recommendations.map((r) => r.area))).sort();

  return (
    <>
      <h1>Recommendations <HelpLink slug="06-recommendations" /></h1>
      <div className="toolbar">
        <input
          placeholder="Filter (id, title, detail, target)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select value={sev} onChange={(e) => setSev(e.target.value)}>
          <option value="">All severities</option>
          <option value="blocker">Blocker</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <select value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">All areas</option>
          {areas.map((a) => <option key={a} value={a}>{areaLabel(a)}</option>)}
        </select>
        <span className="muted small">
          {filtered.length} / {data.recommendations.length}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Severity</th><th>Effort</th><th>Area</th><th>Target</th>
            <th>Title</th><th>Fabric action</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.id}>
              <td><SeverityPill severity={r.severity} /></td>
              <td title={r.effort}>{effortLabel(r.effort)}</td>
              <td className="small" title={r.area}>{areaLabel(r.area)}</td>
              <td className="small muted">{r.target}</td>
              <td>
                <details>
                  <summary>{r.title}</summary>
                  <div className="small" style={{ marginTop: 6 }}>{r.detail}</div>
                </details>
              </td>
              <td className="small muted">{r.fabric_action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
