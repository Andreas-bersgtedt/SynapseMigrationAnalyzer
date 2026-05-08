import { useEffect, useState } from "react";
import HelpLink from "../components/HelpLink";
import {
  apiGetConfig,
  apiPutConfig,
  apiValidateConfig,
  type AppConfig,
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
        Reads / writes <code>{cfg.env_file}</code>. The client secret is never
        returned by the API; only its presence (<code>{cfg.azure.client_secret}</code>) is shown.
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
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={() => onValidate(false)} disabled={validating}>
          {validating ? "Validating…" : "Validate (fields)"}
        </button>
        <button onClick={() => onValidate(true)} disabled={validating} title="Test live Azure + Synapse connectivity using the saved service principal">
          {validating ? "Testing…" : "Validate access (live)"}
        </button>
        {saveMsg && <span className="muted">{saveMsg}</span>}
      </div>

      {validation && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <div className="label">
            Validation —{" "}
            <span className={`pill ${validation.ok ? "ok" : "err"}`}>
              {validation.ok ? "ALL OK" : "FAILED"}
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
                      <span className={`pill ${c.ok ? "ok" : "err"}`}>{c.ok ? "OK" : "FAIL"}</span>{" "}
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
    </section>
  );
}
