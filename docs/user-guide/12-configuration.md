# 12. Configuration

## Purpose

Edit the analyzer's connection settings — Azure tenant / subscription /
workspace, dedicated pool, and the ODBC driver — without touching
`.env` files in the terminal. Validate the configuration with a single
click before kicking off a run.

## How to open

- URL: `/configuration`.
- Modes: control plane only.

## Inputs / outputs

Reads from and writes to `./.env` in the working directory of the
`sma serve` process. The page calls:

- `GET /api/config` — current effective values (with secrets redacted).
- `PUT /api/config` — persist edits.
- `POST /api/config/validate` — run pre-flight checks (auth, ODBC,
  workspace reachability).

## Layout

```
Configuration  (reads / writes ./.env)

Azure
  Tenant ID            [ 00000000-0000-0000-0000-000000000000 ]
  Client ID            [ 00000000-0000-0000-0000-000000000000 ]
  Client secret        [ ••••••••  (leave empty to keep) ]
  Subscription ID      [ 00000000-0000-0000-0000-000000000000 ]
  Resource group       [ rg-synapse-prod                       ]
  Workspace name       [ syn-prod-eu                           ]
  Dedicated pool       [ dwpool01                              ]   (optional)

SQL
  ODBC driver          [ ODBC Driver 18 for SQL Server         ]

[ Save ]    [ Validate ]

Validation
┌────────────────────────────────────────┬──────────┐
│ Check                                  │ Result   │
├────────────────────────────────────────┼──────────┤
│ azure.auth                             │ ● OK     │
│ azure.subscription_reachable           │ ● OK     │
│ azure.workspace_reachable              │ ● OK     │
│ sql.odbc_driver_installed              │ ● OK     │
│ sql.dedicated_pool_reachable           │ ● FAIL — login timeout │
└────────────────────────────────────────┴──────────┘
```

## Field reference

### Azure section

| Field             | `.env` key                  | Notes |
| ----------------- | --------------------------- | ----- |
| **Tenant ID**     | `AZURE_TENANT_ID`           | The directory the service principal lives in. |
| **Client ID**     | `AZURE_CLIENT_ID`           | The service principal app id. |
| **Client secret** | `AZURE_CLIENT_SECRET`       | Password input. **Leave empty to keep the existing value** — the secret is never sent back to the browser. |
| **Subscription ID** | `AZURE_SUBSCRIPTION_ID`   | The subscription that owns the Synapse workspace. |
| **Resource group** | `AZURE_RESOURCE_GROUP`     | Where the workspace lives. |
| **Workspace name** | `AZURE_WORKSPACE_NAME`     | The Synapse workspace short name (not the full URL). |
| **Dedicated pool** | `AZURE_DEDICATED_POOL`     | Optional. When set, the analyzer focuses on a single pool; otherwise it enumerates all pools in the workspace. |

### SQL section

| Field            | `.env` key       | Notes |
| ---------------- | ---------------- | ----- |
| **ODBC driver**  | `SQL_ODBC_DRIVER` | E.g. `ODBC Driver 18 for SQL Server`. Must match a driver actually installed on the host (run `sma doctor` to list installed drivers). |

### Buttons

| Button         | Effect |
| -------------- | ------ |
| **Save**       | Posts the form to `/api/config`. The server updates `./.env` atomically and reloads the in-process settings. |
| **Validate**   | Runs the same checks as `sma doctor` plus a workspace reachability probe. Returns within seconds. |

### Validation results

Each check is a row with a status pill:

- ● **OK** — green.
- ● **FAIL** — red, sub-text shows the error message.

Common checks:

- `azure.auth` — service principal can obtain a token.
- `azure.subscription_reachable` — Resource Manager call succeeds.
- `azure.workspace_reachable` — Synapse REST API responds.
- `sql.odbc_driver_installed` — the named driver is registered on the
  host.
- `sql.dedicated_pool_reachable` — TCP connect + login to the pool's
  SQL endpoint.

## Common tasks

### "Onboard a new workspace"

1. Fill in **Tenant**, **Client**, **Client secret**, **Subscription**,
   **Resource group**, **Workspace name**.
2. Click **Save**, then **Validate**.
3. When all checks are green, go to [09. Run page](09-run-page.md) and
   start a run.

### "Rotate the client secret"

1. Generate the new secret in Azure AD.
2. Paste it into **Client secret**.
3. **Save** → **Validate**.

The page never displays the existing secret — leave the field empty
on a Save if you only changed other fields.

### "Switch to a different ODBC driver"

`sma doctor --json` lists the installed drivers. Copy the exact name
into the **ODBC driver** field; click **Validate** to confirm.

## Empty / error states

- *API not reachable* — the FastAPI server isn't running.
- *Save failed: permission denied* — the `sma serve` process cannot
  write to `./.env`. Check file permissions.
- One or more red checks — see [13. Troubleshooting](13-troubleshooting.md).

## Related

- [01. Getting started](01-getting-started.md) — initial `.env` setup
- [09. Run page](09-run-page.md) — use the saved configuration
- [14. Security & deployment](14-security.md) — how secrets are handled
