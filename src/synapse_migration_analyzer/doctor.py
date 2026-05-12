"""Self-test / pre-flight check used by the `sma doctor` CLI command.

Each check is a small callable returning a `CheckResult`. The runner prints a
table and exits non-zero if any required check failed.
"""
from __future__ import annotations

import importlib
import os
import platform
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal

from rich.console import Console
from rich.table import Table

Status = Literal["pass", "warn", "fail", "skip"]

_REQUIRED_ENV = (
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_SUBSCRIPTION_ID",
    "SYNAPSE_RESOURCE_GROUP",
    "SYNAPSE_WORKSPACE_NAME",
)

_PACKAGES = (
    "azure.identity",
    "azure.mgmt.synapse",
    "azure.mgmt.resource",
    "azure.mgmt.monitor",
    "azure.mgmt.storage",
    "azure.synapse.artifacts",
    "azure.synapse.spark",
    "pyodbc",
    "pydantic",
    "click",
    "rich",
)


@dataclass
class CheckResult:
    name: str
    status: Status
    detail: str = ""
    required: bool = True


@dataclass
class DoctorReport:
    results: list[CheckResult] = field(default_factory=list)

    @property
    def failed(self) -> list[CheckResult]:
        return [r for r in self.results if r.status == "fail" and r.required]

    @property
    def ok(self) -> bool:
        return not self.failed


# --------------------------------------------------------------------------- #
# Individual checks. Each returns a CheckResult and never raises.
# --------------------------------------------------------------------------- #

def _check_python() -> CheckResult:
    major, minor = sys.version_info[:2]
    detail = f"{platform.python_version()} on {platform.platform()}"
    if (major, minor) < (3, 12):
        return CheckResult("Python >= 3.12", "fail", detail)
    return CheckResult("Python >= 3.12", "pass", detail)


def _check_packages() -> list[CheckResult]:
    out: list[CheckResult] = []
    for mod in _PACKAGES:
        try:
            importlib.import_module(mod)
            out.append(CheckResult(f"import {mod}", "pass"))
        except ImportError as exc:
            out.append(CheckResult(f"import {mod}", "fail", str(exc)))
    return out


def _check_odbc_driver() -> CheckResult:
    try:
        import pyodbc  # type: ignore
    except ImportError as exc:
        return CheckResult("ODBC driver", "fail", f"pyodbc not importable: {exc}")
    drivers = [d for d in pyodbc.drivers() if "ODBC Driver" in d and "SQL Server" in d]
    if not drivers:
        return CheckResult(
            "ODBC driver",
            "fail",
            "No 'ODBC Driver xx for SQL Server' found. Install Microsoft ODBC Driver 18 "
            "(https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server). "
            "This is the IM002 'Data source name not found' error from pyodbc.",
        )
    configured = os.getenv("SQL_ODBC_DRIVER", "ODBC Driver 18 for SQL Server")
    if not any(d.lower() == configured.lower() for d in drivers):
        return CheckResult(
            "ODBC driver",
            "warn",
            f"Configured SQL_ODBC_DRIVER={configured!r} not installed; runtime will "
            f"fall back to the highest installed driver. Installed: "
            f"{', '.join(sorted(drivers))}. Update SQL_ODBC_DRIVER in .env to silence "
            "this warning.",
            required=False,
        )
    return CheckResult("ODBC driver", "pass", ", ".join(sorted(drivers)))


def _check_azure_cli() -> CheckResult:
    """Azure CLI is needed for the QUICKSTART §0.3 service-principal flow.

    It is *not* required at runtime by any analyzer (we use ClientSecretCredential),
    so we report this as a non-required WARN if missing.
    """
    import shutil
    import subprocess

    az = shutil.which("az")
    if az is None:
        return CheckResult(
            "Azure CLI (az)",
            "warn",
            "Not found on PATH. Needed only for QUICKSTART §0.3 (creating the service "
            "principal). See the Portal alternative if you cannot install it.",
            required=False,
        )
    try:
        proc = subprocess.run(
            [az, "version", "--output", "tsv", "--query", "\"azure-cli\""],
            capture_output=True, text=True, timeout=15, check=False,
        )
        version = (proc.stdout or "").strip().splitlines()[0] if proc.stdout else "unknown"
    except (OSError, subprocess.TimeoutExpired) as exc:
        return CheckResult(
            "Azure CLI (az)",
            "warn",
            f"Found at {az} but `az version` failed: {exc}",
            required=False,
        )
    return CheckResult("Azure CLI (az)", "pass", f"{az} (azure-cli {version})")


def _check_env_file() -> CheckResult:
    p = Path(".env")
    if not p.exists():
        return CheckResult(
            ".env present",
            "warn",
            "No ./.env found — copy .env.example and populate it for live checks.",
            required=False,
        )
    return CheckResult(".env present", "pass", str(p.resolve()))


def _check_env_vars() -> CheckResult:
    # Load ./.env only — never walk up to a parent project .env (matches
    # _check_env_file's contract and keeps the test isolated from ambient state).
    try:
        from dotenv import load_dotenv  # type: ignore

        env_path = Path(".env")
        if env_path.exists():
            load_dotenv(dotenv_path=env_path, override=False)
    except ImportError:
        pass
    missing = [k for k in _REQUIRED_ENV if not os.getenv(k)]
    if missing:
        return CheckResult(
            "Required env vars",
            "fail",
            f"Missing: {', '.join(missing)}",
        )
    return CheckResult("Required env vars", "pass", f"{len(_REQUIRED_ENV)} variables set")


def _check_output_dir() -> CheckResult:
    out = Path(os.getenv("SMA_OUTPUT_DIR", "./output")).resolve()
    try:
        out.mkdir(parents=True, exist_ok=True)
        probe = out / ".sma_doctor_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        return CheckResult("Output dir writable", "fail", f"{out}: {exc}")
    return CheckResult("Output dir writable", "pass", str(out))


def _check_aad_token(skip_live: bool) -> CheckResult:
    if skip_live:
        return CheckResult("AAD token (ARM)", "skip", "live checks disabled (--offline)", required=False)
    if any(not os.getenv(k) for k in _REQUIRED_ENV):
        return CheckResult("AAD token (ARM)", "skip", "env vars not set", required=False)
    try:
        from azure.identity import ClientSecretCredential

        cred = ClientSecretCredential(
            tenant_id=os.environ["AZURE_TENANT_ID"],
            client_id=os.environ["AZURE_CLIENT_ID"],
            client_secret=os.environ["AZURE_CLIENT_SECRET"],
        )
        token = cred.get_token("https://management.azure.com/.default")
        return CheckResult("AAD token (ARM)", "pass", f"expires_on={token.expires_on}")
    except Exception as exc:  # noqa: BLE001 - surfaced to user as 'fail'
        return CheckResult("AAD token (ARM)", "fail", str(exc))


def _check_workspace_reachable(skip_live: bool) -> CheckResult:
    if skip_live:
        return CheckResult("Synapse workspace reachable", "skip", "live checks disabled (--offline)", required=False)
    if any(not os.getenv(k) for k in _REQUIRED_ENV):
        return CheckResult("Synapse workspace reachable", "skip", "env vars not set", required=False)
    try:
        from azure.identity import ClientSecretCredential
        from azure.mgmt.synapse import SynapseManagementClient

        cred = ClientSecretCredential(
            tenant_id=os.environ["AZURE_TENANT_ID"],
            client_id=os.environ["AZURE_CLIENT_ID"],
            client_secret=os.environ["AZURE_CLIENT_SECRET"],
        )
        client = SynapseManagementClient(cred, os.environ["AZURE_SUBSCRIPTION_ID"])
        ws = client.workspaces.get(
            resource_group_name=os.environ["SYNAPSE_RESOURCE_GROUP"],
            workspace_name=os.environ["SYNAPSE_WORKSPACE_NAME"],
        )
        return CheckResult(
            "Synapse workspace reachable",
            "pass",
            f"{ws.name} ({ws.location})",
        )
    except Exception as exc:  # noqa: BLE001
        return CheckResult("Synapse workspace reachable", "fail", str(exc))


def _check_spark_livy(skip_live: bool) -> CheckResult:
    """Probe Spark Livy on the first available pool — requires the Synapse RBAC
    action ``Microsoft.Synapse/workspaces/bigDataPools/useCompute/action`` (granted
    by **Synapse Compute Operator** or higher). Returns ``warn`` if the workspace
    has no Spark pools (then `analyze-spark-pools` Livy history is N/A)."""
    name = "Spark Livy (Synapse Compute Operator)"
    if skip_live:
        return CheckResult(name, "skip", "live checks disabled (--offline)", required=False)
    if any(not os.getenv(k) for k in _REQUIRED_ENV):
        return CheckResult(name, "skip", "env vars not set", required=False)
    try:
        from azure.identity import ClientSecretCredential
        from azure.mgmt.synapse import SynapseManagementClient
        from azure.synapse.spark import SparkClient

        cred = ClientSecretCredential(
            tenant_id=os.environ["AZURE_TENANT_ID"],
            client_id=os.environ["AZURE_CLIENT_ID"],
            client_secret=os.environ["AZURE_CLIENT_SECRET"],
        )
        ws_name = os.environ["SYNAPSE_WORKSPACE_NAME"]
        rg_name = os.environ["SYNAPSE_RESOURCE_GROUP"]
        mgmt = SynapseManagementClient(cred, os.environ["AZURE_SUBSCRIPTION_ID"])
        pool_names = [p.name for p in mgmt.big_data_pools.list_by_workspace(rg_name, ws_name)]
        if not pool_names:
            return CheckResult(
                name, "warn",
                "no Spark pools in workspace — Livy history is N/A",
                required=False,
            )
        probe = pool_names[0]
        spark = SparkClient(
            credential=cred,
            endpoint=f"https://{ws_name}.dev.azuresynapse.net",
            spark_pool_name=probe,
            livy_api_version="2019-11-01-preview",
        )
        try:
            spark.spark_batch.get_spark_batch_jobs(from_parameter=0, size=1, detailed=False)
        finally:
            try:
                spark.close()
            except Exception:  # noqa: BLE001
                pass
        return CheckResult(
            name, "pass",
            f"useCompute granted on '{probe}' ({len(pool_names)} pool(s))",
        )
    except Exception as exc:  # noqa: BLE001
        # 403 here typically means the SP lacks
        # `Microsoft.Synapse/workspaces/bigDataPools/useCompute/action`,
        # i.e. the **Synapse Compute Operator** role on the pool.
        return CheckResult(name, "fail", str(exc), required=False)


def _check_sql_token(skip_live: bool) -> CheckResult:
    if skip_live:
        return CheckResult("SQL access token", "skip", "live checks disabled (--offline)", required=False)
    if any(not os.getenv(k) for k in _REQUIRED_ENV):
        return CheckResult("SQL access token", "skip", "env vars not set", required=False)
    try:
        from azure.identity import ClientSecretCredential

        cred = ClientSecretCredential(
            tenant_id=os.environ["AZURE_TENANT_ID"],
            client_id=os.environ["AZURE_CLIENT_ID"],
            client_secret=os.environ["AZURE_CLIENT_SECRET"],
        )
        cred.get_token("https://database.windows.net/.default")
        return CheckResult("SQL access token", "pass", "issued for database.windows.net")
    except Exception as exc:  # noqa: BLE001
        return CheckResult("SQL access token", "fail", str(exc))


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #

def run_checks(*, offline: bool = False) -> DoctorReport:
    report = DoctorReport()
    checks: list[Callable[[], CheckResult | list[CheckResult]]] = [
        _check_python,
        _check_packages,
        _check_odbc_driver,
        _check_azure_cli,
        _check_env_file,
        _check_env_vars,
        _check_output_dir,
        lambda: _check_aad_token(offline),
        lambda: _check_workspace_reachable(offline),
        lambda: _check_spark_livy(offline),
        lambda: _check_sql_token(offline),
    ]
    for fn in checks:
        result = fn()
        if isinstance(result, list):
            report.results.extend(result)
        else:
            report.results.append(result)
    return report


_STATUS_STYLE = {
    "pass": "[green]PASS[/green]",
    "warn": "[yellow]WARN[/yellow]",
    "fail": "[red]FAIL[/red]",
    "skip": "[dim]SKIP[/dim]",
}


def render_report(report: DoctorReport, console: Console) -> None:
    table = Table(title="sma doctor")
    table.add_column("Check")
    table.add_column("Status", justify="center")
    table.add_column("Detail", overflow="fold")
    for r in report.results:
        table.add_row(r.name, _STATUS_STYLE[r.status], r.detail)
    console.print(table)
    if report.ok:
        console.print("[bold green]All required checks passed.[/bold green]")
    else:
        console.print(
            f"[bold red]{len(report.failed)} required check(s) failed.[/bold red] "
            "Review the table above and fix before running an analyzer."
        )
