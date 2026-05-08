import { useEffect, useState } from "react";
import { apiCancelRun, apiGetConfig, apiStartRun, setRunIdInHash } from "../api/loader";
import { useSseProgress, type SseEvent } from "../hooks/useSseProgress";
import HelpLink from "../components/HelpLink";
import { moduleLabel, stateLabel } from "../lib/labels";

const ALL_MODULES = [
  "dedicated_pools",
  "serverless_pools",
  "spark_pools",
  "pipelines",
  "monitoring",
  "storage",
  "fabric_mapping",
  "governance",
  "security",
  "cost",
  "fabric_validation",
];

export default function Run(): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(ALL_MODULES),
  );
  const [label, setLabel] = useState<string>("");
  const [labelEdited, setLabelEdited] = useState<boolean>(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { events, done, error: sseError } = useSseProgress(runId);

  useEffect(() => {
    let cancelled = false;
    apiGetConfig()
      .then((cfg) => {
        if (cancelled) return;
        const ws = cfg.azure.workspace_name;
        if (ws && !labelEdited) setLabel((prev) => (prev ? prev : ws));
      })
      .catch(() => {
        /* ignore – label default is best-effort */
      });
    return () => {
      cancelled = true;
    };
    // Only run once on mount; labelEdited guards future overwrites.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (m: string) => {
    const next = new Set(selected);
    if (next.has(m)) next.delete(m);
    else next.add(m);
    setSelected(next);
  };

  const start = async () => {
    setError(null);
    try {
      const { id } = await apiStartRun([...selected], label || undefined);
      setRunId(id);
      setRunIdInHash(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cancel = async () => {
    if (!runId) return;
    try {
      await apiCancelRun(runId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="page">
      <h1>Run analysis <HelpLink slug="09-run-page" /></h1>
      <p className="muted">
        Select which analyzer modules to run. Results are written to
        <code> runs/&lt;id&gt;/</code> and shown live below.
      </p>

      <fieldset disabled={runId !== null && !done}>
        <legend>Modules</legend>
        <div className="checkbox-grid">
          {ALL_MODULES.map((m) => (
            <label key={m} title={m}>
              <input
                type="checkbox"
                checked={selected.has(m)}
                onChange={() => toggle(m)}
              />
              <span>{moduleLabel(m)}</span>
            </label>
          ))}
        </div>
        <label>
          <span>Label (optional)</span>
          <input
            type="text"
            value={label}
            onChange={(e) => {
              setLabelEdited(true);
              setLabel(e.target.value);
            }}
            placeholder="e.g. dry-run before retire"
          />
        </label>
        <div className="actions">
          <button onClick={start} disabled={selected.size === 0}>
            Start run
          </button>
          {runId && !done && <button onClick={cancel}>Cancel</button>}
        </div>
      </fieldset>

      {error && <div className="empty">Error: {error}</div>}
      {sseError && <div className="empty">Stream: {sseError}</div>}

      {runId && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <div className="label">Run {runId}</div>
          <ProgressList events={events} />
          {done && <p>Run finished. Switch pages to inspect results.</p>}
        </div>
      )}
    </section>
  );
}

function ProgressList({ events }: { events: SseEvent[] }): JSX.Element {
  // Collapse to one row per module: keep the latest event per module.
  const byModule = new Map<string, SseEvent>();
  for (const ev of events) {
    if (typeof ev.module === "string") byModule.set(ev.module, ev);
  }
  return (
    <ul>
      {[...byModule.entries()].map(([mod, ev]) => {
        const state = (ev.state as string) ?? (ev.type === "module_started" ? "running" : "?");
        const cls = state === "ok" ? "ok" : state === "failed" ? "err" : state === "running" ? "warn" : "muted";
        return (
          <li key={mod}>
            <span className={`pill ${cls}`} title={state}>{stateLabel(state)}</span>{" "}
            <span title={mod}>{moduleLabel(mod)}</span>
            {typeof ev.duration_ms === "number" && (
              <span className="muted"> {(ev.duration_ms / 1000).toFixed(1)}s</span>
            )}
            {typeof ev.error === "string" && (
              <span className="muted"> — {ev.error}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
