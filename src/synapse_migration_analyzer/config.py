"""Runtime configuration loaded from environment / .env."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class AzureConfig:
    tenant_id: str
    client_id: str
    client_secret: str
    subscription_id: str
    resource_group: str
    workspace_name: str
    dedicated_pool: str | None = None


@dataclass(frozen=True)
class SqlConfig:
    odbc_driver: str = "ODBC Driver 18 for SQL Server"
    login_timeout: int = 30
    query_timeout: int = 120


@dataclass(frozen=True)
class AppConfig:
    azure: AzureConfig
    sql: SqlConfig
    output_dir: Path


_REQUIRED = (
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_SUBSCRIPTION_ID",
    "SYNAPSE_RESOURCE_GROUP",
    "SYNAPSE_WORKSPACE_NAME",
)


def load_config(env_file: str | os.PathLike[str] | None = None) -> AppConfig:
    """Load and validate config from .env / environment variables.

    ``override=True`` is used so that the long-lived ``sma serve`` process
    picks up edits made via ``PUT /api/config`` (which rewrites ``.env``)
    instead of being pinned to whatever values were first loaded at boot.
    """
    if env_file:
        load_dotenv(env_file, override=True)
    else:
        load_dotenv(override=True)

    missing = [k for k in _REQUIRED if not os.getenv(k)]
    if missing:
        raise RuntimeError(
            f"Missing required environment variables: {', '.join(missing)}. "
            "Copy .env.example to .env and populate it."
        )

    azure = AzureConfig(
        tenant_id=os.environ["AZURE_TENANT_ID"],
        client_id=os.environ["AZURE_CLIENT_ID"],
        client_secret=os.environ["AZURE_CLIENT_SECRET"],
        subscription_id=os.environ["AZURE_SUBSCRIPTION_ID"],
        resource_group=os.environ["SYNAPSE_RESOURCE_GROUP"],
        workspace_name=os.environ["SYNAPSE_WORKSPACE_NAME"],
        dedicated_pool=os.getenv("SYNAPSE_DEDICATED_POOL") or None,
    )
    sql = SqlConfig(
        odbc_driver=os.getenv("SQL_ODBC_DRIVER", "ODBC Driver 18 for SQL Server"),
        login_timeout=int(os.getenv("SQL_LOGIN_TIMEOUT", "30")),
        query_timeout=int(os.getenv("SQL_QUERY_TIMEOUT", "120")),
    )
    output_dir = Path(os.getenv("SMA_OUTPUT_DIR", "./output")).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    return AppConfig(azure=azure, sql=sql, output_dir=output_dir)
