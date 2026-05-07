"""Read / write the .env file used by ``load_config``.

The web Configuration page is the single trusted writer. Reads always
redact ``AZURE_CLIENT_SECRET`` to ``"set"`` / ``"unset"``; writes
accept a plaintext secret only when the request includes the
``X-SMA-API`` marker (enforced globally by app middleware).
"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path

from dotenv import dotenv_values, set_key, unset_key

from .schemas import (
    AppConfigPublic,
    AppConfigUpdate,
    AzureConfigPublic,
    ConfigCheck,
    SqlConfigPublic,
)

log = logging.getLogger(__name__)

# Env-var name <-> dotted-path (azure.tenant_id, sql.odbc_driver, ...)
_AZURE_KEYS = {
    "AZURE_TENANT_ID": "tenant_id",
    "AZURE_CLIENT_ID": "client_id",
    "AZURE_SUBSCRIPTION_ID": "subscription_id",
    "SYNAPSE_RESOURCE_GROUP": "resource_group",
    "SYNAPSE_WORKSPACE_NAME": "workspace_name",
    "SYNAPSE_DEDICATED_POOL": "dedicated_pool",
}
_SQL_KEYS = {
    "SQL_ODBC_DRIVER": "odbc_driver",
    "SQL_LOGIN_TIMEOUT": "login_timeout",
    "SQL_QUERY_TIMEOUT": "query_timeout",
}
_OUTPUT_KEY = "SMA_OUTPUT_DIR"
_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def read_config(env_file: Path) -> AppConfigPublic:
    values = dotenv_values(env_file) if env_file.exists() else {}
    azure = AzureConfigPublic(
        tenant_id=values.get("AZURE_TENANT_ID"),
        client_id=values.get("AZURE_CLIENT_ID"),
        client_secret="set" if values.get("AZURE_CLIENT_SECRET") else "unset",
        subscription_id=values.get("AZURE_SUBSCRIPTION_ID"),
        resource_group=values.get("SYNAPSE_RESOURCE_GROUP"),
        workspace_name=values.get("SYNAPSE_WORKSPACE_NAME"),
        dedicated_pool=values.get("SYNAPSE_DEDICATED_POOL"),
    )
    sql = SqlConfigPublic(
        odbc_driver=values.get("SQL_ODBC_DRIVER", "ODBC Driver 18 for SQL Server"),
        login_timeout=int(values.get("SQL_LOGIN_TIMEOUT") or 30),
        query_timeout=int(values.get("SQL_QUERY_TIMEOUT") or 120),
    )
    output_dir = Path(values.get(_OUTPUT_KEY) or "./output")
    return AppConfigPublic(
        azure=azure,
        sql=sql,
        output_dir=output_dir,
        env_file=env_file,
        env_file_exists=env_file.exists(),
    )


def write_config(env_file: Path, update: AppConfigUpdate) -> list[str]:
    """Persist ``update`` to ``env_file``. Returns warnings."""
    warnings: list[str] = []
    env_file = env_file.resolve()
    env_file.parent.mkdir(parents=True, exist_ok=True)
    if not env_file.exists():
        env_file.touch(mode=0o600)
        warnings.append(f"created new {env_file}")
    else:
        # Best-effort restrict perms on POSIX.
        try:
            env_file.chmod(0o600)
        except OSError:
            pass

    if update.azure is not None:
        for env_key, attr in _AZURE_KEYS.items():
            value = getattr(update.azure, attr)
            if value is None:
                continue
            set_key(str(env_file), env_key, value, quote_mode="never")
        # Secret handling.
        if update.azure.client_secret is not None:
            if update.azure.client_secret == "":
                unset_key(str(env_file), "AZURE_CLIENT_SECRET")
            else:
                set_key(str(env_file), "AZURE_CLIENT_SECRET",
                        update.azure.client_secret, quote_mode="never")
                warnings.append("AZURE_CLIENT_SECRET written to .env")
    if update.sql is not None:
        for env_key, attr in _SQL_KEYS.items():
            value = getattr(update.sql, attr)
            if value is None:
                continue
            set_key(str(env_file), env_key, str(value), quote_mode="never")
    if update.output_dir is not None:
        set_key(str(env_file), _OUTPUT_KEY, str(update.output_dir), quote_mode="never")
    return warnings


def validate_config(env_file: Path) -> list[ConfigCheck]:
    """Return per-field readiness checks the SPA renders as a list."""
    values = dotenv_values(env_file) if env_file.exists() else {}
    checks: list[ConfigCheck] = []

    def _check(name: str, ok: bool, detail: str | None = None) -> None:
        checks.append(ConfigCheck(name=name, ok=ok, detail=detail, category="Configuration"))

    _check(".env file present", env_file.exists(), str(env_file))
    for env_key in ("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_SUBSCRIPTION_ID"):
        v = values.get(env_key)
        if not v:
            _check(env_key, False, "missing")
        elif _GUID_RE.match(v):
            _check(env_key, True)
        else:
            _check(env_key, False, "not a GUID")
    _check(
        "AZURE_CLIENT_SECRET",
        bool(values.get("AZURE_CLIENT_SECRET")),
        "set" if values.get("AZURE_CLIENT_SECRET") else "missing",
    )
    for env_key in ("SYNAPSE_RESOURCE_GROUP", "SYNAPSE_WORKSPACE_NAME"):
        v = values.get(env_key)
        _check(env_key, bool(v), v if v else "missing")

    # Output dir
    out_dir = Path(values.get(_OUTPUT_KEY) or "./output")
    _check("output_dir writable", _is_writable(out_dir), str(out_dir.resolve()))

    return checks


_REQUIRED_LIVE = (
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_SUBSCRIPTION_ID",
    "SYNAPSE_RESOURCE_GROUP",
    "SYNAPSE_WORKSPACE_NAME",
)


def validate_config_live(env_file: Path) -> list[ConfigCheck]:
    """Field checks + live connectivity checks (Azure control plane + Synapse data plane).

    Each live check is wrapped: a connection failure becomes ``ok=False`` rather
    than raising. The intent is to give the SPA a clear PASS/FAIL grid that
    distinguishes 'env vars OK' from 'data plane RBAC is granted'.
    """
    checks = validate_config(env_file)
    values = dotenv_values(env_file) if env_file.exists() else {}
    if any(not values.get(k) for k in _REQUIRED_LIVE):
        checks.append(ConfigCheck(
            name="Live connectivity",
            ok=False,
            detail="skipped — fill in all required fields and Save before running live checks",
            category="Control plane",
        ))
        return checks

    tenant = values["AZURE_TENANT_ID"]
    client_id = values["AZURE_CLIENT_ID"]
    secret = values["AZURE_CLIENT_SECRET"]
    subscription = values["AZURE_SUBSCRIPTION_ID"]
    rg = values["SYNAPSE_RESOURCE_GROUP"]
    workspace = values["SYNAPSE_WORKSPACE_NAME"]
    pool = values.get("SYNAPSE_DEDICATED_POOL") or None
    odbc_driver = values.get("SQL_ODBC_DRIVER") or "ODBC Driver 18 for SQL Server"
    login_timeout = int(values.get("SQL_LOGIN_TIMEOUT") or 30)

    # Build a credential once and reuse.
    try:
        from azure.identity import ClientSecretCredential
        cred = ClientSecretCredential(tenant_id=tenant, client_id=client_id, client_secret=secret)
    except Exception as exc:  # noqa: BLE001
        checks.append(ConfigCheck(
            name="AAD credential", ok=False, detail=str(exc), category="Control plane",
        ))
        return checks

    # --- Control plane -----------------------------------------------------
    arm_token = None
    try:
        arm_token = cred.get_token("https://management.azure.com/.default")
        checks.append(ConfigCheck(
            name="AAD token (ARM)", ok=True,
            detail="https://management.azure.com/.default", category="Control plane",
        ))
    except Exception as exc:  # noqa: BLE001
        checks.append(ConfigCheck(
            name="AAD token (ARM)", ok=False, detail=str(exc), category="Control plane",
        ))

    if arm_token is not None:
        try:
            from azure.mgmt.synapse import SynapseManagementClient
            mgmt = SynapseManagementClient(cred, subscription)
            ws = mgmt.workspaces.get(resource_group_name=rg, workspace_name=workspace)
            checks.append(ConfigCheck(
                name="Synapse workspace (ARM Reader)", ok=True,
                detail=f"{ws.name} in {ws.location}", category="Control plane",
            ))
        except Exception as exc:  # noqa: BLE001
            checks.append(ConfigCheck(
                name="Synapse workspace (ARM Reader)", ok=False,
                detail=str(exc), category="Control plane",
            ))

    # --- Data plane: Synapse Artifacts (pipelines RBAC) --------------------
    try:
        from azure.synapse.artifacts import ArtifactsClient
        endpoint = f"https://{workspace}.dev.azuresynapse.net"
        art = ArtifactsClient(endpoint=endpoint, credential=cred)
        # Touch the iterator just enough to force a real REST call + auth.
        it = art.pipeline.get_pipelines_by_workspace()
        sample = next(iter(it), None)
        detail = f"endpoint reachable; {'pipelines found' if sample is not None else 'no pipelines (auth OK)'}"
        checks.append(ConfigCheck(
            name="Synapse Artifacts (Synapse Artifact User)", ok=True,
            detail=detail, category="Data plane",
        ))
    except ImportError:
        checks.append(ConfigCheck(
            name="Synapse Artifacts (Synapse Artifact User)", ok=False,
            detail="azure-synapse-artifacts not installed", category="Data plane",
        ))
    except Exception as exc:  # noqa: BLE001
        checks.append(ConfigCheck(
            name="Synapse Artifacts (Synapse Artifact User)", ok=False,
            detail=str(exc), category="Data plane",
        ))

    # --- Data plane: SQL token + serverless SELECT 1 -----------------------
    sql_token_ok = False
    try:
        cred.get_token("https://database.windows.net/.default")
        sql_token_ok = True
        checks.append(ConfigCheck(
            name="AAD token (SQL)", ok=True,
            detail="https://database.windows.net/.default", category="Data plane",
        ))
    except Exception as exc:  # noqa: BLE001
        checks.append(ConfigCheck(
            name="AAD token (SQL)", ok=False, detail=str(exc), category="Data plane",
        ))

    if sql_token_ok:
        serverless_fqdn = f"{workspace}-ondemand.sql.azuresynapse.net"
        ok, detail = _try_sql_select1(cred, serverless_fqdn, "master", odbc_driver, login_timeout)
        checks.append(ConfigCheck(
            name=f"Serverless SQL SELECT 1 ({serverless_fqdn})",
            ok=ok, detail=detail, category="Data plane",
        ))

        if pool:
            dedicated_fqdn = f"{workspace}.sql.azuresynapse.net"
            ok, detail = _try_sql_select1(cred, dedicated_fqdn, pool, odbc_driver, login_timeout)
            checks.append(ConfigCheck(
                name=f"Dedicated SQL SELECT 1 ({dedicated_fqdn} / {pool})",
                ok=ok, detail=detail, category="Data plane",
            ))

    return checks


def _try_sql_select1(
    cred,
    server_fqdn: str,
    database: str,
    odbc_driver: str,
    login_timeout: int,
) -> tuple[bool, str]:
    """Connect via pyodbc + AAD access token and run SELECT 1. Never raises."""
    try:
        import struct

        import pyodbc  # type: ignore

        from .._odbc import resolve_odbc_driver
    except ImportError as exc:
        return False, f"pyodbc / _odbc not importable: {exc}"
    try:
        driver = resolve_odbc_driver(odbc_driver)
        token = cred.get_token("https://database.windows.net/.default").token
        encoded = token.encode("utf-16-le")
        token_struct = struct.pack("=i", len(encoded)) + encoded
        conn_str = (
            f"Driver={{{driver}}};"
            f"Server=tcp:{server_fqdn},1433;"
            f"Database={database};"
            f"Encrypt=yes;TrustServerCertificate=no;"
            f"Connection Timeout={login_timeout};"
        )
        with pyodbc.connect(conn_str, attrs_before={1256: token_struct}, timeout=login_timeout) as cn:
            cur = cn.cursor()
            cur.execute("SELECT 1")
            cur.fetchone()
        return True, "connected and ran SELECT 1"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)



def _is_writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        return os.access(path, os.W_OK)
    except OSError:
        return False
