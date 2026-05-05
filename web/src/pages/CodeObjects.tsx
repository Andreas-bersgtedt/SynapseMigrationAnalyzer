import { useMemo, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { loadDedicatedPools } from "../api/loader";
import { useAsync } from "../hooks/useAsync";
import { Empty, SeverityPill } from "../components/Atoms";
import type { CodeObject, TsqlSurfaceGap } from "../types";

interface Row extends CodeObject {
  pool: string;
  gaps: TsqlSurfaceGap[];
}

const columnHelper = createColumnHelper<Row>();

export default function CodeObjects() {
  const { data, loading } = useAsync(loadDedicatedPools);
  const [filter, setFilter] = useState("");
  const [compatFilter, setCompatFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "compatibility", desc: false },
    { id: "gap_count", desc: true },
  ]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows: Row[] = useMemo(() => {
    if (!data) return [];
    const out: Row[] = [];
    for (const pool of data.pools) {
      const gapsByObj = new Map<string, TsqlSurfaceGap[]>();
      for (const g of pool.tsql_surface_gaps ?? []) {
        const arr = gapsByObj.get(g.code_object_id) ?? [];
        arr.push(g);
        gapsByObj.set(g.code_object_id, arr);
      }
      for (const o of pool.code_objects ?? []) {
        out.push({
          ...o,
          pool: pool.inventory.name,
          gaps: gapsByObj.get(o.code_object_id ?? "") ?? [],
        });
      }
    }
    return out;
  }, [data]);

  const columns = useMemo(
    () => [
      columnHelper.accessor("pool", { header: "Pool" }),
      columnHelper.accessor((r) => `${r.schema_name}.${r.object_name}`, {
        id: "qualified_name",
        header: "Object",
        cell: (info) => <code>{info.getValue()}</code>,
      }),
      columnHelper.accessor("object_type", {
        header: "Type",
        cell: (i) => <span className="small muted">{i.getValue()}</span>,
      }),
      columnHelper.accessor((r) => r.compatibility ?? "compatible", {
        id: "compatibility",
        header: "Compatibility",
        cell: (i) => <SeverityPill severity={i.getValue() as string} />,
        sortingFn: (a, b) => {
          const order = { incompatible: 0, needs_review: 1, compatible: 2 } as Record<string, number>;
          return (order[a.getValue("compatibility") as string] ?? 3) -
                 (order[b.getValue("compatibility") as string] ?? 3);
        },
      }),
      columnHelper.accessor((r) => r.line_count ?? 0, {
        id: "line_count",
        header: () => <span className="num">Lines</span>,
        cell: (i) => <span className="num">{i.getValue() || ""}</span>,
      }),
      columnHelper.accessor((r) => r.parameter_count ?? 0, {
        id: "param_count",
        header: () => <span className="num">Params</span>,
        cell: (i) => <span className="num">{i.getValue()}</span>,
      }),
      columnHelper.accessor((r) => r.gap_count ?? 0, {
        id: "gap_count",
        header: () => <span className="num">T-SQL gaps</span>,
        cell: (i) => <span className="num">{i.getValue()}</span>,
      }),
    ],
    [],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (compatFilter && (r.compatibility ?? "compatible") !== compatFilter) return false;
      if (typeFilter && r.object_type !== typeFilter) return false;
      if (!q) return true;
      const hay = [
        r.pool, r.schema_name, r.object_name, r.object_type,
        r.code_object_id, r.compatibility,
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [rows, filter, compatFilter, typeFilter]);

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (loading) return <div className="empty">Loading…</div>;
  if (!data || rows.length === 0)
    return <Empty>No code objects collected. Run the dedicated_pools module.</Empty>;

  const types = Array.from(new Set(rows.map((r) => r.object_type))).sort();

  return (
    <>
      <h1>Code objects (SQL plane)</h1>
      <div className="muted small" style={{ marginBottom: 12 }}>
        {rows.length} object(s) across {data.pools.length} pool(s)
      </div>

      <div className="toolbar">
        <input
          placeholder="Filter (schema, name, id, type)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select value={compatFilter} onChange={(e) => setCompatFilter(e.target.value)}>
          <option value="">All compatibility</option>
          <option value="incompatible">Incompatible</option>
          <option value="needs_review">Needs review</option>
          <option value="compatible">Compatible</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <span className="muted small">{filtered.length} match(es)</span>
      </div>

      <table>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id} onClick={h.column.getToggleSortingHandler()}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  <span className="sort">
                    {h.column.getIsSorted() === "asc" ? "▲" :
                     h.column.getIsSorted() === "desc" ? "▼" : ""}
                  </span>
                </th>
              ))}
              <th />
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r) => {
            const orig = r.original;
            const key = `${orig.pool}.${orig.code_object_id}`;
            const isOpen = expanded === key;
            return (
              <>
                <tr key={key}>
                  {r.getVisibleCells().map((c) => (
                    <td key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>
                  ))}
                  <td>
                    <button
                      onClick={() => setExpanded(isOpen ? null : key)}
                      style={{
                        background: "transparent", color: "var(--accent)",
                        border: "none", cursor: "pointer", padding: 0,
                      }}
                    >
                      {isOpen ? "Hide" : "Details"}
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={r.getVisibleCells().length + 1}>
                      <DetailPanel row={orig} />
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function DetailPanel({ row }: { row: Row }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="small muted">
        <code>{row.code_object_id}</code>
        {row.create_date && <> · created {row.create_date}</>}
        {row.modify_date && <> · modified {row.modify_date}</>}
        {row.definition_length != null && <> · {row.definition_length} chars</>}
      </div>

      {row.parameters && row.parameters.length > 0 && (
        <div>
          <h3>Parameters ({row.parameter_count})</h3>
          <table>
            <thead>
              <tr>
                <th className="num">#</th><th>Name</th><th>Type</th>
                <th className="num">Max len</th><th>Output</th><th>Default</th>
              </tr>
            </thead>
            <tbody>
              {row.parameters.map((p) => (
                <tr key={p.ordinal}>
                  <td className="num">{p.ordinal}</td>
                  <td><code>{p.parameter_name}</code></td>
                  <td>{p.data_type}</td>
                  <td className="num">{p.max_length ?? ""}</td>
                  <td>{p.is_output ? "yes" : ""}</td>
                  <td>{p.has_default ? "yes" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {row.gaps.length > 0 && (
        <div>
          <h3>T-SQL surface gaps</h3>
          <table>
            <thead>
              <tr><th>Rule</th><th>Severity</th><th className="num">Matches</th><th>Fabric action</th></tr>
            </thead>
            <tbody>
              {row.gaps.map((g, i) => (
                <tr key={i}>
                  <td>{g.label} <span className="muted small">({g.rule_id})</span></td>
                  <td><SeverityPill severity={g.severity} /></td>
                  <td className="num">{g.matches}</td>
                  <td className="small muted">{g.fabric_action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {row.definition && (
        <details>
          <summary>Definition <span className="muted small">(truncated to 50 KB by collector)</span></summary>
          <pre>{row.definition}</pre>
        </details>
      )}
    </div>
  );
}
