"""Command-line entry point for the Synapse Migration Analyzer."""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.logging import RichHandler

from . import __version__
from .config import load_config
from .doctor import render_report, run_checks
from .modules.dedicated_pools.analyzer import DedicatedPoolsAnalyzer
from .modules.fabric_mapping.analyzer import FabricMappingAnalyzer
from .modules.fabric_mapping.reporting import write_reports as write_fabric_reports
from .modules.monitoring.analyzer import MonitoringAnalyzer
from .modules.monitoring.reporting import write_reports as write_monitoring_reports
from .modules.pipelines.analyzer import PipelinesAnalyzer
from .modules.pipelines.reporting import write_reports as write_pipelines_reports
from .modules.serverless_pools.analyzer import ServerlessPoolsAnalyzer
from .modules.serverless_pools.reporting import write_reports as write_serverless_reports
from .modules.spark_pools.analyzer import SparkPoolsAnalyzer
from .modules.spark_pools.reporting import write_reports as write_spark_reports
from .modules.storage.analyzer import StorageAnalyzer
from .modules.storage.reporting import write_reports as write_storage_reports
from .reporting import write_reports as write_dedicated_reports
from .reporting.index_report import write_index

console = Console()
log = logging.getLogger("sma")

_ALL_FORMATS = ("json", "csv", "markdown", "html")
_FLAT_FORMATS = ("json", "csv", "markdown")  # back-compat alias; all modules now also support html

# Deterministic exit codes for CI consumers.
EXIT_OK = 0
EXIT_CONFIG_ERROR = 1
EXIT_PARTIAL_FAILURES = 2
EXIT_DOCTOR_FAILED = 3

_SKIPPABLE = ("dedicated_pools", "serverless_pools", "spark_pools", "pipelines", "monitoring", "storage", "fabric_mapping")


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "name": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def _configure_logging(verbose: bool, log_format: str) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    if log_format == "json":
        handler: logging.Handler = logging.StreamHandler(stream=sys.stderr)
        handler.setFormatter(_JsonFormatter())
    else:
        handler = RichHandler(console=console, rich_tracebacks=True, show_path=False)
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level)
    root.addHandler(handler)


@click.group()
@click.version_option(__version__, prog_name="sma")
@click.option("-v", "--verbose", is_flag=True, help="Verbose (DEBUG) logging.")
@click.option("--env-file", type=click.Path(dir_okay=False, path_type=Path), default=None,
              help="Optional path to a .env file (defaults to ./.env).")
@click.option("--log-format", type=click.Choice(["rich", "json"]), default="rich",
              help="Logging output style. 'json' emits JSONL on stderr (good for CI).")
@click.pass_context
def cli(ctx: click.Context, verbose: bool, env_file: Path | None, log_format: str) -> None:
    """Synapse Migration Analyzer."""
    _configure_logging(verbose, log_format)
    ctx.ensure_object(dict)
    # Skip config loading when the user is just asking for help — `sma <cmd> --help`
    # should work without a populated .env so newcomers can discover commands.
    if any(arg in ("--help", "-h") for arg in sys.argv[1:]):
        ctx.obj["config"] = None
        return
    # `sma doctor` runs without a populated config — it *checks* the config.
    if len(sys.argv) >= 2 and sys.argv[1] == "doctor":
        ctx.obj["config"] = None
        return
    try:
        ctx.obj["config"] = load_config(env_file)
    except Exception as exc:  # noqa: BLE001 - top-level CLI safety
        log.error("Configuration error: %s", exc)
        sys.exit(EXIT_CONFIG_ERROR)


@cli.command("doctor")
@click.option("--offline", is_flag=True, default=False,
              help="Skip live Azure calls (token + workspace probe).")
@click.pass_context
def doctor(ctx: click.Context, offline: bool) -> None:
    """Run a self-test: verify Python, packages, ODBC, .env, and (optionally) Azure auth."""
    report = run_checks(offline=offline)
    render_report(report, console)
    if not report.ok:
        sys.exit(EXIT_DOCTOR_FAILED)


@cli.command("analyze-dedicated-pools")
@click.option("--formats", "-f", multiple=True,
              type=click.Choice(["json", "csv", "markdown", "html"], case_sensitive=False),
              default=_ALL_FORMATS,
              help="Report formats to emit.")
@click.pass_context
def analyze_dedicated_pools(ctx: click.Context, formats: tuple[str, ...]) -> None:
    """Inventory and analyze dedicated SQL pools in the configured Synapse workspace."""
    cfg = ctx.obj["config"]
    result = DedicatedPoolsAnalyzer(cfg).run()
    paths = write_dedicated_reports(result, cfg.output_dir, formats=[f.lower() for f in formats])
    _print_paths(paths)


@cli.command("analyze-serverless-pools")
@click.option("--formats", "-f", multiple=True,
              type=click.Choice(["json", "csv", "markdown", "html"], case_sensitive=False),
              default=_ALL_FORMATS, help="Report formats to emit.")
@click.pass_context
def analyze_serverless_pools(ctx: click.Context, formats: tuple[str, ...]) -> None:
    """Inventory the workspace built-in serverless SQL endpoint."""
    cfg = ctx.obj["config"]
    result = ServerlessPoolsAnalyzer(cfg).run()
    paths = write_serverless_reports(result, cfg.output_dir, formats=[f.lower() for f in formats])
    _print_paths(paths)


@cli.command("analyze-spark-pools")
@click.option("--formats", "-f", multiple=True,
              type=click.Choice(["json", "csv", "markdown", "html"], case_sensitive=False),
              default=_ALL_FORMATS, help="Report formats to emit.")
@click.pass_context
def analyze_spark_pools(ctx: click.Context, formats: tuple[str, ...]) -> None:
    """Inventory Apache Spark pools in the workspace."""
    cfg = ctx.obj["config"]
    result = SparkPoolsAnalyzer(cfg).run()
    paths = write_spark_reports(result, cfg.output_dir, formats=[f.lower() for f in formats])
    _print_paths(paths)


@cli.command("analyze-pipelines")
@click.option("--formats", "-f", multiple=True,
              type=click.Choice(["json", "csv", "markdown", "html"], case_sensitive=False),
              default=_ALL_FORMATS, help="Report formats to emit.")
@click.option("--since", default=None, metavar="<N>d",
              help="Run-history window, e.g. '7d' or '90d'. Overrides SMA_PIPELINES_RUN_DAYS.")
@click.option("--no-run-history", is_flag=True, default=False,
              help="Skip the pipeline run-history fetch (counts / success rate / data moved).")
@click.pass_context
def analyze_pipelines(
    ctx: click.Context,
    formats: tuple[str, ...],
    since: str | None,
    no_run_history: bool,
) -> None:
    """Inventory pipelines, linked services, datasets, triggers, integration runtimes."""
    cfg = ctx.obj["config"]
    if since:
        token = since.strip().lower()
        days_str = token[:-1] if token.endswith("d") else token
        if not days_str.isdigit():
            raise click.BadParameter(f"Expected '<N>d' or '<N>', got {since!r}", param_hint="--since")
        os.environ["SMA_PIPELINES_RUN_DAYS"] = days_str
    if no_run_history:
        os.environ["SMA_PIPELINES_RUN_HISTORY"] = "0"
    result = PipelinesAnalyzer(cfg).run()
    paths = write_pipelines_reports(result, cfg.output_dir, formats=[f.lower() for f in formats])
    _print_paths(paths)


@cli.command("analyze-monitoring")
@click.option("--formats", "-f", multiple=True,
              type=click.Choice(["json", "csv", "markdown", "html"], case_sensitive=False),
              default=_ALL_FORMATS, help="Report formats to emit.")
@click.option("--since", default=None, metavar="<N>d",
              help="Time window, e.g. '7d' or '14d'. Overrides SMA_MONITORING_DAYS.")
@click.pass_context
def analyze_monitoring(ctx: click.Context, formats: tuple[str, ...], since: str | None) -> None:
    """Pull historical Azure Monitor metrics for dedicated SQL pools (DWU, queries, connections)."""
    cfg = ctx.obj["config"]
    if since:
        # Accept '7d' / '14d' / a bare integer.
        token = since.strip().lower()
        days_str = token[:-1] if token.endswith("d") else token
        if not days_str.isdigit():
            raise click.BadParameter(f"Expected '<N>d' or '<N>', got {since!r}", param_hint="--since")
        os.environ["SMA_MONITORING_DAYS"] = days_str
    result = MonitoringAnalyzer(cfg).run()
    paths = write_monitoring_reports(result, cfg.output_dir, formats=[f.lower() for f in formats])
    _print_paths(paths)
    if result.errors:
        sys.exit(EXIT_PARTIAL_FAILURES)


@cli.command("map-to-fabric")
@click.option("--formats", "-f", multiple=True,
              type=click.Choice(["json", "csv", "markdown", "html"], case_sensitive=False),
              default=_ALL_FORMATS, help="Report formats to emit.")
@click.pass_context
def map_to_fabric(ctx: click.Context, formats: tuple[str, ...]) -> None:
    """Aggregate prior module outputs and produce Fabric Warehouse migration recommendations."""
    cfg = ctx.obj["config"]
    result = FabricMappingAnalyzer(cfg).run()
    paths = write_fabric_reports(result, cfg.output_dir, formats=[f.lower() for f in formats])
    _print_paths(paths)


@cli.command("analyze-storage")
@click.option("--formats", "-f", multiple=True,
              type=click.Choice(["json", "csv", "markdown", "html"], case_sensitive=False),
              default=_ALL_FORMATS, help="Report formats to emit.")
@click.pass_context
def analyze_storage(ctx: click.Context, formats: tuple[str, ...]) -> None:
    """Inventory ADLS / storage accounts, sample capacity metrics, and size dedicated pools."""
    cfg = ctx.obj["config"]
    result = StorageAnalyzer(cfg).run()
    paths = write_storage_reports(result, cfg.output_dir, formats=[f.lower() for f in formats])
    _print_paths(paths)
    if result.errors:
        sys.exit(EXIT_PARTIAL_FAILURES)


@cli.command("analyze-all")
@click.option("--skip", "skip", multiple=True,
              type=click.Choice(_SKIPPABLE, case_sensitive=False),
              help="Skip a module (repeatable). Example: --skip monitoring --skip spark_pools")
@click.pass_context
def analyze_all(ctx: click.Context, skip: tuple[str, ...]) -> None:
    """Run every analyzer (dedicated, serverless, spark, pipelines, monitoring, storage) then map-to-fabric."""
    cfg = ctx.obj["config"]
    skipped = {s.lower() for s in skip}
    all_paths: list = []
    partial_failure = False

    def _step(label: str, key: str, work):
        nonlocal partial_failure
        if key in skipped:
            log.info("%s skipped", label)
            return
        log.info(label)
        try:
            all_paths.extend(work())
        except Exception as exc:  # noqa: BLE001
            log.warning("%s failed (continuing): %s", label, exc)
            partial_failure = True

    _step("[1/7] dedicated pools", "dedicated_pools", lambda: write_dedicated_reports(
        DedicatedPoolsAnalyzer(cfg).run(), cfg.output_dir, formats=list(_ALL_FORMATS)))
    _step("[2/7] serverless pools", "serverless_pools", lambda: write_serverless_reports(
        ServerlessPoolsAnalyzer(cfg).run(), cfg.output_dir, formats=list(_ALL_FORMATS)))
    _step("[3/7] spark pools", "spark_pools", lambda: write_spark_reports(
        SparkPoolsAnalyzer(cfg).run(), cfg.output_dir, formats=list(_ALL_FORMATS)))
    _step("[4/7] pipelines", "pipelines", lambda: write_pipelines_reports(
        PipelinesAnalyzer(cfg).run(), cfg.output_dir, formats=list(_ALL_FORMATS)))
    _step("[5/7] monitoring", "monitoring", lambda: write_monitoring_reports(
        MonitoringAnalyzer(cfg).run(), cfg.output_dir, formats=list(_ALL_FORMATS)))
    _step("[6/7] storage", "storage", lambda: write_storage_reports(
        StorageAnalyzer(cfg).run(), cfg.output_dir, formats=list(_ALL_FORMATS)))
    _step("[7/7] fabric mapping", "fabric_mapping", lambda: write_fabric_reports(
        FabricMappingAnalyzer(cfg).run(), cfg.output_dir, formats=list(_ALL_FORMATS)))

    # Always (re)build the index so users land on a single navigable page.
    try:
        all_paths.append(write_index(cfg.output_dir))
    except Exception as exc:  # noqa: BLE001
        log.warning("index.html build failed (continuing): %s", exc)
        partial_failure = True

    _print_paths(all_paths)
    if partial_failure:
        sys.exit(EXIT_PARTIAL_FAILURES)


def _print_paths(paths: list) -> None:
    console.rule("[bold green]Reports written")
    for p in paths:
        console.print(f" - {p}")


@cli.command("index")
@click.pass_context
def build_index(ctx: click.Context) -> None:
    """Build (or refresh) `index.html` in the output directory linking all module reports."""
    cfg = ctx.obj["config"]
    path = write_index(cfg.output_dir)
    _print_paths([path])


def main() -> None:
    try:
        cli(obj={})
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - top-level CLI safety
        log.exception("Fatal error: %s", exc)
        sys.exit(EXIT_CONFIG_ERROR)


if __name__ == "__main__":
    main()
