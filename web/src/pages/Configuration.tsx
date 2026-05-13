import { useEffect, useState } from "react";
import HelpLink from "../components/HelpLink";
import {
  apiExportRunsArchive,
  apiGetConfig,
  apiGetEffortCard,
  apiImportRunsArchive,
  apiPutConfig,
  apiPutEffortCard,
  apiResetEffortCard,
  apiValidateConfig,
  type AppConfig,
  type EffortCardResponse,
  type RunsImportMode,
  type RunsImportResult,
  type ValidateResponse,
  type WorkspaceSummary,
} from "../api/loader";

const FIELDS = [
  ["azure", "tenant_id", "Tenant ID"],
  ["azure", "client_id", "Client ID"],
  ["azure", "subscription_id", "Subscription ID"],
  ["azure", "dedicated_pool", "Dedicated pool (optional)"],
  ["sql", "odbc_driver", "ODBC driver"],
] as const;

const CUSTOM_WORKSPACE = "__custom__";

function workspaceKey(rg: string | null, name: string | null): string {
  if (!rg || !name) return "";
  return `${rg}/${name}`;
}

export default function Configuration(): JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string>("");
  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [customWorkspace, setCustomWorkspace] = useState(false);

  useEffect(() => {
    apiGetConfig().then(setCfg).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="empty">Error loading config: {error}</div>;
  if (!cfg) return <div className="empty">Loading…</div>;

  const update = (group: "azure" | "sql", key: string, value: string) => {
    setCfg({
      ...cfg,
      [group]: { ...cfg[group], [key]: value },
    });
  };

  const updateWorkspace = (name: string, resource_group: string) => {
    setCfg({
      ...cfg,
      azure: { ...cfg.azure, workspace_name: name, resource_group },
    });
  };

  const onSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: Record<string, unknown> = {
        azure: { ...cfg.azure },
        sql: { ...cfg.sql },
      };
      if (secret) (body.azure as Record<string, unknown>).client_secret = secret;
      else delete (body.azure as Record<string, unknown>).client_secret;
      const r = await apiPutConfig(body);
      setSaveMsg(`Saved to ${r.saved_to}` + (r.warnings.length ? ` (${r.warnings.join("; ")})` : ""));
      setSecret("");
      const fresh = await apiGetConfig();
      setCfg(fresh);
    } catch (e) {
      setSaveMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const onValidate = async (live: boolean) => {
    setValidating(true);
    setValidation(null);
    try {
      const r = await apiValidateConfig({ live });
      setValidation(r);
      if (live && r.workspaces) setWorkspaces(r.workspaces);
    } catch (e) {
      setSaveMsg(`Validate failed: ${(e as Error).message}`);
    } finally {
      setValidating(false);
    }
  };

  const onDiscoverWorkspaces = async () => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const r = await apiValidateConfig({ live: true });
      setValidation(r);
      setWorkspaces(r.workspaces ?? []);
    } catch (e) {
      setDiscoverError((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <section className="page">
      <h1>Configuration <HelpLink slug="12-configuration" /></h1>
      <p className="muted">
        Edit the connection settings persisted to <code>{cfg.env_file}</code>.
        The client secret is never returned by the API — its current status is
        shown as <code>{cfg.azure.client_secret}</code> (<em>set</em> or <em>unset</em>).
      </p>

      <div className="form-grid">
        {FIELDS.map(([group, key, label]) => (
          <label key={`${group}.${key}`}>
            <span>{label}</span>
            <input
              type="text"
              value={(cfg[group] as Record<string, string | null>)[key] ?? ""}
              onChange={(e) => update(group, key, e.target.value)}
            />
          </label>
        ))}
        <label>
          <span>Client secret ({cfg.azure.client_secret})</span>
          <input
            type="password"
            placeholder={cfg.azure.client_secret === "set" ? "leave blank to keep" : "paste new value"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
          />
        </label>
      </div>

      {(() => {
        const currentKey = workspaceKey(cfg.azure.resource_group, cfg.azure.workspace_name);
        const list = workspaces ?? [];
        const knownKeys = new Set(list.map((w) => workspaceKey(w.resource_group, w.name)));
        const currentInList = currentKey !== "" && knownKeys.has(currentKey);
        const showCustom = customWorkspace || (!currentInList && currentKey !== "" && list.length > 0);
        const useDropdown = list.length > 0 && !showCustom;
        return (
          <div className="card" style={{ marginTop: "1rem" }}>
            <div className="label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Synapse workspace</span>
              <button
                type="button"
                onClick={onDiscoverWorkspaces}
                disabled={discovering || saving}
                title="List Synapse workspaces in the configured subscription"
              >
                {discovering ? "Discovering…" : workspaces ? "Refresh list" : "Discover workspaces"}
              </button>
              {workspaces && (
                <span className="small muted">
                  {list.length} workspace{list.length === 1 ? "" : "s"} in subscription
                </span>
              )}
              {discoverError && <span className="small" style={{ color: "var(--err, #c33)" }}>{discoverError}</span>}
            </div>

            {useDropdown ? (
              <div className="form-grid" style={{ marginTop: 6 }}>
                <label>
                  <span>Workspace</span>
                  <select
                    value={currentInList ? currentKey : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === CUSTOM_WORKSPACE) {
                        setCustomWorkspace(true);
                        return;
                      }
                      const ws = list.find(
                        (w) => workspaceKey(w.resource_group, w.name) === v,
                      );
                      if (ws) updateWorkspace(ws.name, ws.resource_group);
                    }}
                  >
                    {!currentInList && (
                      <option value="" disabled>
                        — select a workspace —
                      </option>
                    )}
                    {list.map((w) => (
                      <option
                        key={workspaceKey(w.resource_group, w.name)}
                        value={workspaceKey(w.resource_group, w.name)}
                      >
                        {w.name} ({w.resource_group}
                        {w.location ? `, ${w.location}` : ""})
                        {w.is_current ? " — current" : ""}
                      </option>
                    ))}
                    <option value={CUSTOM_WORKSPACE}>Enter manually…</option>
                  </select>
                </label>
              </div>
            ) : (
              <div className="form-grid" style={{ marginTop: 6 }}>
                <label>
                  <span>Workspace name</span>
                  <input
                    type="text"
                    value={cfg.azure.workspace_name ?? ""}
                    onChange={(e) => update("azure", "workspace_name", e.target.value)}
                  />
                </label>
                <label>
                  <span>Resource group</span>
                  <input
                    type="text"
                    value={cfg.azure.resource_group ?? ""}
                    onChange={(e) => update("azure", "resource_group", e.target.value)}
                  />
                </label>
                {list.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCustomWorkspace(false)}
                    style={{ alignSelf: "end" }}
                  >
                    Pick from list
                  </button>
                )}
              </div>
            )}

            {!workspaces && (
              <p className="small muted" style={{ marginTop: 6 }}>
                Tip: click <em>Discover workspaces</em> to populate a dropdown of
                Synapse workspaces accessible to the configured service principal.
              </p>
            )}
          </div>
        );
      })()}

      <div className="actions">
        <button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save configuration"}
        </button>
        <button onClick={() => onValidate(false)} disabled={validating} title="Local checks only: env vars present, GUIDs well-formed, output directory writable">
          {validating ? "Validating…" : "Validate fields"}
        </button>
        <button onClick={() => onValidate(true)} disabled={validating} title="Field checks plus live Azure + Synapse connectivity using the saved service principal">
          {validating ? "Testing…" : "Validate live access"}
        </button>
        {saveMsg && <span className="muted">{saveMsg}</span>}
      </div>

      {validation && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <div className="label">
            Validation —{" "}
            <span className={`pill ${validation.ok ? "ok" : "err"}`}>
              {validation.ok ? "All OK" : "Failed"}
            </span>
          </div>
          {(() => {
            // Group by category, preserving insertion order.
            const groups = new Map<string, typeof validation.checks>();
            for (const c of validation.checks) {
              const k = c.category || "Configuration";
              if (!groups.has(k)) groups.set(k, []);
              groups.get(k)!.push(c);
            }
            return Array.from(groups.entries()).map(([cat, items]) => (
              <div key={cat} style={{ marginTop: "0.5rem" }}>
                <div className="small muted" style={{ fontWeight: 600 }}>{cat}</div>
                <ul>
                  {items.map((c) => (
                    <li key={c.name}>
                      <span className={`pill ${c.ok ? "ok" : "err"}`}>{c.ok ? "OK" : "Fail"}</span>{" "}
                      <code>{c.name}</code>
                      {c.detail && <span className="muted"> — {c.detail}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ));
          })()}

          {validation.workspaces && validation.workspaces.length > 0 && (
            <div className="small muted" style={{ marginTop: "0.75rem" }}>
              {validation.workspaces.length} accessible Synapse workspace
              {validation.workspaces.length === 1 ? "" : "s"} — pick one in the
              <em> Synapse workspace</em> selector above.
            </div>
          )}
        </div>
      )}

      <EffortCardEditor />
      <RunsBackupRestore />
    </section>
  );
}

/**
 * Collapsible **webform** editor for the configurable effort-rate card.
 *
 * Lives behind a `<details>` so the Configuration page stays clean for
 * the 99 % of users who never touch it. When opened it fetches the
 * *effective* card (defaults merged with any override on disk) and
 * renders it as labelled number inputs grouped into General /
 * Qualitative fallback / Phase base hours / Rules — consistent with
 * the rest of the Configuration page (no raw JSON). Save PUTs to
 * `/api/effort-card`; Reset DELETEs the override file.
 */
type RateCard = {
  version?: number;
  team_velocity?: number;
  confidence_p50_to_p90_multiplier?: number;
  qualitative?: Record<string, number>;
  phases?: Record<string, { base_hours?: number }>;
  rules?: Record<string, Record<string, number>>;
};

function humanize(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function NumberField({
  label,
  value,
  step = 0.1,
  min = 0,
  onChange,
  hint,
}: {
  label: string;
  value: number | undefined;
  step?: number;
  min?: number;
  onChange: (v: number) => void;
  hint?: string;
}): JSX.Element {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        margin: "0.25rem 0",
      }}
    >
      <span style={{ minWidth: 220, fontSize: 13 }}>
        {label}
        {hint && (
          <span className="small muted" style={{ marginLeft: 4 }}>
            ({hint})
          </span>
        )}
      </span>
      <input
        type="number"
        step={step}
        min={min}
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? 0 : Number(v));
        }}
        style={{ width: 110, padding: "2px 6px", fontSize: 13 }}
      />
    </label>
  );
}

function EffortCardEditor(): JSX.Element {
  const [info, setInfo] = useState<EffortCardResponse | null>(null);
  const [card, setCard] = useState<RateCard | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    try {
      const r = await apiGetEffortCard();
      setInfo(r);
      setCard(r.card as RateCard);
    } catch (e) {
      setMsg(`Load failed: ${(e as Error).message}`);
    } finally {
      setLoaded(true);
    }
  };

  const onToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && !loaded) load();
  };

  const onSave = async () => {
    if (!card) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiPutEffortCard(card as Record<string, unknown>);
      setMsg(`Saved to ${r.saved_to}`);
      await load();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onReset = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await apiResetEffortCard();
      setMsg("Override removed — shipped defaults are now in effect.");
      await load();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const setTop = <K extends keyof RateCard>(k: K, v: RateCard[K]) => {
    if (!card) return;
    setCard({ ...card, [k]: v });
  };

  const setQual = (key: string, v: number) => {
    if (!card) return;
    setCard({
      ...card,
      qualitative: { ...(card.qualitative ?? {}), [key]: v },
    });
  };

  const setPhase = (phase: string, v: number) => {
    if (!card) return;
    setCard({
      ...card,
      phases: {
        ...(card.phases ?? {}),
        [phase]: { ...(card.phases?.[phase] ?? {}), base_hours: v },
      },
    });
  };

  const setRule = (rule: string, unit: string, v: number) => {
    if (!card) return;
    setCard({
      ...card,
      rules: {
        ...(card.rules ?? {}),
        [rule]: { ...(card.rules?.[rule] ?? {}), [unit]: v },
      },
    });
  };

  return (
    <details
      onToggle={onToggle}
      style={{
        marginTop: "1rem",
        border: "1px solid var(--border, #ddd)",
        borderRadius: 6,
        padding: "0.5rem 0.75rem",
      }}
    >
      <summary style={{ cursor: "pointer", userSelect: "none" }}>
        Effort card (advanced){" "}
        <span className="small muted">
          — tune the hours-per-unit coefficients used by the runbook
          effort estimator. <HelpLink slug="19-effort" />
        </span>
      </summary>
      <div style={{ marginTop: "0.5rem" }}>
        {!loaded && <div className="small muted">Loading…</div>}
        {info && card && (
          <>
            <p className="small muted" style={{ marginTop: 0 }}>
              Current source:{" "}
              {info.is_default ? (
                <span className="pill info">shipped default</span>
              ) : (
                <code>{info.source}</code>
              )}
              . Version {card.version ?? 1}. Edits are validated against
              the same Pydantic model the analyzer uses.
            </p>

            <fieldset style={{ border: "1px solid var(--border, #eee)", borderRadius: 4, padding: "0.5rem 0.75rem", marginTop: "0.5rem" }}>
              <legend className="small">General</legend>
              <NumberField
                label="Team velocity"
                value={card.team_velocity}
                step={0.1}
                hint="1.0 = default speed; 2.0 = twice as fast"
                onChange={(v) => setTop("team_velocity", v)}
              />
              <NumberField
                label="P90 multiplier"
                value={card.confidence_p50_to_p90_multiplier}
                step={0.1}
                hint="P90 = P50 × this"
                onChange={(v) => setTop("confidence_p50_to_p90_multiplier", v)}
              />
            </fieldset>

            <fieldset style={{ border: "1px solid var(--border, #eee)", borderRadius: 4, padding: "0.5rem 0.75rem", marginTop: "0.5rem" }}>
              <legend className="small">
                Qualitative fallback (hours when no rule matches)
              </legend>
              {(["low", "medium", "high"] as const).map((k) => (
                <NumberField
                  key={k}
                  label={humanize(k)}
                  value={card.qualitative?.[k]}
                  step={0.5}
                  onChange={(v) => setQual(k, v)}
                />
              ))}
            </fieldset>

            <fieldset style={{ border: "1px solid var(--border, #eee)", borderRadius: 4, padding: "0.5rem 0.75rem", marginTop: "0.5rem" }}>
              <legend className="small">
                Phase base hours (fixed overhead per phase)
              </legend>
              {Object.keys(card.phases ?? {}).map((phase) => (
                <NumberField
                  key={phase}
                  label={humanize(phase)}
                  value={card.phases?.[phase]?.base_hours}
                  step={1}
                  onChange={(v) => setPhase(phase, v)}
                />
              ))}
            </fieldset>

            <fieldset style={{ border: "1px solid var(--border, #eee)", borderRadius: 4, padding: "0.5rem 0.75rem", marginTop: "0.5rem" }}>
              <legend className="small">
                Rules (hours per unit, capped where applicable)
              </legend>
              {Object.keys(card.rules ?? {}).map((rule) => {
                const coeffs = card.rules?.[rule] ?? {};
                return (
                  <div
                    key={rule}
                    style={{
                      borderTop: "1px dashed var(--border, #eee)",
                      paddingTop: "0.4rem",
                      marginTop: "0.4rem",
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      <code>{rule}</code>
                    </div>
                    {Object.keys(coeffs).map((unit) => (
                      <NumberField
                        key={unit}
                        label={humanize(unit)}
                        value={coeffs[unit]}
                        step={unit === "cap_hours" ? 5 : 0.25}
                        onChange={(v) => setRule(rule, unit, v)}
                      />
                    ))}
                  </div>
                );
              })}
            </fieldset>

            <div className="actions" style={{ marginTop: "0.75rem" }}>
              <button onClick={onSave} disabled={busy}>
                {busy ? "Saving…" : "Save effort card"}
              </button>
              <button
                onClick={onReset}
                disabled={busy || info.is_default}
                title={
                  info.is_default
                    ? "Already using shipped defaults"
                    : "Delete the override file"
                }
              >
                Reset to shipped defaults
              </button>
              {msg && <span className="muted small">{msg}</span>}
            </div>

            {info.available_rule_keys.length > 0 && (
              <details style={{ marginTop: "0.5rem" }}>
                <summary className="small muted">
                  Recognised rule keys ({info.available_rule_keys.length})
                </summary>
                <ul className="small">
                  {info.available_rule_keys.map((k) => (
                    <li key={k}><code>{k}</code></li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </details>
  );
}


/**
 * Collapsible **Backup & restore** panel.
 *
 * Lets the user download every run under the server's `runs_dir` as a
 * single zip, and re-import a previously exported zip. Secrets in
 * `.env` are never included � the archiver only walks `runs_dir` and
 * also drops dotfiles defensively. The import flow validates the zip
 * before extracting and supports three conflict policies.
 */
function RunsBackupRestore(): JSX.Element {
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<RunsImportMode>("skip_existing");
  const [result, setResult] = useState<RunsImportResult | null>(null);

  const onExport = async () => {
    setBusy("export");
    setError(null);
    setMsg(null);
    try {
      await apiExportRunsArchive();
      setMsg("Download started.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onImport = async () => {
    if (!file) return;
    setBusy("import");
    setError(null);
    setMsg(null);
    setResult(null);
    try {
      const r = await apiImportRunsArchive(file, mode);
      setResult(r);
      const parts: string[] = [];
      if (r.imported.length) parts.push(`${r.imported.length} imported`);
      if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
      const renamedCount = Object.keys(r.renamed).length;
      if (renamedCount) parts.push(`${renamedCount} renamed`);
      setMsg(parts.length ? parts.join(", ") : "Nothing to import.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="card" style={{ marginTop: "1rem" }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        Backup &amp; restore <span className="muted small">(export / import all run data)</span>
      </summary>
      <div style={{ marginTop: "0.75rem" }}>
        <p className="small muted" style={{ marginTop: 0 }}>
          Download every run under <code>runs/</code> as a single zip, or restore
          one on another machine. The export <strong>never includes</strong>{" "}
          <code>.env</code> or other secrets � only run artefacts.
        </p>

        <div className="actions" style={{ gap: 8, flexWrap: "wrap" }}>
          <button onClick={onExport} disabled={busy !== null}>
            {busy === "export" ? "Preparing�" : "Download all run data (.zip)"}
          </button>
        </div>

        <div
          className="form-grid"
          style={{ marginTop: "0.75rem", alignItems: "end" }}
        >
          <label>
            <span>Import zip file</span>
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <label>
            <span>On conflict</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as RunsImportMode)}
            >
              <option value="skip_existing">Skip existing</option>
              <option value="overwrite">Overwrite</option>
              <option value="rename">Rename incoming run</option>
            </select>
          </label>
          <button
            onClick={onImport}
            disabled={busy !== null || file === null}
            style={{ alignSelf: "end" }}
          >
            {busy === "import" ? "Importing�" : "Import"}
          </button>
        </div>

        {msg && (
          <p className="small" style={{ marginTop: "0.5rem" }}>
            {msg}
          </p>
        )}
        {error && (
          <p className="small" style={{ marginTop: "0.5rem", color: "var(--err, #c33)" }}>
            {error}
          </p>
        )}
        {result && (result.imported.length > 0 || Object.keys(result.renamed).length > 0) && (
          <details className="small" style={{ marginTop: "0.5rem" }}>
            <summary>Import details</summary>
            {result.imported.length > 0 && (
              <div>
                <strong>Imported:</strong>
                <ul>
                  {result.imported.map((id) => (
                    <li key={id}><code>{id}</code></li>
                  ))}
                </ul>
              </div>
            )}
            {Object.keys(result.renamed).length > 0 && (
              <div>
                <strong>Renamed:</strong>
                <ul>
                  {Object.entries(result.renamed).map(([oldId, newId]) => (
                    <li key={oldId}>
                      <code>{oldId}</code> ? <code>{newId}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.warnings.length > 0 && (
              <div>
                <strong>Warnings:</strong>
                <ul>
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </details>
        )}

        <p className="small muted" style={{ marginTop: "0.75rem" }}>
          The archive contains <code>manifest.json</code> plus{" "}
          <code>runs/&lt;id&gt;/</code> trees only. Dotfiles and symlinks are
          dropped on export and rejected on import; path-traversal and
          zip-bomb entries are blocked.
        </p>
      </div>
    </details>
  );
}
