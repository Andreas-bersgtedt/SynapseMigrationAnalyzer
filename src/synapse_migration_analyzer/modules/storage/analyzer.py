"""Orchestrator for the storage module.

Captures three things:

1. Inventory of every storage account in the workspace's subscription
   (with the workspace's default ADLS Gen2 flagged).
2. Latest capacity metrics (`UsedCapacity`, `BlobCapacity`, `BlobCount`, …)
   for each account, pulled from Azure Monitor.
3. Actual storage occupied by each dedicated SQL pool (sum of reserved /
   data / index space across all user tables) reported in MB and GB.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

from ...config import AppConfig
from ...errors import format_error
from ..dedicated_pools.arm_client import SynapseArmClient
from ..dedicated_pools.sql_client import DedicatedPoolSqlClient
from .arm_client import StorageArmClient
from .models import (
    DedicatedPoolStorage,
    StorageAccountInventory,
    StorageAnalysis,
    StorageCapacity,
)
from .monitor_client import StorageMonitorClient

log = logging.getLogger(__name__)

_QUERIES_DIR = Path(__file__).parent / "queries"
_BYTES_PER_MB = 1024.0 * 1024.0
_BYTES_PER_GB = 1024.0 * 1024.0 * 1024.0
_MB_PER_GB = 1024.0


class StorageAnalyzer:
    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg
        self._arm = StorageArmClient(cfg.azure)
        self._monitor = StorageMonitorClient(cfg.azure)
        self._synapse_arm = SynapseArmClient(cfg.azure)

    # ------------------------------------------------------------------ entry
    def run(self) -> StorageAnalysis:
        result = StorageAnalysis(
            workspace_name=self._cfg.azure.workspace_name,
            subscription_id=self._cfg.azure.subscription_id,
            resource_group=self._cfg.azure.resource_group,
            generated_at=datetime.now(timezone.utc),
        )

        accounts = self._collect_accounts(result)
        if accounts:
            self._collect_capacities(accounts, result)

        self._collect_dedicated_pool_storage(result)
        return result

    # ------------------------------------------------------------------ steps
    def _collect_accounts(self, result: StorageAnalysis) -> list[StorageAccountInventory]:
        try:
            accounts = list(self._arm.list_storage_accounts())
        except Exception as exc:  # noqa: BLE001
            log.warning("storage_accounts collection failed: %s", exc)
            result.errors.append(format_error("storage_accounts", exc))
            return []
        log.info("Storage account inventory: %d account(s) discovered", len(accounts))
        if not accounts:
            result.errors.append(
                "storage_accounts: no accounts discovered. "
                "Verify the credential has Microsoft.Storage/storageAccounts/read at subscription "
                "scope, or at least on the workspace's resource group and the default ADLS RG."
            )
        result.accounts = accounts
        return accounts

    def _collect_capacities(
        self,
        accounts: list[StorageAccountInventory],
        result: StorageAnalysis,
    ) -> None:
        for acct in accounts:
            try:
                vals = self._monitor.latest_capacity(acct.resource_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("capacity metrics for %s failed: %s", acct.name, exc)
                result.errors.append(format_error(f"capacity[{acct.name}]", exc))
                continue
            result.capacities.append(_build_capacity(acct.name, vals))
        log.info("Storage capacity samples: %d", len(result.capacities))

    def _collect_dedicated_pool_storage(self, result: StorageAnalysis) -> None:
        # Discover pools through the existing dedicated-pools ARM client so the
        # filter logic (`SMA_DEDICATED_POOL`) is honoured.
        try:
            pools = list(self._synapse_arm.list_dedicated_pools())
        except Exception as exc:  # noqa: BLE001
            log.warning("dedicated pool discovery failed: %s", exc)
            result.errors.append(format_error("dedicated_pool_discovery", exc))
            return

        if not pools:
            return

        sql_text = (_QUERIES_DIR / "pool_size.sql").read_text(encoding="utf-8")
        server = self._synapse_arm.workspace_sql_endpoint()

        for pool in pools:
            entry = DedicatedPoolStorage(
                pool_name=pool.name,
                captured_at=datetime.now(timezone.utc),
                max_size_bytes=pool.max_size_bytes,
                max_size_gb=(round(pool.max_size_bytes / _BYTES_PER_GB, 2)
                             if pool.max_size_bytes else None),
            )
            if (pool.status or "").lower() == "paused":
                entry.notes.append("Pool is paused — DMV size query skipped.")
                result.dedicated_pool_storage.append(entry)
                continue

            try:
                client = DedicatedPoolSqlClient(self._cfg, server, pool.name)
                rows = client.fetch_all(sql_text)
            except Exception as exc:  # noqa: BLE001
                log.warning("size DMV failed for %s: %s", pool.name, exc)
                entry.notes.append(f"DMV failed: {exc}")
                result.dedicated_pool_storage.append(entry)
                result.errors.append(format_error(f"pool_size[{pool.name}]", exc))
                continue

            if rows:
                _populate_pool_storage(entry, rows[0])

            if entry.max_size_bytes and entry.reserved_space_mb:
                used_bytes = entry.reserved_space_mb * _BYTES_PER_MB
                entry.used_pct_of_max = round(
                    (used_bytes / entry.max_size_bytes) * 100.0, 2
                )

            result.dedicated_pool_storage.append(entry)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_capacity(account_name: str, vals: dict) -> StorageCapacity:
    used = vals.get("UsedCapacity")
    blob = vals.get("BlobCapacity")
    return StorageCapacity(
        account_name=account_name,
        captured_at=datetime.now(timezone.utc),
        used_capacity_bytes=int(used) if used is not None else None,
        blob_capacity_bytes=int(blob) if blob is not None else None,
        blob_count=vals.get("BlobCount"),
        container_count=vals.get("ContainerCount"),
        file_capacity_bytes=int(vals["FileCapacity"]) if vals.get("FileCapacity") is not None else None,
        file_count=vals.get("FileCount"),
        table_capacity_bytes=int(vals["TableCapacity"]) if vals.get("TableCapacity") is not None else None,
        queue_capacity_bytes=int(vals["QueueCapacity"]) if vals.get("QueueCapacity") is not None else None,
        used_capacity_mb=round(used / _BYTES_PER_MB, 2) if used is not None else None,
        used_capacity_gb=round(used / _BYTES_PER_GB, 2) if used is not None else None,
        blob_capacity_mb=round(blob / _BYTES_PER_MB, 2) if blob is not None else None,
        blob_capacity_gb=round(blob / _BYTES_PER_GB, 2) if blob is not None else None,
    )


def _populate_pool_storage(entry: DedicatedPoolStorage, row: dict) -> None:
    """Map a single result row of pool_size.sql onto the model."""
    entry.table_count = int(row.get("table_count") or 0)
    entry.row_count = int(row.get("row_count") or 0)
    reserved = float(row.get("reserved_space_mb") or 0.0)
    data = float(row.get("data_space_mb") or 0.0)
    index_or_unused = float(row.get("index_or_unused_mb") or 0.0)
    entry.reserved_space_mb = round(reserved, 2)
    entry.data_space_mb = round(data, 2)
    # `index_or_unused_mb` mixes index pages and free space — surface as
    # `index_space_mb` so it lines up with `dedicated_pools.tables.csv`.
    entry.index_space_mb = round(index_or_unused, 2)
    entry.unused_space_mb = round(max(reserved - data - index_or_unused, 0.0), 2)
    entry.reserved_space_gb = round(reserved / _MB_PER_GB, 2)
    entry.data_space_gb = round(data / _MB_PER_GB, 2)
    entry.index_space_gb = round(index_or_unused / _MB_PER_GB, 2)
