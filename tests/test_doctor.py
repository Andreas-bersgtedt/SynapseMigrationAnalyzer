"""Tests for the `sma doctor` self-check."""
from __future__ import annotations

import os
from unittest.mock import patch

from synapse_migration_analyzer import doctor


def test_run_checks_offline_returns_results() -> None:
    """Offline run never raises and returns one result per check."""
    report = doctor.run_checks(offline=True)
    names = [r.name for r in report.results]
    # Core categories present
    assert "Python >= 3.12" in names
    assert "ODBC driver" in names
    assert "Azure CLI (az)" in names
    assert "Required env vars" in names
    assert "Output dir writable" in names
    # Live checks should be SKIP when --offline is set
    live = [r for r in report.results if r.name in (
        "AAD token (ARM)", "Synapse workspace reachable", "SQL access token")]
    assert all(r.status == "skip" for r in live)


def test_run_checks_with_no_env_marks_required_vars_as_fail(monkeypatch) -> None:
    for k in (
        "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET",
        "AZURE_SUBSCRIPTION_ID", "SYNAPSE_RESOURCE_GROUP", "SYNAPSE_WORKSPACE_NAME",
    ):
        monkeypatch.delenv(k, raising=False)
    # Pretend there is no .env on disk by running from tmp cwd
    monkeypatch.chdir(os.environ.get("TEMP") or "/tmp")
    report = doctor.run_checks(offline=True)
    env_check = next(r for r in report.results if r.name == "Required env vars")
    assert env_check.status == "fail"
    assert "Missing" in env_check.detail


def test_run_checks_packages_all_pass() -> None:
    """Every documented dependency must be importable in the dev environment."""
    report = doctor.run_checks(offline=True)
    pkg_results = [r for r in report.results if r.name.startswith("import ")]
    assert pkg_results, "expected per-package import checks"
    failed = [r for r in pkg_results if r.status == "fail"]
    assert not failed, f"missing packages: {[r.name for r in failed]}"


def test_render_report_smoke(capsys) -> None:
    """render_report should not raise and should emit something to the console."""
    from rich.console import Console

    report = doctor.run_checks(offline=True)
    console = Console(record=True, width=120)
    doctor.render_report(report, console)
    text = console.export_text()
    assert "sma doctor" in text
    assert "PASS" in text or "FAIL" in text or "SKIP" in text
