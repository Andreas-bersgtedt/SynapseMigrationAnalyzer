# Quick Start

A **module-based** walkthrough of the Synapse Migration Analyzer. Each module is a self-contained analyzer that reads from Azure Synapse and produces typed reports for assessing **Microsoft Fabric Warehouse** migration readiness.

| # | Module | Status | CLI command | Source |
|---|---|---|---|---|
| 1 | `dedicated_pools`  | ✅ Available | `sma analyze-dedicated-pools`  | [src/.../modules/dedicated_pools/](src/synapse_migration_analyzer/modules/dedicated_pools) |
| 2 | `serverless_pools` | ✅ Available | `sma analyze-serverless-pools` | [src/.../modules/serverless_pools/](src/synapse_migration_analyzer/modules/serverless_pools) |
| 3 | `spark_pools`      | ✅ Available | `sma analyze-spark-pools`      | [src/.../modules/spark_pools/](src/synapse_migration_analyzer/modules/spark_pools) |
| 4 | `pipelines`        | ✅ Available | `sma analyze-pipelines`        | [src/.../modules/pipelines/](src/synapse_migration_analyzer/modules/pipelines) |
| 5 | `monitoring`       | ✅ Available | `sma analyze-monitoring`       | [src/.../modules/monitoring/](src/synapse_migration_analyzer/modules/monitoring) |
| 6 | `storage`          | ✅ Available | `sma analyze-storage`          | [src/.../modules/storage/](src/synapse_migration_analyzer/modules/storage) |
| 7 | `fabric_mapping`   | ✅ Available | `sma map-to-fabric`            | [src/.../modules/fabric_mapping/](src/synapse_migration_analyzer/modules/fabric_mapping) |
| 8 | `governance` (v1.2)        | ✅ Available | `sma analyze-governance`       | [src/.../modules/governance/](src/synapse_migration_analyzer/modules/governance) |
| 9 | `security`   (v1.2)        | ✅ Available | `sma analyze-security`         | [src/.../modules/security/](src/synapse_migration_analyzer/modules/security) |
| 10 | `cost`       (v1.2)       | ✅ Available | `sma analyze-cost`             | [src/.../modules/cost/](src/synapse_migration_analyzer/modules/cost) |
| 11 | `fabric_validation` (v0)  | ✅ Available | `sma validate-fabric`         | [src/.../modules/fabric_validation/](src/synapse_migration_analyzer/modules/fabric_validation) |
| ★ | _all_              | —            | `sma analyze-all`              | runs 1→7 + opt-in mid-term modules, refreshes `index.html`, emits run manifest + delta |
| 🔄 | _delta_            | —            | `sma run-delta`                | re-emits `run_manifest.json` + `run_delta.{md,html,json}` against the previous run |
| 🔗 | _index_            | —            | `sma index`                    | (re)builds the `index.html` landing page in `SMA_OUTPUT_DIR` |
| ⚙ | _self-check_       | —            | `sma doctor`                   | host + auth pre-flight ([doctor.py](src/synapse_migration_analyzer/doctor.py)) |

---

## 0. One-time setup (applies to all modules)

### 0.1 Install host prerequisites

- **Python 3.12+** — `python --version`
- **Microsoft ODBC Driver 18 for SQL Server** (required by `pyodbc`)
  - Windows: <https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server>
- **Git** (to clone the repo)
- **Azure CLI 2.50+** (`az`) — used in [§0.3](#03-create-a-service-principal--grant-access) to create the service principal
  - Windows: <https://learn.microsoft.com/cli/azure/install-azure-cli-windows>
  - macOS / Linux: <https://learn.microsoft.com/cli/azure/install-azure-cli>
  - Verify: `az --version`
  - If you cannot install `az` on this host, see the **Portal alternative** in §0.3 below.

### 0.2 Clone & install

#### Fast path — `quickstart.ps1` (Windows)

The repo ships a [PowerShell bootstrapper](quickstart.ps1) that performs the
entire §0.2 sequence in one command. It clones the repo (skip with
`-SkipClone` if already cloned), creates `.venv`, installs **all** optional
extras (`dev,cost,web`) so every analyzer module and the control plane are
ready out of the box, builds the React SPA bundle in `web/dist`, runs
`sma doctor --offline`, and — when the doctor passes — auto-launches
`sma serve --with-api --static-dir web\dist` so the browser UI is live at
`http://127.0.0.1:8000/` at the end of bootstrap.

```powershell
# Public fork (default)
.\quickstart.ps1

# Private fork
.\quickstart.ps1 -Repo Private

# CLI-only host (no Node, no browser UI)
.\quickstart.ps1 -SkipWebBuild -NoServe
```

Key switches: `-SkipClone`, `-Branch <name>`, `-PythonExe py`,
`-SkipDoctor`, `-SkipWebBuild`, `-NoServe`. See the script header for the
full parameter list.

After the bootstrapper finishes, jump to [§0.3](#03-create-a-service-principal--grant-access)
for service-principal setup, then [§0.4](#04-configure-env) to fill in `.env`.

#### Manual path

```powershell
git clone https://github.com/anbergst_microsoft/SynapseMigrationAnalyzer.git
cd SynapseMigrationAnalyzer\SynapseMigrationAnalyzer

python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"

# Optional: enable live Cost Management queries for the `cost` module
pip install -e ".[cost]"

# Optional: enable the browser-driven control plane (`sma serve --with-api`)
pip install -e ".[web]"
```

> The `cost` extra installs `azure-mgmt-costmanagement`. Without it, `sma analyze-cost`
> will run but emit a `cost.sdk_missing` finding instead of live data.
>
> The `web` extra installs FastAPI + uvicorn + sse-starlette + httpx. Without it,
> `sma serve` still works as a static file server, but `sma serve --with-api`
> exits with an install error. See [Optional — browser-driven control plane](#optional--browser-driven-control-plane).

Verify the CLI is on the path:

```powershell
sma --version
sma --help
```

### 0.3 Create a service principal & grant access

> **Dependency:** this step uses the **Azure CLI** (`az`). Install it via the link in [§0.1](#01-install-host-prerequisites) before running the commands below. Verify with `az --version` first. If you cannot install `az`, jump to the **Portal alternative** at the end of this section.

#### 0.3.1 Sign in and pick the right subscription

```powershell
az login                                # opens a browser; sign in as a user with rights to create app registrations
az account show --query "{tenantId:tenantId, subscriptionId:id, name:name}" -o table
az account set --subscription "<SUB_ID_OR_NAME>"   # only if you have multiple subscriptions
```

Keep `tenantId` and `subscriptionId` from the output — they go straight into [§0.4](#04-configure-env) as `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`.

#### 0.3.2 Find the workspace resource ID

```powershell
az synapse workspace show `
  --name <WS> --resource-group <RG> `
  --query id -o tsv
```

> Don't have the `synapse` extension? Run `az extension add --name synapse` once. (`az resource show --resource-type Microsoft.Synapse/workspaces ...` works without the extension.)

#### 0.3.3 Create the service principal

```powershell
# Create the SP and capture the appId/password (clientId/clientSecret).
# Replace <SUB_ID>, <RG>, <WS> with the values from §0.3.1 / §0.3.2.
az ad sp create-for-rbac --name "sma-analyzer" --role Reader `
  --scopes /subscriptions/<SUB_ID>/resourceGroups/<RG>/providers/Microsoft.Synapse/workspaces/<WS>
```

The command prints something like:

```json
{
  "appId":       "00000000-0000-0000-0000-000000000000",   // → AZURE_CLIENT_ID
  "displayName": "sma-analyzer",
  "password":    "<one-time-secret>",                       // → AZURE_CLIENT_SECRET (shown ONCE)
  "tenant":      "00000000-0000-0000-0000-000000000000"     // → AZURE_TENANT_ID
}
```

**Copy the `password` immediately** — it is shown only once. If you lose it, recreate the credential with `az ad sp credential reset --id <appId>`.

The `Reader` role above covers **control-plane** (ARM) calls. Each module that hits a **data-plane** endpoint (SQL pools, Synapse Artifacts, Azure Monitor) requires additional grants documented in that module's section below — typically a SQL `CREATE USER ... FROM EXTERNAL PROVIDER`, **Synapse Artifact User**, and **Monitoring Reader**.

#### 0.3.4 Common `az` errors

| Symptom | Cause | Fix |
|---|---|---|
| `'az' is not recognized as the name of a cmdlet` | Azure CLI not installed or not on `PATH` | Install per §0.1 and reopen PowerShell |
| `Insufficient privileges to complete the operation` | Your signed-in user can't create app registrations in the tenant | Ask a Microsoft Entra ID admin to run §0.3.3, or use the **Portal alternative** below |
| `The role assignment already exists` | SP already has Reader at that scope | Safe to ignore |
| `(AuthorizationFailed) ... does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write'` | You can create the SP but not assign roles | Run `az ad sp create-for-rbac` **without** `--role`/`--scopes`, then have an Owner of the workspace assign **Reader** to the new SP via the portal (IAM blade) |

#### Portal alternative (no `az` required)

1. **Microsoft Entra ID → App registrations → + New registration** — name it `sma-analyzer`, accept defaults. After creation, copy **Application (client) ID** → `AZURE_CLIENT_ID` and **Directory (tenant) ID** → `AZURE_TENANT_ID`.
2. **Certificates & secrets → + New client secret** — set an expiry, copy the **Value** column immediately → `AZURE_CLIENT_SECRET`.
3. **Synapse workspace → Access control (IAM) → + Add → Add role assignment** — role **Reader**, assign access to **User, group, or service principal**, search for `sma-analyzer`, save. Repeat for **Monitoring Reader** (subscription / resource-group scope) if you plan to run `sma analyze-monitoring`, and for **Synapse Artifact User** (Synapse Studio → Manage → Access control) for `sma analyze-pipelines` / `sma analyze-spark-pools`.
4. Continue with [§0.4](#04-configure-env).

### 0.3.5 Permissions cheat-sheet (read this if you hit `Unauthorized`)

Azure RBAC and **Synapse RBAC** are *separate*. Being Owner of the subscription does **not** grant access to artifacts inside a Synapse workspace — Synapse RBAC is managed inside the workspace itself.

| Plane | Used by | Role to assign | Where to assign it |
|---|---|---|---|
| **Azure ARM (control plane)** | Pool definitions, Spark pool ARM details, dedicated/serverless SQL pool listing | **Reader** | Subscription, resource group, **or** workspace resource (any of these) |
| **Synapse artifacts (data plane)** — `*.dev.azuresynapse.net` | `analyze-pipelines`, `analyze-spark-pools` (notebooks, SJDs, linked services, datasets, triggers) | **Synapse Artifact User** (read-only) or **Synapse User** | Synapse Studio → **Manage → Access control** at workspace scope |
| **Azure Monitor metrics** | `analyze-monitoring` | **Monitoring Reader** | Subscription or resource group containing the workspace |
| **Azure Cost Management** | `analyze-cost` | **Cost Management Reader** | Subscription or the workspace's resource group |
| **SQL endpoints** (dedicated + serverless) | `analyze-dedicated-pools`, `analyze-serverless-pools` | SQL `CREATE USER [<sp-name>] FROM EXTERNAL PROVIDER;` + `db_datareader` + `GRANT VIEW DATABASE STATE` + `GRANT VIEW DEFINITION` (so procedures / functions are visible in `sys.objects` / `sys.sql_modules`) | Inside each database (run as a SQL admin) |

Grant Synapse RBAC via **Synapse Studio**:
`https://web.azuresynapse.net` → pick workspace → **Manage** → **Access control** → **+ Add** → scope `Workspace`, role **Synapse Artifact User**, paste the principal's **object ID** or app name → **Apply**. Allow ~1 minute for propagation.

Or via Azure CLI (run as a workspace admin):

```powershell
az synapse role assignment create `
  --workspace-name <WS> `
  --role "Synapse Artifact User" `
  --assignee <APP_ID_OR_OBJECT_ID>
```

**Symptom → fix:**

| Error fragment in `errors[]` | Cause | Fix |
|---|---|---|
| `notebooks: (Unauthorized) ... Microsoft.Synapse/workspaces/artifacts/read` | Missing Synapse RBAC | Assign **Synapse Artifact User** at workspace scope |
| `spark_job_definitions: (Unauthorized) ... artifacts/read` | Missing Synapse RBAC | Assign **Synapse Artifact User** at workspace scope |
| `pipelines: (Unauthorized) ... artifacts/read` | Missing Synapse RBAC | Assign **Synapse Artifact User** at workspace scope |
| `metrics[...]: (Forbidden)` from Azure Monitor | Missing **Monitoring Reader** | Assign **Monitoring Reader** at the resource-group / subscription scope |
| `Login failed for user '<token-identified principal>'` (SQL) | SP not added to the database | Run `CREATE USER [<sp-name>] FROM EXTERNAL PROVIDER;` then `ALTER ROLE db_datareader ADD MEMBER [<sp-name>];` |

The analyzer surfaces unauthorized artifact errors with an inline hint, e.g.:

```
notebooks: (Unauthorized) ... [hint: missing Synapse RBAC role on the workspace.
Grant 'Synapse Artifact User' (or higher) to this principal at workspace scope.
See QUICKSTART.md section 'Permissions' for details.]
```

### 0.4 Configure `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Required for every module:

```ini
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
AZURE_SUBSCRIPTION_ID=...
SYNAPSE_RESOURCE_GROUP=...
SYNAPSE_WORKSPACE_NAME=...
SMA_OUTPUT_DIR=./output
```

See [.env.example](.env.example) for the full list and per-module overrides.

### 0.5 Smoke-test the install

The CLI ships with a consolidated self-check. It verifies the host (Python version, ODBC driver), every required Python package, the `.env` file and required variables, output-directory permissions, and (when credentials are present) live Azure access:

```powershell
sma doctor             # full check: includes live AAD + Synapse workspace probe
sma doctor --offline   # skip live Azure calls — useful before populating .env
```

Sample output (offline mode, fresh install):

```text
                              sma doctor
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━┳────────────────────────────────────┓
┃ Check                          ┃ Status ┃ Detail                             ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━╇────────────────────────────────────┩
│ Python >= 3.12                 │  PASS  │ 3.12.10 on Windows-11               │
│ import azure.identity          │  PASS  │                                    │
│ import azure.mgmt.synapse      │  PASS  │                                    │
│ import azure.mgmt.resource     │  PASS  │                                    │
│ import azure.mgmt.monitor      │  PASS  │                                    │
│ import azure.mgmt.storage      │  PASS  │                                    │
│ import azure.synapse.artifacts │  PASS  │                                    │
│ import pyodbc                  │  PASS  │                                    │
│ ODBC driver                    │  PASS  │ ODBC Driver 18 for SQL Server      │
│ .env present                   │  PASS  │ ./.env                              │
│ Required env vars              │  PASS  │ 6 variables set                    │
│ Output dir writable            │  PASS  │ ./output                            │
│ AAD token (ARM)                │  SKIP  │ live checks disabled (--offline)   │
│ Synapse workspace reachable    │  SKIP  │ live checks disabled (--offline)   │
│ SQL access token               │  SKIP  │ live checks disabled (--offline)   │
└────────────────────────────────┴────────┴────────────────────────────────────┘
All required checks passed.
```

`sma doctor` exits **0** on success and **1** when any required check fails — safe to use in CI.

You can also run the full pytest suite:

```powershell
pytest -q
```

All suites pass without any Azure credentials configured: config loading, reporting writers, fabric_mapping rules, the T-SQL surface scanner, the pipelines Fabric-compat classifier, the monitoring reporter, and the doctor self-checks.

---

## Module 1 — `dedicated_pools`

Inventories every dedicated SQL pool in the configured Synapse workspace and collects schemas, tables (with distribution/partitioning/storage), indexes, a usage snapshot, security principals, workload-management groups, and T-SQL code objects. The **v2** layer adds a column-level collation audit, materialized-view inventory, statistics-freshness report, column-level stats, a distribution-key advisor (skew + filter-selectivity heuristics), and a per-object T-SQL surface gap rollup linked back to each finding via a stable `code_object_id`.

### 1.1 What it captures

| Area | Source | File |
|---|---|---|
| Pool inventory, SKU, DWU, status, collation, max size | ARM (`azure-mgmt-synapse`) | [arm_client.py](src/synapse_migration_analyzer/modules/dedicated_pools/arm_client.py) |
| Schemas + object counts | `sys.schemas` / `sys.objects` | [queries/schemas.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/schemas.sql) |
| Tables: distribution, partitioning, rows, MB, index type | `sys.pdw_*`, `sys.dm_pdw_nodes_db_partition_stats` | [queries/tables.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/tables.sql) |
| Indexes (CCI / heap / clustered / NCI) | `sys.indexes` | [queries/indexes.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/indexes.sql) |
| Usage snapshot (active/completed/failed requests, durations, sessions) | `sys.dm_pdw_exec_*` | [queries/usage.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/usage.sql) |
| Database principals & role memberships | `sys.database_principals`, `sys.database_role_members` | [queries/security.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/security.sql) |
| Workload groups & classifier counts | `sys.workload_management_*` | [queries/workload.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/workload.sql) |
| Code objects (procs / views / functions) with stable `code_object_id` | `sys.sql_modules` | [queries/code_objects.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/code_objects.sql) |
| **v2** Column collation audit (per-column vs DB default) | `sys.columns` + `sys.databases` | [queries/column_collation.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/column_collation.sql) |
| **v2** Materialized-view inventory | `sys.views` + `sys.indexes` | [queries/materialized_views.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/materialized_views.sql) |
| **v2** Statistics freshness (last_updated, modification_counter) | `sys.stats` + `sys.dm_db_stats_properties` | [queries/statistics_freshness.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/statistics_freshness.sql) |
| **v2** Column-level row/distinct/null/skew stats | derived | [queries/column_stats.sql](src/synapse_migration_analyzer/modules/dedicated_pools/queries/column_stats.sql) |
| **v2** Distribution-key candidates (skew + filter-selectivity scoring) | pure-Python advisor | [distribution_advisor.py](src/synapse_migration_analyzer/modules/dedicated_pools/distribution_advisor.py) + [query_pattern_extractor.py](src/synapse_migration_analyzer/modules/dedicated_pools/query_pattern_extractor.py) |
| **v2** T-SQL surface gap rollup linked to `code_object_id` | pure-Python over code objects | [tsql_surface_gap.py](src/synapse_migration_analyzer/modules/dedicated_pools/tsql_surface_gap.py) |

> Paused pools are detected via control-plane `status`; DMV collection is skipped and noted in the result's `errors` list.

### 1.2 Module-specific prerequisites

For **each** dedicated SQL pool you want to analyze, run this **once** (signed in as a Synapse-AAD admin):

```sql
-- Connect to the dedicated pool (e.g. <ws>.sql.azuresynapse.net, database=<pool>)
CREATE USER [sma-analyzer] FROM EXTERNAL PROVIDER;
EXEC sp_addrolemember 'db_datareader', 'sma-analyzer';
GRANT VIEW DATABASE STATE TO [sma-analyzer];
-- Required so sys.sql_modules / sys.objects expose stored procedures and
-- user-defined functions to the analyzer. Without this grant the catalog
-- silently hides P / FN / IF / TF rows and the report shows views only.
GRANT VIEW DEFINITION TO [sma-analyzer];
```

Optional `.env` knobs:

```ini
SYNAPSE_DEDICATED_POOL=         # leave blank to scan all pools; set to a name to limit
SQL_ODBC_DRIVER=ODBC Driver 18 for SQL Server
SQL_LOGIN_TIMEOUT=30
SQL_QUERY_TIMEOUT=120
```

### 1.3 Run

```powershell
sma analyze-dedicated-pools                          # all formats (json, csv, markdown, html)
sma analyze-dedicated-pools -f json -f markdown      # selected formats
sma -v analyze-dedicated-pools                       # verbose / debug logging
```

### 1.4 Outputs (under `./output/` by default)

- `dedicated_pools.json` — full structured result (machine-readable)
- `dedicated_pools.md` — human-readable summary report
- `dedicated_pools.html` — styled report (sharable; linked from `index.html`)
- Per-entity CSVs for spreadsheet workflows:
  - `pools_inventory.csv`
  - `schemas.csv`
  - `tables.csv`
  - `indexes.csv`
  - `usage.csv`
  - `security.csv`
  - `workload_groups.csv`
  - **v2** `column_collations.csv`, `materialized_views.csv`, `statistics.csv`, `column_stats.csv`, `distribution_candidates.csv`, `tsql_surface_gaps.csv` (each emitted only when its collector returned rows)

### 1.5 Programmatic use

```python
from synapse_migration_analyzer.config import load_config
from synapse_migration_analyzer.modules.dedicated_pools.analyzer import DedicatedPoolsAnalyzer
from synapse_migration_analyzer.reporting import write_reports

cfg = load_config()
result = DedicatedPoolsAnalyzer(cfg).run()      # WorkspaceAnalysis Pydantic model

for pool in result.pools:
    print(pool.inventory.name, pool.inventory.sku_capacity, len(pool.tables), "tables")

write_reports(result, cfg.output_dir, formats=["json", "markdown"])
```

### 1.6 Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing required environment variables` | `.env` not populated | Copy `.env.example` → `.env`, fill values |
| `Login failed for user '<token-identified principal>'` | SP not added to the pool | Run the `CREATE USER … FROM EXTERNAL PROVIDER` snippet in §1.2 |
| `The user does not have permission to perform this action` on DMVs | Missing `VIEW DATABASE STATE` | Run `GRANT VIEW DATABASE STATE TO [sma-analyzer]` |
| `code_objects` contains only views (no procedures or functions) | Missing `VIEW DEFINITION` — `sys.objects` / `sys.sql_modules` filter out P/FN/IF/TF rows for principals without it | Run `GRANT VIEW DEFINITION TO [sma-analyzer]` (per §1.2) and re-run the analyzer |
| `IM002 / Data source name not found` | ODBC Driver 18 not installed | Install the driver from the link in §0.1 |
| Pool reported but no tables/usage | Pool is **paused** | Resume the pool or accept the `errors` entry |
| `(pyodbc) … TLS/SSL` errors | TLS settings on host | Ensure `Encrypt=yes;TrustServerCertificate=no` (default) and the host trusts the cert chain |

---

## Module 2 — `serverless_pools`

Inventories the workspace's **built-in serverless SQL endpoint** (`<workspace>-ondemand.sql.azuresynapse.net`).

### 2.1 What it captures

| Area | Source | File |
|---|---|---|
| Logical databases on the serverless endpoint | `sys.databases` | [queries/databases.sql](src/synapse_migration_analyzer/modules/serverless_pools/queries/databases.sql) |
| External data sources (per database) | `sys.external_data_sources` | [queries/external_data_sources.sql](src/synapse_migration_analyzer/modules/serverless_pools/queries/external_data_sources.sql) |
| External tables (per database) | `sys.external_tables` + joins | [queries/external_tables.sql](src/synapse_migration_analyzer/modules/serverless_pools/queries/external_tables.sql) |
| Top 100 expensive queries (last 14 d) | `sys.dm_exec_requests_history` | [queries/top_queries.sql](src/synapse_migration_analyzer/modules/serverless_pools/queries/top_queries.sql) |
| Daily data-scanned aggregation (last 30 d) | `sys.dm_exec_requests_history` | [queries/data_processed.sql](src/synapse_migration_analyzer/modules/serverless_pools/queries/data_processed.sql) |
| Cost estimate (USD / TB scanned) | derived | override list price via `SMA_SERVERLESS_PRICE_PER_TB` (default `5.0`) |
| Usage snapshot | scaffold (extend as needed) | [queries/usage.sql](src/synapse_migration_analyzer/modules/serverless_pools/queries/usage.sql) |

### 2.2 Module-specific prerequisites

The same service principal needs SQL access on the **serverless** endpoint. Connect to `master` on `<ws>-ondemand.sql.azuresynapse.net` as a Synapse-AAD admin and run:

```sql
CREATE LOGIN [sma-analyzer] FROM EXTERNAL PROVIDER;
GRANT VIEW SERVER STATE TO [sma-analyzer];
GRANT VIEW ANY DEFINITION TO [sma-analyzer];
```

For each user database on serverless that you want full external-table inventory for, also run:

```sql
USE [<your-serverless-db>];
CREATE USER [sma-analyzer] FROM EXTERNAL PROVIDER;
GRANT VIEW DEFINITION TO [sma-analyzer];
```

### 2.3 Run & outputs

```powershell
sma analyze-serverless-pools
```

Produces (under `./output/`):
- `serverless_pools.json`, `serverless_pools.md`, `serverless_pools.html`
- `serverless_databases.csv`, `serverless_external_data_sources.csv`, `serverless_external_tables.csv`, `serverless_usage.csv`
- `serverless_top_queries.csv` (TOP 100 with `data_processed_mb`, `duration_seconds`, command text)
- `serverless_daily_usage.csv` (one row per day with request count + MB scanned)

---

## Module 3 — `spark_pools`

Inventories Apache Spark pools (a.k.a. *big data pools*) attached to the workspace. Control-plane only — no Spark cluster start required.

### 3.1 What it captures

| Area | Source |
|---|---|
| Pool name, location, Spark version, node size/family/count | `azure-mgmt-synapse` `big_data_pools` |
| Autoscale config (min/max nodes) | same |
| Auto-pause delay | same |
| Isolated compute, session-level packages, dynamic executor allocation | same |
| Provisioning state, creation date, tags | same |
| Notebook inventory (language, kernel, attached pool, cell count, size, imports) | Synapse Artifacts `notebook.get_notebooks_by_workspace` |
| Spark job definitions (target pool, main file, class, conf, args) | Synapse Artifacts `spark_job_definition.get_spark_job_definitions_by_workspace` |

### 3.2 Module-specific prerequisites

Notebooks and Spark job definitions live in the **Synapse Artifacts** plane, so the SP needs **Synapse Artifact User** (or higher) on the workspace — same role as `analyze-pipelines`. Without it, those calls are skipped (errors are logged into the result's `errors` list) and only the control-plane pool inventory is captured.

### 3.3 Run & outputs

```powershell
sma analyze-spark-pools
```

Produces:
- `spark_pools.json`, `spark_pools.md`, `spark_pools.html`, `spark_pools.csv`
- `spark_notebooks.csv` (one row per notebook with extracted `imports` column)
- `spark_job_definitions.csv` (target pool, main file, class, args)

---

## Module 4 — `pipelines`

Inventories the **Synapse Artifacts** plane (`https://<ws>.dev.azuresynapse.net`): pipelines, linked services, datasets, triggers — plus integration runtimes from ARM.

### 4.1 What it captures

| Entity | API | Notes |
|---|---|---|
| Pipelines | `ArtifactsClient.pipeline.get_pipelines_by_workspace` | activity count, distinct activity types, folder, annotations, **Fabric-unsupported / partial activity counts** |
| Activities (flattened) | recursive walk of `activities`, `if_true_activities`, `if_false_activities`, `default_activities`, `cases[].activities` | type, support tier (`supported` / `partial` / `unsupported` / `unknown`), **per-activity reasons + instance caveats**, suggested Fabric equivalent, migration action, doc URL, references |
| Linked services | `linked_service.get_linked_services_by_workspace` | type, integration runtime reference, **`fabric_supported` boolean** |
| Datasets | `dataset.get_datasets_by_workspace` | type, linked service reference, folder |
| Triggers | `trigger.get_triggers_by_workspace` | type, runtime state, attached pipelines |
| Integration runtimes | `azure-mgmt-synapse.integration_runtimes.list_by_workspace` | Managed vs SelfHosted |

### 4.2 Module-specific prerequisites

The service principal needs **Synapse Artifact User** (or higher) on the workspace, in addition to control-plane Reader. Grant via Synapse Studio → **Manage** → **Access control**.

### 4.3 Run & outputs

```powershell
sma analyze-pipelines
sma analyze-pipelines --since 28d            # narrower run-history window for this run
sma analyze-pipelines --no-run-history       # skip the run-history fetch entirely
```

Produces:
- `pipelines.json`, `pipelines.md`, `pipelines.html`
- `pipelines.csv`, `linked_services.csv`, `datasets.csv`, `triggers.csv`, `integration_runtimes.csv`
- `pipeline_activities.csv` (one row per activity with support tier, generic reasons, instance-specific caveats, Fabric equivalent, migration action, doc URL)
- `pipeline_run_stats.csv` — one row per `(pipeline, window)` for 7/14/28/90-day buckets
- `pipeline_run_summary.csv` — one row per pipeline using the 28-day window as the headline

### 4.4 Run-history statistics

The analyzer pulls pipeline run history via `ArtifactsClient.pipeline_run.query_pipeline_runs_by_workspace` and aggregates it into rolling windows. For pipelines that statically contain a `Copy`, `ExecuteDataFlow` or `Lookup` activity, it also fetches activity-run outputs to compute average data-movement (MB/run from `dataRead` / `dataWritten` on Copy, `runStatus.metrics[*].bytes` on Dataflow).

Tunable via env vars (and/or `--since` / `--no-run-history`):

| Env var | Default | Notes |
|---|---|---|
| `SMA_PIPELINES_RUN_HISTORY` | `1` | Set to `0` to skip the fetch entirely |
| `SMA_PIPELINES_RUN_DAYS` | `90` | Widest window (also caps the API range; 7/14/28 are clamped to it) |
| `SMA_PIPELINES_RUN_LIMIT` | `5000` | Safety cap on total runs / activity rows fetched per call; sets `truncated=true` when reached |
| `SMA_PIPELINES_ACTIVITY_RUNS` | `1` | Set to `0` to skip activity-run fetch (data-movement metrics will be `null`) |

> **Compatibility detail.** When an activity is marked `partial`, the analyzer
> does **not** stop at the tier label. For each known activity type it ships a
> small knowledge base of *why* the activity is partial in Fabric (auth options,
> connector catalog gaps, parameter-passing differences, batch-count ceilings
> etc.), plus a property-level walker that surfaces *instance-specific* caveats
> from the activity's `type_properties` — for example a `Copy` with
> `enableStaging=true`, a `WebActivity` using `ClientCertificate` auth, a
> `Lookup` with `firstRowOnly=false`, a `ForEach` with `batchCount` above
> Fabric's max, or a `SynapseNotebook` bound to a specific Spark pool. See
> [fabric_compat.py](src/synapse_migration_analyzer/modules/pipelines/fabric_compat.py)
> for the full catalog. The HTML report renders these as expandable cards under
> *Partially-compatible activities*; the markdown report renders them as nested
> bullet lists.

---

## Module 5 — `monitoring`

Pulls historical Azure Monitor metrics for each dedicated SQL pool in the workspace. Produces a window-aggregated summary (min / avg / p95 / max) used by `fabric_mapping` to recommend Fabric capacity sizing.

### 5.1 What it captures

| Metric | Source |
|---|---|
| `DWULimit`, `DWUUsed`, `DWUUsedPercent` | `Microsoft.Synapse/workspaces/sqlPools` metrics |
| `ActiveQueries`, `QueuedQueries` | same |
| `Connections`, `ConnectionsBlockedByFirewall` | same |
| `MemoryUsedPercent`, `CPUPercent` | same |

> The provider does **not** expose `FailedConnections` on `workspaces/sqlPools`; the analyzer requests `ConnectionsBlockedByFirewall` instead. If the provider's catalogue ever drops a metric, `fetch_metrics()` parses the rejected name out of the `BadRequest` response, drops it, and retries with the rest — see [monitor_client.py](src/synapse_migration_analyzer/modules/monitoring/monitor_client.py).

Default window is 7 days at 1-hour interval. Tunable via env vars:

| Env var | Default | Notes |
|---|---|---|
| `SMA_MONITORING_DAYS` | `7` | Window size in days |
| `SMA_MONITORING_INTERVAL` | `PT1H` | ISO-8601 duration |
| `SMA_MONITORING_AGG` | `Average` | One of `Average` / `Total` / `Maximum` / `Minimum` |

### 5.2 Module-specific prerequisites

The service principal needs `Monitoring Reader` (or any role that grants `Microsoft.Insights/metrics/read`) at the subscription or resource-group scope.

### 5.3 Run & outputs

```powershell
sma analyze-monitoring
sma analyze-monitoring --since 14d        # override SMA_MONITORING_DAYS for one run
```

Produces:
- `monitoring.json` (full series with timestamped points)
- `monitoring_summary.csv` (one row per metric/pool with min/avg/p95/max)
- `monitoring.md`, `monitoring.html`

---

## Module 6 — `storage`

Captures the **storage footprint** that underlies the workspace: every Storage account in the subscription (flagging the workspace-default ADLS Gen2), Azure Monitor capacity metrics (`UsedCapacity`, `BlobCapacity`, `BlobCount`, `ContainerCount`, plus best-effort File / Table / Queue), and the actual on-disk size of every dedicated SQL pool — reserved / data / index space in **MB and GB** plus % of the pool's `MaxSizeBytes`.

### 6.1 What it captures

| Area | Source | File |
|---|---|---|
| Storage account inventory (SKU, kind, access tier, HNS / ADLS Gen2 flag, endpoints) | `azure-mgmt-storage` `storage_accounts.list` (with RG-scope and `get_properties` fallbacks) | [arm_client.py](src/synapse_migration_analyzer/modules/storage/arm_client.py) |
| Workspace-default ADLS Gen2 detection | `azure-mgmt-synapse` `workspaces.get` + parsing of `default_data_lake_storage.account_url` | same |
| Capacity metrics (account scope: `UsedCapacity`) | `azure-mgmt-monitor` `metrics.list` | [monitor_client.py](src/synapse_migration_analyzer/modules/storage/monitor_client.py) |
| Capacity metrics (service scope: `BlobCapacity`, `BlobCount`, `ContainerCount`, best-effort `FileCapacity`/`FileCount`/`TableCapacity`/`QueueCapacity`) | same, walking `/blobServices/default`, `/fileServices/default`, `/tableServices/default`, `/queueServices/default` | same |
| Dedicated SQL pool size (table count, row count, reserved / data / index space in MB + GB, % of MaxSize) | `sys.dm_pdw_nodes_db_partition_stats` JOIN `sys.tables` | [queries/pool_size.sql](src/synapse_migration_analyzer/modules/storage/queries/pool_size.sql) |

> Premium / non-Gen2 accounts that don't expose blob/file/table/queue services are silently skipped — the inventory row is still emitted but no capacity row is added.
>
> Honours `SMA_DEDICATED_POOL` to scope the dedicated-pool size query (same env var used by Module 1).

### 6.2 Required permissions

- `Reader` on the subscription **or** on each individual resource group containing storage accounts. The analyzer tries subscription-wide listing first, then falls back to listing the workspace's own RG, and finally to a direct fetch of the workspace's default ADLS Gen2 — so RG-scoped Reader is enough as long as it covers the RGs you care about.
- `Monitoring Reader` on each storage account (or its RG) for the capacity metrics.
- The same SQL login used by Module 1 (the DMV query runs against `sys.dm_pdw_nodes_db_partition_stats` + `sys.tables`).

### 6.3 Run

```powershell
sma analyze-storage
```

### 6.4 Outputs (under `./output/` by default)

- `storage.json`, `storage.md`, `storage.html`
- `storage_accounts.csv`, `storage_capacity.csv`, `dedicated_pool_storage.csv`

---

## Module 7 — `fabric_mapping`

Aggregates the JSON outputs of modules 1–6 (dedicated, serverless, spark, pipelines, monitoring, storage) from `SMA_OUTPUT_DIR` and applies heuristic rules to produce a **Fabric Warehouse migration recommendation report**. No Azure access required at this stage — it only reads files.

### 7.1 What it does

For each module output it finds in `./output/`, it loads the JSON, summarizes counts, and runs rule sets defined in [rules.py](src/synapse_migration_analyzer/modules/fabric_mapping/rules.py). Examples included today:

| Rule | Severity | Trigger |
|---|---|---|
| Paused dedicated pool | `warning` | `inventory.status == "Paused"` |
| Non-Fabric collation | `warning` | dedicated pool collation ≠ `Latin1_General_100_BIN2_UTF8` |
| Large REPLICATE table | `warning` | distribution = REPLICATE & rows > 50M |
| Large ROUND_ROBIN table | `info` | rows > 100M |
| Large heap table | `info` | index_type = HEAP & rows > 1M |
| Workload groups defined | `info` | any present |
| T-SQL surface gap | `info` / `warning` / `blocker` | code object matches a [tsql_surface.py](src/synapse_migration_analyzer/modules/fabric_mapping/tsql_surface.py) rule (MERGE, cursors, CLR, triggers, XML methods, three-part names…) |
| External tables inventory | `info` | from serverless |
| Serverless cost baseline | `info` | from serverless cost estimate |
| Top serverless query | `info` | per top-query entry |
| Spark pools / notebooks / SJDs | `info` | any present |
| Pipelines inventory | `info` | any pipeline detected |
| Fabric-unsupported activity | `warning` / `blocker` | per [fabric_compat.py](src/synapse_migration_analyzer/modules/pipelines/fabric_compat.py) catalog (ExecuteDataFlow, HDInsight*, AzureML*, SSIS, Custom…) |
| Fabric-unsupported linked service | `warning` | linked service type not in Fabric catalog |
| Self-hosted IR detected | `warning` | IR type starts with "Self" |
| DWU sizing hint | `info` / `warning` | monitoring `DWUUsedPercent` p95 < 30 % (downsize) or > 85 % (upsize) |
| Connections blocked by firewall | `warning` | monitoring `ConnectionsBlockedByFirewall` max > 0 |

Each recommendation has: `id`, `area`, `title`, `severity` (`info`/`warning`/`blocker`), `effort` (`low`/`medium`/`high`), `target`, `detail`, and a `fabric_action`.

### 7.2 Run & outputs

```powershell
# After running modules 1–6 (or `sma analyze-all`):
sma map-to-fabric
```

Produces:
- `fabric_mapping.json`
- `fabric_recommendations.csv`
- `fabric_mapping.md` (sortable summary table + detailed sections)
- `fabric_mapping.html` (readiness card, capacity projection, recommendations grouped by area, runbook by phase)

### 7.3 Programmatic use

```python
from synapse_migration_analyzer.config import load_config
from synapse_migration_analyzer.modules.fabric_mapping.analyzer import FabricMappingAnalyzer

cfg = load_config()
report = FabricMappingAnalyzer(cfg).run()
for rec in report.recommendations:
    print(rec.severity.upper(), rec.title, "→", rec.fabric_action)
```

To add a new rule, append a function to [rules.py](src/synapse_migration_analyzer/modules/fabric_mapping/rules.py) and wire it into `_RULES` in [analyzer.py](src/synapse_migration_analyzer/modules/fabric_mapping/analyzer.py). Side-effect-free pure functions are easy to unit-test.

---

## Module 10 — `cost` (v1.2)

Aggregates Azure Cost Management consumption for the workspace's resource group, attributes
spend by resource kind / pool / storage account, compares the Synapse run-rate against the
Fabric capacity projection produced by Module 7, and emits severity-tagged findings.

### 10.1 Where the data comes from

| Area | Source | File |
|---|---|---|
| Monthly consumption rows (cost + usage by `ResourceId` / `MeterCategory` / `ServiceName`) | **Azure Cost Management** REST API via `azure-mgmt-costmanagement` (`CostManagementClient.query.usage`) at scope `/subscriptions/<sub>/resourceGroups/<rg>` | [cost_client.py](src/synapse_migration_analyzer/modules/cost/cost_client.py) |
| Resource-kind classification (`dedicated_pool` / `spark_pool` / `synapse_workspace` / `storage` / `other`) | derived from each row's `ResourceId` | [cost_client.py](src/synapse_migration_analyzer/modules/cost/cost_client.py) |
| Fabric SKU TCO comparison | reads `output/fabric_mapping.json` (`cu_projection`) — no live calls | [fabric_compare.py](src/synapse_migration_analyzer/modules/cost/fabric_compare.py) |
| Findings (savings / increase / month-over-month spikes / kind concentration / no-data branches) | pure-Python rules engine | [rules.py](src/synapse_migration_analyzer/modules/cost/rules.py) |

### 10.2 Module-specific prerequisites

1. **Optional Python extra** — install `azure-mgmt-costmanagement`:

    ```powershell
    pip install -e ".[cost]"
    ```

   Without it, `sma analyze-cost` runs but emits a `cost.sdk_missing` finding (medium) and
   no live data.

2. **RBAC** — the service principal needs **Cost Management Reader** on the subscription
   or the workspace's resource group. `Reader` alone is not enough; Cost Management is a
   separate provider:

    ```powershell
    az role assignment create `
      --assignee <CLIENT_ID> `
      --role "Cost Management Reader" `
      --scope /subscriptions/<SUB_ID>/resourceGroups/<RG>
    ```

3. **Tunable env vars:**

   | Env var | Default | Effect |
   |---|---|---|
   | `SMA_COST_MONTHS` | `3` | Window: last *N* full months + month-to-date |
   | `SMA_COST_DISABLE_LIVE` | unset | When `1`/`true`/`yes`, skip the SDK call entirely (emits `cost.live_disabled` info finding) |

### 10.3 Run & outputs

```powershell
sma analyze-cost
sma analyze-cost --months 6        # widen the window for one run
```

Produces (under `./output/`):
- `cost.json`, `cost.md`, `cost.html`
- `cost_by_resource_kind.csv`, `cost_findings.csv`

### 10.4 Diagnosing "No cost rows captured"

The rules engine surfaces the underlying reason in the finding `rule_id`:

| `rule_id` | Severity | Meaning |
|---|---|---|
| `cost.sdk_missing` | medium | The optional `azure-mgmt-costmanagement` SDK is not installed |
| `cost.live_disabled` | info | `SMA_COST_DISABLE_LIVE` is set |
| `cost.collection_error` | medium | The Cost Management API call raised — see `errors[]` in `cost.json` (most often `AuthorizationFailed` → missing **Cost Management Reader**) |
| `cost.no_data` | info | The SDK call succeeded but the window genuinely had no rows. Try `SMA_COST_MONTHS=6` |

---

## End-to-end

```powershell
# Run modules 1→7 in execution order (dedicated, serverless, spark, pipelines,
# monitoring, storage, fabric_mapping) and refresh the top-level index.html navigation:
sma analyze-all

# Or rebuild only the index.html landing page after editing/regenerating reports:
sma index
```

Open `output/index.html` in a browser — it links to whichever module HTML reports exist
(and shows a *missing* card with the exact `sma analyze-...` command for the rest).

---

## Optional — browser-driven control plane

For analysts who would rather drive the analyzer from a browser than the CLI,
`sma serve --with-api` boots a local FastAPI backend plus the SPA on the same
origin. It is **opt-in** (extra install) and **loopback-only by default**.

```powershell
# Install the [web] extras (one-off)
pip install -e ".[web]"

# Build the SPA bundle once (re-run only when web/ source changes)
cd web
npm install
npm run build
cd ..

# Boot the control plane
sma serve --with-api                       # http://127.0.0.1:8000/
sma serve --with-api --port 8001           # custom port
sma serve --with-api --runs-dir D:\runs    # custom run repo (default ./runs)
```

The SPA gets four extra pages when the API is detected (`GET /api/healthz`):

| Page | What it does |
| --- | --- |
| **Configuration** | Read / write `.env` from the browser. Secrets are write-only; reads return only `set` / `unset`. Includes a **Validate** button. |
| **Run** | Pick which modules to run (same module set as `analyze-all`), give the run an optional label, watch live progress over Server-Sent Events. |
| **Runs** | History of all completed runs with status, duration, error count, readiness score. |
| **Diff** | Compare any two runs using the same `run_manifest` engine that powers `sma run-delta`. |

The **Dashboard** page gathers workspace-level vitals: readiness score,
T-SQL surface findings, recommendation count and SKU advisory at the top;
top blockers and inputs analyzed; a *Storage* section with stat cards for
dedicated-pool data / index space, ADLS used capacity, storage-account
count and a per-pool table; and a *Pipeline activity (last 7 days)*
section showing daily run rate, success rate, daily data movement, the
sampling window and the top 10 pipelines by run count. Storage and
pipeline sections render only when the corresponding `storage.json` /
`pipelines.json` exist for the selected run.

Results are persisted under `--runs-dir/<id>/` (default `./runs/<id>/`) so the
rest of the SPA — Dashboard, Code objects, Recommendations, Runbook, Delta —
transparently reads from the currently-selected run. The selected run id
lives in the URL hash (`#run=<id>`), so deep-links and refreshes are stable.

### Security posture

The `--with-api` server has **no authentication**:

- Bound to `127.0.0.1` by default.
- Refuses non-loopback hosts unless you pass `--i-know-this-is-not-auth`.
- All state-changing requests (`POST` / `PUT` / `DELETE`) require an
  `X-SMA-API: 1` header (defence in depth against drive-by CSRF; the SPA
  sets it).
- Run id and module name are validated against strict regexes; the run
  repository resolves all paths under `--runs-dir` to block traversal.
- The client secret is never returned over the wire — only its presence.

Do not expose the control plane on a shared or multi-user host. If you need
remote access, put it behind your own authenticating reverse proxy or VPN.

---

## Cross-module rule index — what `fabric_mapping` synthesizes

The fabric_mapping rules engine in [rules.py](src/synapse_migration_analyzer/modules/fabric_mapping/rules.py) walks every other module's JSON output and synthesizes Fabric-Warehouse migration recommendations. Headline detections:

| Rule family | Source | Examples |
|---|---|---|
| Collation mismatch  | dedicated_pools `inventory.collation` | Anything other than Fabric default `Latin1_General_100_BIN2_UTF8` |
| Column-level collation audit | dedicated_pools `column_collations[]` | Per-column collations differing from DB default |
| Materialized-view inventory | dedicated_pools `materialized_views[]` | Indexed views (Fabric Warehouse has no MV) |
| Stale statistics | dedicated_pools `statistics[]` | `days_since_update > 14` |
| Distribution-key advisor | dedicated_pools `distribution_candidates[]` | Top-N candidates per ROUND_ROBIN / large REPLICATE table (skew + filter-selectivity) |
| T-SQL surface scan with stable code-object ids | dedicated_pools `code_objects[].definition` | MERGE, CURSOR, global temp (`##`), CLR / external procs, DML+DDL triggers, XML data-type methods, ROWVERSION, sequences, three-part names — each finding cites `code_object_id`s |
| Activity-level Fabric gaps | pipelines `activities[].support` | `ExecuteDataFlow`, `ExecuteSSISPackage`, `Custom`, HDInsight*, AzureML* |
| Linked-service compatibility | pipelines `linked_services[].fabric_supported` | `HDInsight`, `Cassandra`, `Greenplum`, `Vertica`, … |
| DWU sizing hints | monitoring `DWUUsedPercent` p95 | <30 % → downsize, 30–85 % → match, >85 % → upsize |
| Connections-blocked signal | monitoring `ConnectionsBlockedByFirewall` | Surfaces firewall/auth issues to fix before migrating |

The full keyword list lives in [tsql_surface.py](src/synapse_migration_analyzer/modules/fabric_mapping/tsql_surface.py) and the activity catalog in [pipelines/fabric_compat.py](src/synapse_migration_analyzer/modules/pipelines/fabric_compat.py) — both are designed to be extended.

---

## Modules — Future roadmap

Each future module follows the same conventions as `dedicated_pools`:

```
modules/<name>/
├── analyzer.py        # exposes a class with .run() -> Pydantic result
├── <ctrl>_client.py   # control-plane (ARM / REST) wrapper
├── <data>_client.py   # data-plane (SQL / Livy / Pipelines API) wrapper
├── models.py          # Pydantic v2 models
├── collectors/        # one collector per concern
└── queries/           # SQL / KQL / REST payloads
```

A new CLI subcommand is registered in [cli.py](src/synapse_migration_analyzer/cli.py), and writers in [reporting/](src/synapse_migration_analyzer/reporting) are extended (or reused) to render the new models.

| Module | Planned scope |
|---|---|
| `serverless_pools` v3 | Per-database query history, partition-pruning analysis, OPENROWSET pattern detection |
| `spark_pools` v3 | Library/package inventory, Spark job run history (Livy), notebook API surface scan |
| `pipelines` v3 | Per-activity parameter binding analysis, expression-language compatibility checks |
| `fabric_mapping` v3 | Auto-generated migration runbook with sequenced steps + cost projection |
| `monitoring` v2 | Log Analytics / KQL queries (long-running queries, top users), 30–90 day windows |

> **Mid-term modules already shipped (v1):** `governance` (RBAC + MPE + CMK + Purview), `security`
> (firewall + AAD admins + per-pool TDE + linked-service inline-secret detection), `cost`
> (Cost Management consumption + Fabric SKU TCO delta + month-over-month spike detection),
> `fabric_validation` (post-migration object/row/collation/T-SQL surface checks), and
> **Incremental / delta runs** (run manifest + markdown/HTML/JSON delta with record-count peeks)
> — see the per-module CLI commands in the table at the top.

> Note: `dedicated_pools` v2 (column collation audit, distribution-key advisor with skew + filter
> selectivity, materialized-view inventory, statistics freshness, T-SQL surface gap rollup with
> stable code-object ids) is **shipped** — see [§1.1](#11-what-it-captures) above.

---

## Cheat sheet

```powershell
# Activate venv
.\.venv\Scripts\Activate.ps1

# Per-module
sma analyze-dedicated-pools
sma analyze-serverless-pools
sma analyze-spark-pools
sma analyze-pipelines
sma analyze-monitoring
sma analyze-storage
sma map-to-fabric

# Mid-term modules (v1)
sma analyze-governance
sma analyze-security
sma analyze-cost              # requires .[cost] extra for live data
sma validate-fabric           # post-migration validation

# Everything end-to-end (also refreshes index.html and emits run manifest + delta)
sma analyze-all

# Just compare the current artifacts vs the previous run
sma run-delta

# Just rebuild the top-level landing page
sma index

# Self-test (host + Azure auth pre-flight)
sma doctor
sma doctor --offline

# Tests
pytest

# Help
sma --help
sma analyze-dedicated-pools --help
```
