"""Pure-Python rules engine for the cost module.

Operates over a populated :class:`CostAnalysis` and emits severity-tagged
findings. No live calls — entirely deterministic and unit-testable.
"""
from __future__ import annotations

from .models import CostAnalysis, CostFinding


# Thresholds (kept module-level so tests can override via monkeypatch).
SAVINGS_PCT = 0.10  # |delta_pct| >= 10% → meaningful delta
SPIKE_PCT = 0.25    # month-over-month >= +25% → spike
DOMINANT_KIND_PCT = 0.70  # one resource_kind > 70% of total → concentration risk


def evaluate(result: CostAnalysis) -> list[CostFinding]:
    findings: list[CostFinding] = []
    findings.extend(_no_data_finding(result))
    findings.extend(_fabric_findings(result))
    findings.extend(_concentration_findings(result))
    findings.extend(_month_over_month_findings(result))
    return findings


def _no_data_finding(result: CostAnalysis) -> list[CostFinding]:
    if result.rows:
        return []
    status = getattr(result, "collection_status", "ok")
    if status == "sdk_missing":
        return [CostFinding(
            rule_id="cost.sdk_missing",
            severity="medium",
            title="azure-mgmt-costmanagement is not installed",
            detail=("The optional Cost Management SDK is not importable, so no "
                    "live cost data could be collected. Install it with "
                    "`pip install azure-mgmt-costmanagement` and re-run "
                    "`sma analyze-cost`."),
        )]
    if status == "live_disabled":
        return [CostFinding(
            rule_id="cost.live_disabled",
            severity="info",
            title="Live cost queries are disabled (SMA_COST_DISABLE_LIVE)",
            detail=("The SMA_COST_DISABLE_LIVE environment variable is set, so "
                    "the cost collector returned no rows by design. Unset it "
                    "to enable live Cost Management queries."),
        )]
    if status == "error":
        return [CostFinding(
            rule_id="cost.collection_error",
            severity="medium",
            title="Cost Management query failed",
            detail=("The Cost Management API call raised an exception. See the "
                    "errors[] list on this report for the underlying message — "
                    "common causes are missing Cost Management Reader on the "
                    "resource group or an invalid scope."),
        )]
    # status == "empty_window" or "ok" with no rows
    return [CostFinding(
        rule_id="cost.no_data",
        severity="info",
        title="No cost rows captured",
        detail=("Cost Management returned no rows for the configured window. "
                "Verify Cost Management Reader on the resource group, that the "
                "azure-mgmt-costmanagement extra is installed, and that "
                "SMA_COST_DISABLE_LIVE is not set. Try widening the window "
                "with SMA_COST_MONTHS=6."),
    )]


def _fabric_findings(result: CostAnalysis) -> list[CostFinding]:
    fc = result.fabric_comparison
    if fc is None or fc.delta_pct is None or fc.fabric_estimated_monthly_cost is None:
        return []
    if fc.delta_pct <= -SAVINGS_PCT:
        # Fabric is cheaper.
        return [CostFinding(
            rule_id="cost.fabric.savings",
            severity="info",
            title=f"Fabric SKU {fc.fabric_capacity_sku} projects ~{fc.delta_pct:+.0%} vs Synapse",
            detail=(f"Synapse avg monthly cost {fc.synapse_avg_monthly_cost:,.0f}; "
                    f"Fabric estimated {fc.fabric_estimated_monthly_cost:,.0f} "
                    f"(delta {fc.delta_abs:+,.0f})."),
        )]
    if fc.delta_pct >= SAVINGS_PCT:
        return [CostFinding(
            rule_id="cost.fabric.increase",
            severity="medium",
            title=f"Fabric SKU {fc.fabric_capacity_sku} projects ~{fc.delta_pct:+.0%} vs Synapse",
            detail=(f"Synapse avg monthly cost {fc.synapse_avg_monthly_cost:,.0f}; "
                    f"Fabric estimated {fc.fabric_estimated_monthly_cost:,.0f} "
                    f"(delta {fc.delta_abs:+,.0f}). Review CU sizing recommendation "
                    "or evaluate reservation pricing."),
        )]
    return []


def _concentration_findings(result: CostAnalysis) -> list[CostFinding]:
    total = sum(result.by_resource_kind.values())
    if total <= 0:
        return []
    findings: list[CostFinding] = []
    for kind, cost in result.by_resource_kind.items():
        share = cost / total
        if share >= DOMINANT_KIND_PCT and kind in {"dedicated_pool", "spark_pool"}:
            findings.append(CostFinding(
                rule_id=f"cost.concentration.{kind}",
                severity="info",
                title=f"{kind} accounts for {share:.0%} of workspace spend",
                detail=(f"Resource kind '{kind}' contributes {cost:,.0f} of "
                        f"{total:,.0f} total. Pause / scale-down policies can move "
                        "the needle materially."),
            ))
    return findings


def _month_over_month_findings(result: CostAnalysis) -> list[CostFinding]:
    months = sorted(result.monthly_totals)
    if len(months) < 2:
        return []
    findings: list[CostFinding] = []
    for prev, curr in zip(months, months[1:], strict=False):
        prev_cost = result.monthly_totals[prev]
        curr_cost = result.monthly_totals[curr]
        if prev_cost <= 0:
            continue
        pct = (curr_cost - prev_cost) / prev_cost
        if pct >= SPIKE_PCT:
            findings.append(CostFinding(
                rule_id="cost.month_over_month.spike",
                severity="medium",
                title=f"Month-over-month spike {pct:+.0%} ({prev} → {curr})",
                detail=(f"Spend rose from {prev_cost:,.0f} to {curr_cost:,.0f}. "
                        "Investigate the dominant resource kind for that month."),
            ))
    return findings
