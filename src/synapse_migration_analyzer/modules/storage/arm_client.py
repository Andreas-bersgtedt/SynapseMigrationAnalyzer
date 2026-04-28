"""ARM client for storage-account discovery (and Synapse workspace default ADLS)."""
from __future__ import annotations

import logging
from typing import Iterator

from azure.mgmt.storage import StorageManagementClient
from azure.mgmt.synapse import SynapseManagementClient

from ...auth import get_credential
from ...config import AzureConfig
from .models import StorageAccountInventory

log = logging.getLogger(__name__)


class StorageArmClient:
    def __init__(self, azure: AzureConfig) -> None:
        self._azure = azure
        cred = get_credential(azure)
        self._storage = StorageManagementClient(cred, azure.subscription_id)
        self._synapse = SynapseManagementClient(cred, azure.subscription_id)

    # ------------------------------------------------------------------ workspace
    def workspace_default_storage(self) -> tuple[str | None, str | None]:
        """Return (account_name, default_filesystem) for the workspace's primary ADLS Gen2.

        Both values may be ``None`` if the workspace doesn't expose them.
        """
        rg = self._azure.resource_group
        ws = self._azure.workspace_name
        try:
            workspace = self._synapse.workspaces.get(rg, ws)
        except Exception as exc:  # noqa: BLE001
            log.warning("Cannot read workspace %s/%s: %s", rg, ws, exc)
            return None, None

        ddls = getattr(workspace, "default_data_lake_storage", None)
        if ddls is None:
            return None, None
        # `account_url` looks like `https://<acct>.dfs.core.windows.net`.
        account_url = getattr(ddls, "account_url", None) or ""
        account_name: str | None = None
        if account_url:
            account_name = account_url.replace("https://", "").split(".")[0] or None
        filesystem = getattr(ddls, "filesystem", None)
        return account_name, filesystem

    # ------------------------------------------------------------------ accounts
    def list_storage_accounts(self) -> Iterator[StorageAccountInventory]:
        """Yield every storage account discoverable for this credential.

        Service principals are commonly granted Reader on a single resource
        group rather than the whole subscription, in which case the
        subscription-wide ``list()`` call returns an empty page (sometimes
        without error). To stay useful we try in this order:

        1. Subscription-wide ``list()``.
        2. ``list_by_resource_group(workspace_rg)`` — the workspace's own RG.
        3. ``get_properties(default_rg, default_account)`` — the workspace's
           default ADLS Gen2, by parsing its ``id`` from the workspace.

        Duplicates (matched by lowercase resource id) are filtered out.
        """
        default_account, default_filesystem, default_rg = self._workspace_default_account_details()
        ws_rg = self._azure.resource_group

        seen: set[str] = set()

        def _emit(acct) -> StorageAccountInventory | None:
            rid = (getattr(acct, "id", None) or "").lower()
            if not rid or rid in seen:
                return None
            seen.add(rid)
            sku = getattr(acct, "sku", None)
            primary = getattr(acct, "primary_endpoints", None)
            return StorageAccountInventory(
                name=acct.name,
                resource_id=acct.id,
                location=getattr(acct, "location", None),
                sku=getattr(sku, "name", None),
                kind=getattr(acct, "kind", None),
                access_tier=getattr(acct, "access_tier", None),
                is_hns_enabled=getattr(acct, "is_hns_enabled", None),
                primary_endpoint_dfs=getattr(primary, "dfs", None),
                primary_endpoint_blob=getattr(primary, "blob", None),
                is_workspace_default=(default_account is not None and acct.name == default_account),
                default_filesystem=default_filesystem if (default_account == acct.name) else None,
                tags=getattr(acct, "tags", None) or {},
            )

        # 1) Subscription-wide.
        sub_count = 0
        try:
            for acct in self._storage.storage_accounts.list():
                inv = _emit(acct)
                if inv is not None:
                    sub_count += 1
                    yield inv
            log.info("storage_accounts.list() returned %d account(s) at subscription scope", sub_count)
        except Exception as exc:  # noqa: BLE001
            log.warning("Subscription-wide storage list failed (%s); falling back to RG scope", exc)

        # 2) Workspace's resource group.
        if ws_rg:
            try:
                rg_count = 0
                for acct in self._storage.storage_accounts.list_by_resource_group(ws_rg):
                    inv = _emit(acct)
                    if inv is not None:
                        rg_count += 1
                        yield inv
                log.info("list_by_resource_group(%s) returned %d additional account(s)", ws_rg, rg_count)
            except Exception as exc:  # noqa: BLE001
                log.warning("list_by_resource_group(%s) failed: %s", ws_rg, exc)

        # 3) Workspace's default ADLS Gen2 (might be in a third RG/subscription).
        if default_account and default_rg:
            try:
                acct = self._storage.storage_accounts.get_properties(default_rg, default_account)
                inv = _emit(acct)
                if inv is not None:
                    log.info("Picked up workspace default storage %s/%s via get_properties",
                             default_rg, default_account)
                    yield inv
            except Exception as exc:  # noqa: BLE001
                log.warning("get_properties(%s, %s) failed: %s", default_rg, default_account, exc)

        if not seen:
            log.warning(
                "No storage accounts discovered for subscription %s. "
                "The credential likely lacks Microsoft.Storage/storageAccounts/read at subscription "
                "or resource-group scope. Grant Reader on the subscription (or at least on the "
                "workspace RG and the default ADLS RG) and retry.",
                self._azure.subscription_id,
            )

    # ------------------------------------------------------------------ helpers
    def _workspace_default_account_details(self) -> tuple[str | None, str | None, str | None]:
        """Return (account_name, filesystem, resource_group) for the workspace default ADLS Gen2."""
        rg = self._azure.resource_group
        ws = self._azure.workspace_name
        try:
            workspace = self._synapse.workspaces.get(rg, ws)
        except Exception as exc:  # noqa: BLE001
            log.warning("Cannot read workspace %s/%s: %s", rg, ws, exc)
            return None, None, None

        ddls = getattr(workspace, "default_data_lake_storage", None)
        if ddls is None:
            return None, None, None
        account_url = getattr(ddls, "account_url", None) or ""
        account_name: str | None = None
        if account_url:
            account_name = account_url.replace("https://", "").split(".")[0] or None
        filesystem = getattr(ddls, "filesystem", None)

        # The Synapse SDK exposes `resource_id` on newer versions; fall back to None.
        rid = getattr(ddls, "resource_id", None)
        default_rg: str | None = None
        if rid:
            # /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<name>
            parts = [p for p in str(rid).split("/") if p]
            try:
                default_rg = parts[parts.index("resourceGroups") + 1]
            except (ValueError, IndexError):
                default_rg = None
        return account_name, filesystem, default_rg
