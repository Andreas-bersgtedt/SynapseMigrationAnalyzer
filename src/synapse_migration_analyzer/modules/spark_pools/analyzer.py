"""Orchestrator for the spark_pools module."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from ...config import AppConfig
from ...errors import format_error
from ...progress import NullProgress, ProgressReporter
from .arm_client import SparkArmClient
from .artifacts_client import SparkArtifactsClient
from . import notebook_lint, runtime_compat
from .models import (
    NotebookLintFinding,
    RuntimeMappingResult,
    SparkAnalysis,
)

log = logging.getLogger(__name__)


class SparkPoolsAnalyzer:
    def __init__(
        self,
        cfg: AppConfig,
        *,
        progress: ProgressReporter | None = None,
    ) -> None:
        self._cfg = cfg
        self._arm = SparkArmClient(cfg.azure)
        self._artifacts = SparkArtifactsClient(cfg.azure)
        self._progress = progress or NullProgress()

    def run(self) -> SparkAnalysis:
        result = SparkAnalysis(
            workspace_name=self._cfg.azure.workspace_name,
            subscription_id=self._cfg.azure.subscription_id,
            resource_group=self._cfg.azure.resource_group,
            generated_at=datetime.now(timezone.utc),
        )
        # 6 sub-tasks: list_pools, list_notebooks, list_sjd, runtime_compat,
        # notebook_lint, libraries.
        self._progress.start(6, label="enumerating Spark assets")
        try:
            result.pools = list(self._arm.list_pools())
        except Exception as exc:  # noqa: BLE001
            log.warning("Failed to list Spark pools: %s", exc)
            result.errors.append(format_error("list_pools", exc))
        self._progress.step(label="pools")

        try:
            result.notebooks = list(self._artifacts.list_notebooks())
        except Exception as exc:  # noqa: BLE001
            log.warning("Failed to list notebooks: %s", exc)
            result.errors.append(format_error("notebooks", exc))
        self._progress.step(label="notebooks")

        try:
            result.spark_job_definitions = list(self._artifacts.list_spark_job_definitions())
        except Exception as exc:  # noqa: BLE001
            log.warning("Failed to list Spark job definitions: %s", exc)
            result.errors.append(format_error("spark_job_definitions", exc))
        self._progress.step(label="spark_job_definitions")

        # v2 — runtime compatibility table per pool.
        try:
            for pool in result.pools:
                m = runtime_compat.map_runtime(pool.spark_version)
                result.runtime_mappings.append(RuntimeMappingResult(
                    pool_name=pool.name,
                    synapse_version=pool.spark_version,
                    fabric_runtime=m.fabric_runtime,
                    fabric_spark=m.fabric_spark,
                    status=m.status,
                    note=m.note,
                ))
        except Exception as exc:  # noqa: BLE001
            log.warning("runtime_compat failed: %s", exc)
            result.errors.append(f"runtime_compat: {exc}")
        self._progress.step(label="runtime_compat")

        # v2 — notebook lint. We use whatever source the artifacts client made available;
        # lint_notebooks tolerates missing source via the provider returning None.
        try:
            def _source_provider(nb_dict):
                # Notebook source is fetched lazily via the artifacts client — fail-soft.
                getter = getattr(self._artifacts, "fetch_notebook_source", None)
                if getter is None:
                    return None
                try:
                    return getter(nb_dict.get("name"))
                except Exception:  # noqa: BLE001
                    return None

            findings_by_nb = notebook_lint.lint_notebooks(
                [nb.model_dump() for nb in result.notebooks],
                _source_provider,
            )
            for nb_name, findings in findings_by_nb.items():
                for f in findings:
                    result.notebook_lint_findings.append(NotebookLintFinding(
                        notebook=nb_name,
                        rule_id=f.rule_id, label=f.label,
                        severity=f.severity, line=f.line, snippet=f.snippet,
                    ))
        except Exception as exc:  # noqa: BLE001
            log.warning("notebook_lint failed: %s", exc)
            result.errors.append(f"notebook_lint: {exc}")
        self._progress.step(label="notebook_lint")

        # v2 — workspace / pool library inventory. Stub: gracefully no-ops when the
        # artifacts SDK does not expose `list_workspace_packages` on this workspace.
        try:
            getter = getattr(self._artifacts, "list_workspace_packages", None)
            if callable(getter):
                result.libraries = list(getter())
        except Exception as exc:  # noqa: BLE001
            log.info("list_workspace_packages unavailable: %s", exc)
        self._progress.step(label="libraries")

        return result
