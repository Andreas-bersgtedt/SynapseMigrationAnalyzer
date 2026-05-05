"""Pluggable analysis modules.

This package exposes a central :data:`MODULE_REGISTRY` that maps each
analyzer module name to a callable returning ``(result, write_reports)``.
Both the CLI (``cli.analyze_all``) and the web :mod:`~.web.jobs` runner
should consume this registry instead of duplicating dispatch logic.

Analyzer + reporting code is imported lazily inside each factory so that
``import synapse_migration_analyzer.modules`` stays cheap (no Azure SDK
load just to enumerate module names).
"""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import AppConfig

ModuleFactory = Callable[[AppConfig], tuple[Any, Callable[..., list[Path]]]]


def _dedicated(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .dedicated_pools.analyzer import DedicatedPoolsAnalyzer
    from ..reporting import write_reports

    return DedicatedPoolsAnalyzer(cfg).run(), write_reports


def _serverless(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .serverless_pools.analyzer import ServerlessPoolsAnalyzer
    from .serverless_pools.reporting import write_reports

    return ServerlessPoolsAnalyzer(cfg).run(), write_reports


def _spark(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .spark_pools.analyzer import SparkPoolsAnalyzer
    from .spark_pools.reporting import write_reports

    return SparkPoolsAnalyzer(cfg).run(), write_reports


def _pipelines(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .pipelines.analyzer import PipelinesAnalyzer
    from .pipelines.reporting import write_reports

    return PipelinesAnalyzer(cfg).run(), write_reports


def _monitoring(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .monitoring.analyzer import MonitoringAnalyzer
    from .monitoring.reporting import write_reports

    return MonitoringAnalyzer(cfg).run(), write_reports


def _storage(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .storage.analyzer import StorageAnalyzer
    from .storage.reporting import write_reports

    return StorageAnalyzer(cfg).run(), write_reports


def _fabric_mapping(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .fabric_mapping.analyzer import FabricMappingAnalyzer
    from .fabric_mapping.reporting import write_reports

    return FabricMappingAnalyzer(cfg).run(), write_reports


def _governance(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .governance.analyzer import GovernanceAnalyzer
    from .governance.reporting import write_reports

    return GovernanceAnalyzer(cfg).run(), write_reports


def _security(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .security.analyzer import SecurityAnalyzer
    from .security.reporting import write_reports

    return SecurityAnalyzer(cfg).run(), write_reports


def _cost(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .cost.analyzer import CostAnalyzer
    from .cost.reporting import write_reports

    return CostAnalyzer(cfg).run(), write_reports


def _fabric_validation(cfg: AppConfig) -> tuple[Any, Callable[..., list[Path]]]:
    from .fabric_validation.analyzer import FabricValidationAnalyzer
    from .fabric_validation.reporting import write_reports

    return FabricValidationAnalyzer(cfg).run(), write_reports


# Order matters: ``fabric_mapping`` consumes JSON outputs from earlier
# modules, so it must run after them in any "all modules" execution.
MODULE_REGISTRY: dict[str, ModuleFactory] = {
    "dedicated_pools": _dedicated,
    "serverless_pools": _serverless,
    "spark_pools": _spark,
    "pipelines": _pipelines,
    "monitoring": _monitoring,
    "storage": _storage,
    "governance": _governance,
    "security": _security,
    "cost": _cost,
    "fabric_validation": _fabric_validation,
    "fabric_mapping": _fabric_mapping,
}

# Tuple form used by the web layer for canonical-order sorting.
KNOWN_MODULES: tuple[str, ...] = tuple(MODULE_REGISTRY)

__all__ = ["MODULE_REGISTRY", "KNOWN_MODULES", "ModuleFactory"]
