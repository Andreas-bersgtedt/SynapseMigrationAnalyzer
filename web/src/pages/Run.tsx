import { useEffect, useRef, useState } from "react";
import {
  apiCancelRun,
  apiGetConfig,
  apiStartRun,
  detectAvailableModules,
  setRunIdInHash,
} from "../api/loader";
import { useSseProgress, type ModuleProgress, type SseEvent } from "../hooks/useSseProgress";
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

// Modules that are always executed and not exposed as user-toggleable
// checkboxes. fabric_mapping refreshes the top-line readiness/cost
// projections that other tabs depend on, so the Run page silently
// includes it in every submission.
const ALWAYS_ON_MODULES = new Set<string>(["fabric_mapping"]);
const SELECTABLE_MODULES = ALL_MODULES.filter((m) => !ALWAYS_ON_MODULES.has(m));

// Allowed lookback windows (days) for analyzers that fetch run history
// (pipelines, spark_pools, monitoring). Applied globally for the run.
const DAY_OPTIONS = [1, 3, 7, 14, 28, 60] as const;
const DEFAULT_DAYS = 14;

export default function Run(): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(SELECTABLE_MODULES),
  );
  const [label, setLabel] = useState<string>("");
  const [labelEdited, setLabelEdited] = useState<boolean>(false);
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { events, progressByModule, done, error: sseError } = useSseProgress(runId);
  // Track whether the workspace had no prior run data when this Run page
  // mounted. If so, the first successful run unlocks the rest of the nav,
  // and we want to land the user on the Overview with a fresh probe.
  const wasEmptyAtMountRef = useRef<boolean | null>(null);
  const didRedirectRef = useRef(false);

  useEffect(() => {
    detectAvailableModules()
      .then((mods) => {
        if (wasEmptyAtMountRef.current === null) {
          wasEmptyAtMountRef.current = mods.size === 0;
        }
      })
      .catch(() => {
        if (wasEmptyAtMountRef.current === null) {
          wasEmptyAtMountRef.current = true;
        }
      });
  }, []);

  // When the first run finishes on a previously-empty workspace, reload
  // into the Overview so the menu bar reflects the newly available modules.
  useEffect(() => {
    if (!done || didRedirectRef.current) return;
    if (wasEmptyAtMountRef.current !== true) return;
    didRedirectRef.current = true;
    // Full page navigation triggers a fresh module-availability probe in
    // <App/>, which is required for the nav to update.
    window.location.assign("/");
  }, [done]);

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
      // Always include the always-on modules (e.g. fabric_mapping) so the
      // top-line readiness/cost projections stay fresh, even though they
      // are hidden from the module picker.
      const modules = Array.from(new Set([...selected, ...ALWAYS_ON_MODULES]));
      const { id } = await apiStartRun(modules, label || undefined, days);
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
        <div className="actions" style={{ marginBottom: "0.5rem" }}>
          <button
            type="button"
            onClick={() => setSelected(new Set(SELECTABLE_MODULES))}
            disabled={selected.size === SELECTABLE_MODULES.length}
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={selected.size === 0}
          >
            Unselect all
          </button>
          <span className="muted">
            {selected.size} of {SELECTABLE_MODULES.length} selected
          </span>
        </div>
        <div className="checkbox-grid">
          {SELECTABLE_MODULES.map((m) => (
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
        <label style={{ display: "block" }}>
          <span style={{ display: "block", marginBottom: 4 }}>
            Lookback window (days)
          </span>
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
            title="Global lookback window applied to pipelines, Spark, and monitoring run-history fetches."
          >
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>
            ))}
          </select>
          <span
            className="muted"
            style={{ display: "block", marginTop: 4, fontSize: "0.85em" }}
          >
            Applied to pipelines, Spark history, and monitoring.
          </span>
        </label>
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
          <button onClick={start}>
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
          <ProgressList events={events} progressByModule={progressByModule} />
          {done && wasEmptyAtMountRef.current === true && (
            <p>Run finished — loading the Overview…</p>
          )}
          {done && wasEmptyAtMountRef.current !== true && (
            <p>Run finished. Switch pages to inspect results.</p>
          )}
        </div>
      )}
    </section>
  );
}

function ProgressList({
  events,
  progressByModule,
}: {
  events: SseEvent[];
  progressByModule: Record<string, ModuleProgress>;
}): JSX.Element {
  // Collapse to one row per module: keep the latest non-progress event per
  // module (so the pill reflects started/finished state, not noise from the
  // many ``module_progress`` events).
  const byModule = new Map<string, SseEvent>();
  for (const ev of events) {
    if (typeof ev.module !== "string") continue;
    if (ev.type === "module_progress") continue;
    byModule.set(ev.module, ev);
  }
  // Also surface modules that have only emitted progress events so far.
  for (const mod of Object.keys(progressByModule)) {
    if (!byModule.has(mod)) {
      byModule.set(mod, { type: "module_started", module: mod });
    }
  }
  return (
    <ul className="run-progress">
      {[...byModule.entries()].map(([mod, ev]) => {
        const state =
          (ev.state as string) ?? (ev.type === "module_started" ? "running" : "?");
        const cls =
          state === "ok"
            ? "ok"
            : state === "failed"
            ? "err"
            : state === "running"
            ? "warn"
            : "muted";
        const prog = progressByModule[mod];
        const showBar = state === "running" && prog && prog.total > 0;
        const pct = showBar
          ? Math.min(100, Math.round((prog!.current / prog!.total) * 100))
          : null;
        return (
          <li key={mod}>
            <span className={`pill ${cls}`} title={state}>
              {stateLabel(state)}
            </span>{" "}
            <span title={mod}>{moduleLabel(mod)}</span>
            {typeof ev.duration_ms === "number" && (
              <span className="muted"> {(ev.duration_ms / 1000).toFixed(1)}s</span>
            )}
            {typeof ev.error === "string" && (
              <span className="muted"> — {ev.error}</span>
            )}
            {showBar && (
              <div className="run-progress-bar">
                <progress max={prog!.total} value={prog!.current} />
                <span className="muted">
                  {" "}
                  {prog!.current} / {prog!.total}
                  {pct !== null ? ` (${pct}%)` : ""}
                  {prog!.label ? ` · ${prog!.label}` : ""}
                </span>
              </div>
            )}
            {!showBar && prog && prog.label && state === "running" && (
              <span className="muted"> · {prog.label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
