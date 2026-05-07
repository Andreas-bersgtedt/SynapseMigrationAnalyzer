import { useEffect, useState } from "react";
import HelpLink from "../components/HelpLink";
import {
  apiGetConfig,
  apiPutConfig,
  apiValidateConfig,
  type AppConfig,
  type ValidateResponse,
} from "../api/loader";

const FIELDS = [
  ["azure", "tenant_id", "Tenant ID"],
  ["azure", "client_id", "Client ID"],
  ["azure", "subscription_id", "Subscription ID"],
  ["azure", "resource_group", "Resource group"],
  ["azure", "workspace_name", "Workspace name"],
  ["azure", "dedicated_pool", "Dedicated pool (optional)"],
  ["sql", "odbc_driver", "ODBC driver"],
] as const;

export default function Configuration(): JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string>("");
  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

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
      setValidation(await apiValidateConfig({ live }));
    } catch (e) {
      setSaveMsg(`Validate failed: ${(e as Error).message}`);
    } finally {
      setValidating(false);
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
        </div>
      )}
    </section>
  );
}
