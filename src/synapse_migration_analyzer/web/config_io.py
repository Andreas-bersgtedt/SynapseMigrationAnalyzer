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
        checks.append(ConfigCheck(name=name, ok=ok, detail=detail))

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


def _is_writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        return os.access(path, os.W_OK)
    except OSError:
        return False
