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
- `POST /api/config/validate` — field-only checks (env vars present,
  GUIDs well-formed, output dir writable). Instant.
- `POST /api/config/validate?live=true` — field checks **plus** live
  Azure + Synapse connectivity tests using the saved service
  principal. Takes a few seconds.

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

[ Save ]    [ Validate (fields) ]    [ Validate access (live) ]

Validation
  Configuration
    ● OK    .env file present
    ● OK    AZURE_TENANT_ID
    ● OK    AZURE_CLIENT_ID
    ● OK    AZURE_SUBSCRIPTION_ID
    ● OK    AZURE_CLIENT_SECRET — set
    ● OK    output_dir writable
  Control plane
    ● OK    AAD token (ARM)
    ● OK    Synapse workspace (ARM Reader) — syn-prod-eu in westeurope
  Data plane
    ● OK    Synapse Artifacts (Synapse Artifact User)
    ● OK    AAD token (SQL)
    ● OK    Serverless SQL SELECT 1 (syn-prod-eu-ondemand.sql.azuresynapse.net)
    ● FAIL  Dedicated SQL SELECT 1 (syn-prod-eu.sql.azuresynapse.net / dwpool01)
            — Login failed for user '<token-identified principal>'.
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

| Button                       | Effect |
| ---------------------------- | ------ |
| **Save**                     | Posts the form to `/api/config`. The server updates `./.env` atomically and reloads the in-process settings. |
| **Validate (fields)**        | Field/format only: env vars present, GUIDs well-formed, output dir writable. Instant. |
| **Validate access (live)**   | Field checks **plus** live connectivity using the saved service principal. Tests Azure ARM (token + `workspaces.get`) and the Synapse data plane (Artifacts REST + `SELECT 1` against the serverless and — when `SYNAPSE_DEDICATED_POOL` is set — the dedicated SQL endpoint). Takes a few seconds. Use this to confirm both **Azure RBAC** and **Synapse data-plane RBAC** are in place before kicking off a run. |

### Validation results

Each check is a row with a status pill, grouped by **category**:

- **Configuration** — local checks against `./.env`.
- **Control plane** — Azure ARM + Synapse management API.
- **Data plane** — Synapse Artifacts REST + SQL endpoints.

Result states:

- ● **OK** — green.
- ● **FAIL** — red. The sub-text contains the underlying error
  message verbatim (e.g. `Login failed for user '<token-identified
  principal>'`, `(403) AuthorizationFailed`, ODBC `IM002` driver
  missing, etc.). Use this to pinpoint the missing role assignment or
  driver.

Live checks performed (when **Validate access (live)** is clicked):

| Category       | Check                                | Confirms |
| -------------- | ------------------------------------ | -------- |
| Control plane  | `AAD token (ARM)`                    | Service-principal credentials are valid for `management.azure.com`. |
| Control plane  | `Synapse workspace (ARM Reader)`     | The SP has at least Reader on the Synapse workspace resource. |
| Data plane     | `Synapse Artifacts (Synapse Artifact User)` | The SP can list pipelines via the workspace dev endpoint. |
| Data plane     | `AAD token (SQL)`                    | A token can be issued for `database.windows.net`. |
| Data plane     | `Serverless SQL SELECT 1 (...)`      | TCP + login + query on the built-in serverless endpoint. |
| Data plane     | `Dedicated SQL SELECT 1 (...)`       | Same against the dedicated pool — only when `SYNAPSE_DEDICATED_POOL` is set. |

## Common tasks

### "Onboard a new workspace"

1. Fill in **Tenant**, **Client**, **Client secret**, **Subscription**,
   **Resource group**, **Workspace name**.
2. Click **Save**, then **Validate access (live)**.
3. When every row under **Control plane** and **Data plane** is green,
   go to [09. Run page](09-run-page.md) and start a run.
4. If a Data-plane check fails with `Login failed for user '<token-identified
   principal>'`, the SP needs to be added as a Synapse SQL login. For
   the serverless endpoint a single `CREATE LOGIN [<sp-name>] FROM
   EXTERNAL PROVIDER; CREATE USER [<sp-name>] FOR LOGIN [<sp-name>];`
   in `master` is usually enough; for the dedicated pool repeat the
   `CREATE USER` in the pool database and grant the appropriate role
   (e.g. `db_datareader`).

### "Rotate the client secret"

1. Generate the new secret in Azure AD.
2. Paste it into **Client secret**.
3. **Save** → **Validate access (live)**.

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
