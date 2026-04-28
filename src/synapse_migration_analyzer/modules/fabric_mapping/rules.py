"""Heuristic rules that translate Synapse findings into Fabric Warehouse actions.

Each rule reads a portion of the loaded module JSONs and yields Recommendation
objects. Keep rules small, named, and side-effect-free.
"""
from __future__ import annotations

from typing import Any

from . import tsql_surface
from .models import Recommendation

# Fabric Warehouse default collation. Anything else triggers a recommendation.
FABRIC_DEFAULT_COLLATION = "Latin1_General_100_BIN2_UTF8"


def rules_for_dedicated_pools(payload: dict[str, Any]) -> list[Recommendation]:
    out: list[Recommendation] = []
    for pool in payload.get("pools", []):
        inv = pool.get("inventory", {}) or {}
        pool_name = inv.get("name", "?")

        # Paused pools
        if (inv.get("status") or "").lower() == "paused":
            out.append(Recommendation(
                id=f"dp.paused.{pool_name}",
                area="dedicated_pools.inventory",
                title=f"Pool '{pool_name}' is paused",
                severity="warning",
                effort="low",
                target=pool_name,
                detail="DMV-driven analysis was skipped because the pool is paused.",
                fabric_action="Resume the pool and re-run `sma analyze-dedicated-pools` for full analysis.",
            ))

        # Collation mismatch
        coll = (inv.get("collation") or "").strip()
        if coll and coll.lower() != FABRIC_DEFAULT_COLLATION.lower():
            out.append(Recommendation(
                id=f"dp.collation.{pool_name}",
                area="dedicated_pools.inventory",
                title=f"Non-default collation '{coll}' on pool '{pool_name}'",
                severity="warning",
                effort="medium",
                target=pool_name,
                detail=f"Fabric Warehouse default is `{FABRIC_DEFAULT_COLLATION}`. "
                       "Migrating data with mismatched collation can introduce sort/comparison "
                       "differences and may require COLLATE clauses on JOINs / WHEREs.",
                fabric_action="Plan column-level COLLATE conversions or pick a Fabric Warehouse with a matching collation.",
            ))

        # Tables: heuristics
        for t in pool.get("tables", []):
            tname = f"{pool_name}.{t.get('schema_name')}.{t.get('table_name')}"
            dist = (t.get("distribution_policy") or "").upper()
            rows = t.get("row_count")
            idx = (t.get("index_type") or "").upper()

            if dist == "REPLICATE" and rows and rows > 50_000_000:
                out.append(Recommendation(
                    id=f"dp.replicate_large.{tname}",
                    area="dedicated_pools.tables",
                    title="REPLICATE distribution on a large table",
                    severity="warning",
                    effort="medium",
                    target=tname,
                    detail=f"Table is REPLICATE with ~{rows:,} rows; replicated tables in Fabric "
                           "Warehouse should stay small (rule of thumb < 100M rows / < 2 GB).",
                    fabric_action="Re-evaluate as ROUND_ROBIN or HASH-distributed in Fabric Warehouse.",
                ))

            if dist == "ROUND_ROBIN" and rows and rows > 100_000_000:
                out.append(Recommendation(
                    id=f"dp.rr_large.{tname}",
                    area="dedicated_pools.tables",
                    title="Large ROUND_ROBIN table",
                    severity="info",
                    effort="medium",
                    target=tname,
                    detail=f"~{rows:,} rows on ROUND_ROBIN may benefit from a hash key in Fabric.",
                    fabric_action="Pick a high-cardinality, frequently-joined column as the hash key.",
                ))

            if idx == "HEAP" and rows and rows > 1_000_000:
                out.append(Recommendation(
                    id=f"dp.heap_large.{tname}",
                    area="dedicated_pools.tables",
                    title="Large heap table",
                    severity="info",
                    effort="low",
                    target=tname,
                    detail="Heaps are inefficient for analytical workloads.",
                    fabric_action="Migrate to clustered columnstore (default in Fabric Warehouse).",
                ))

        # Workload management settings have no direct equivalent in Fabric.
        if pool.get("workload_groups"):
            out.append(Recommendation(
                id=f"dp.wlm.{pool_name}",
                area="dedicated_pools.workload_management",
                title=f"Workload groups defined on '{pool_name}'",
                severity="info",
                effort="medium",
                target=pool_name,
                detail=f"{len(pool['workload_groups'])} workload group(s) configured; "
                       "Fabric uses capacity-level resource governance instead.",
                fabric_action="Map importance/quota intent to Fabric capacity sizing and workspace assignment.",
            ))

        # T-SQL surface scan over stored procedures / views / functions.
        out.extend(_tsql_recommendations(pool_name, pool.get("code_objects") or []))

        # v2 — column collations differing from database default.
        diff_colls = [c for c in (pool.get("column_collations") or []) if c.get("differs_from_db")]
        if diff_colls:
            out.append(Recommendation(
                id=f"dp.col_collation.{pool_name}",
                area="dedicated_pools.column_collations",
                title=f"{len(diff_colls)} column(s) with non-default collation on '{pool_name}'",
                severity="warning",
                effort="medium",
                target=pool_name,
                detail="Column-level collations differ from the database default; cross-collation joins"
                       " require explicit COLLATE clauses in Fabric Warehouse.",
                fabric_action="Standardize on the Fabric default collation or stamp explicit COLLATE on JOIN/WHERE.",
            ))

        # v2 — materialized views (Fabric Warehouse has no MV).
        mvs = pool.get("materialized_views") or []
        if mvs:
            out.append(Recommendation(
                id=f"dp.mvs.{pool_name}",
                area="dedicated_pools.materialized_views",
                title=f"{len(mvs)} materialized view(s) on '{pool_name}'",
                severity="warning",
                effort="high",
                target=pool_name,
                detail="Fabric Warehouse does not yet support materialized views; alternatives include"
                       " Lakehouse + scheduled notebook refresh, or a regular table refreshed via pipeline.",
                fabric_action="Recreate as Lakehouse Delta tables refreshed by a scheduled Fabric pipeline / notebook.",
            ))

        # v2 — stale statistics.
        stats_stale = [s for s in (pool.get("statistics") or []) if (s.get("days_since_update") or 0) > 14]
        if stats_stale:
            out.append(Recommendation(
                id=f"dp.stats_stale.{pool_name}",
                area="dedicated_pools.statistics",
                title=f"{len(stats_stale)} stale statistic(s) on '{pool_name}'",
                severity="info",
                effort="low",
                target=pool_name,
                detail="Statistics older than 14 days observed; update before snapshotting workloads for migration validation.",
                fabric_action="Run UPDATE STATISTICS on the affected objects in Synapse before the cut-over snapshot.",
            ))

        # v2 — distribution candidates (advisor output).
        cands = pool.get("distribution_candidates") or []
        if cands:
            top = cands[:5]
            sample = ", ".join(
                f"{c.get('schema_name')}.{c.get('table_name')}→{c.get('column_name')}"
                for c in top
            )
            out.append(Recommendation(
                id=f"dp.dist_advice.{pool_name}",
                area="dedicated_pools.distribution_advisor",
                title=f"Distribution-key candidates suggested for '{pool_name}'",
                severity="info",
                effort="medium",
                target=pool_name,
                detail=f"Top candidates (heuristic): {sample}",
                fabric_action="Review the candidates against query patterns; pick a high-cardinality, frequently-joined column.",
            ))

    return out


def _tsql_recommendations(pool_name: str, code_objects: list[dict[str, Any]]) -> list[Recommendation]:
    """Aggregate T-SQL findings into one recommendation per matched rule."""
    if not code_objects:
        return []

    pairs: list[tuple[str, list[tsql_surface.TsqlFinding]]] = []
    for obj in code_objects:
        # Prefer the stable code_object_id (deterministic across runs); fall back to the
        # qualified name for older payloads that predate the v2 schema.
        cid = obj.get("code_object_id") or (
            f"{obj.get('schema_name')}.{obj.get('object_name')}.{obj.get('object_type')}"
        )
        pairs.append((cid, tsql_surface.scan(obj.get("definition") or "")))

    grouped = tsql_surface.aggregate_by_rule(pairs)
    out: list[Recommendation] = []
    for rule_id, hits in grouped.items():
        # Severity is fixed per rule in tsql_surface._PATTERNS; pull it from the first finding.
        severity = "info"
        label = rule_id
        for _, findings in pairs:
            for f in findings:
                if f.rule_id == rule_id:
                    severity = f.severity
                    label = f.label
                    break
            if severity != "info":
                break
        sample = ", ".join(t for t, _ in hits[:5])
        more = "" if len(hits) <= 5 else f" (+{len(hits) - 5} more)"
        all_ids = sorted({t for t, _ in hits})
        out.append(Recommendation(
            id=f"dp.tsql.{rule_id}.{pool_name}",
            area="dedicated_pools.tsql_surface",
            title=f"T-SQL surface: {label} ({len(hits)} object(s))",
            severity=severity,  # type: ignore[arg-type]
            effort="medium",
            target=pool_name,
            detail=f"Detected `{label}` in: {sample}{more}. "
                   f"Stable code_object_ids: {', '.join(all_ids[:10])}"
                   f"{'' if len(all_ids) <= 10 else f' (+{len(all_ids) - 10} more)'}.",
            fabric_action=tsql_surface.fabric_action_for(rule_id),
        ))
    return out


def rules_for_serverless(payload: dict[str, Any]) -> list[Recommendation]:
    out: list[Recommendation] = []
    ext_tables = payload.get("external_tables") or []
    if ext_tables:
        out.append(Recommendation(
            id="sl.external_tables",
            area="serverless_pools.external_tables",
            title=f"{len(ext_tables)} external table(s) in serverless",
            severity="info",
            effort="medium",
            detail="Serverless external tables become Fabric shortcuts or OneLake-backed tables.",
            fabric_action="Recreate as OneLake shortcuts or COPY INTO Fabric Warehouse tables.",
        ))

    cost = payload.get("cost_estimate") or {}
    if cost and cost.get("estimated_cost_usd") is not None:
        out.append(Recommendation(
            id="sl.cost_baseline",
            area="serverless_pools.cost",
            title=f"Serverless data-processed baseline ~ {cost.get('total_data_processed_tb')} TB / "
                  f"USD {cost.get('estimated_cost_usd')} (last 30 d)",
            severity="info",
            effort="low",
            detail="Use this as a baseline when sizing Fabric capacity (Fabric is capacity-priced, not per-TB).",
            fabric_action="Translate observed TB processed into expected Fabric capacity SKU/sizing.",
        ))

    top = payload.get("top_queries") or []
    if top:
        biggest = top[0]
        out.append(Recommendation(
            id="sl.top_query",
            area="serverless_pools.queries",
            title=f"Most expensive serverless query: {biggest.get('data_processed_mb')} MB scanned",
            severity="info",
            effort="medium",
            detail=f"Top query (request_id={biggest.get('request_id')}) scanned "
                   f"{biggest.get('data_processed_mb')} MB; review for partition pruning / filtered shortcuts.",
            fabric_action="Add columnar shortcuts and verify partition predicates on the most expensive queries.",
        ))

    # v2 — per-storage-account attribution.
    sau = payload.get("storage_account_usage") or []
    if sau:
        head = sau[:3]
        sample = ", ".join(f"{a.get('storage_account')} ({a.get('data_processed_mb')} MB)" for a in head)
        out.append(Recommendation(
            id="sl.storage_attribution",
            area="serverless_pools.storage_attribution",
            title=f"Top storage account(s) by serverless scan: {sample}",
            severity="info",
            effort="low",
            detail="Storage attribution helps prioritize which datasets to migrate to OneLake first.",
            fabric_action="Migrate the heaviest accounts first via OneLake shortcuts, then optionally COPY INTO Fabric Warehouse.",
        ))

    # v2 — external table column projections.
    cols = payload.get("external_table_columns") or []
    if cols:
        out.append(Recommendation(
            id="sl.external_columns",
            area="serverless_pools.external_table_columns",
            title=f"{len(cols)} external-table column projection(s) captured",
            severity="info",
            effort="low",
            detail="Column projections inform Fabric Lakehouse / Warehouse schema design.",
            fabric_action="Use the captured projections to scaffold Fabric Lakehouse Delta schemas.",
        ))
    return out


def rules_for_spark(payload: dict[str, Any]) -> list[Recommendation]:
    out: list[Recommendation] = []
    pools = payload.get("pools") or []
    if pools:
        out.append(Recommendation(
            id="sp.spark_inventory",
            area="spark_pools",
            title=f"{len(pools)} Spark pool(s) detected",
            severity="info",
            effort="medium",
            detail="Synapse Spark pools migrate to Fabric Spark (Data Engineering / Data Science).",
            fabric_action="Map node sizes to Fabric Spark pool defaults; review notebooks for unsupported APIs.",
        ))

    notebooks = payload.get("notebooks") or []
    if notebooks:
        out.append(Recommendation(
            id="sp.notebooks",
            area="spark_pools.notebooks",
            title=f"{len(notebooks)} Synapse notebook(s) to migrate",
            severity="info",
            effort="high",
            detail="Notebooks need import + smoke-test in Fabric Notebooks; review %%-magics and mssparkutils calls.",
            fabric_action="Use the Fabric notebook import; replace `mssparkutils` with `notebookutils`.",
        ))

    sjds = payload.get("spark_job_definitions") or []
    if sjds:
        out.append(Recommendation(
            id="sp.spark_job_defs",
            area="spark_pools.spark_job_definitions",
            title=f"{len(sjds)} Spark job definition(s) to recreate",
            severity="warning",
            effort="medium",
            detail="Synapse Spark job definitions migrate to Fabric Spark job definitions but config keys may differ.",
            fabric_action="Recreate job definitions in Fabric; re-validate JAR / Python file paths and Spark conf.",
        ))

    # v2 — notebook lint findings.
    findings = payload.get("notebook_lint_findings") or []
    if findings:
        by_rule: dict[str, list[str]] = {}
        sev_by_rule: dict[str, str] = {}
        for f in findings:
            by_rule.setdefault(f.get("rule_id", "?"), []).append(f.get("notebook", "?"))
            sev_by_rule.setdefault(f.get("rule_id", "?"), f.get("severity", "info"))
        for rule_id, hits in by_rule.items():
            sev = sev_by_rule.get(rule_id, "info")
            sample = ", ".join(sorted(set(hits))[:5])
            out.append(Recommendation(
                id=f"sp.lint.{rule_id}",
                area="spark_pools.notebooks.lint",
                title=f"Notebook lint: {rule_id} ({len(hits)} hit(s))",
                severity=sev,  # type: ignore[arg-type]
                effort="medium",
                detail=f"Found in: {sample}",
                fabric_action="Refactor to Fabric notebookutils equivalents and remove Synapse-only magics.",
            ))

    # v2 — runtime upgrade hints.
    runtimes = payload.get("runtime_mappings") or []
    needs_upgrade = [r for r in runtimes if (r.get("status") or "") in ("upgrade", "deprecated")]
    if needs_upgrade:
        sample = ", ".join(f"{r.get('pool_name')} ({r.get('synapse_version')})" for r in needs_upgrade[:5])
        out.append(Recommendation(
            id="sp.runtime_upgrade",
            area="spark_pools.runtime_compat",
            title=f"{len(needs_upgrade)} pool(s) need a Fabric runtime upgrade",
            severity="warning",
            effort="medium",
            detail=f"Pools requiring upgrade: {sample}",
            fabric_action="Pin notebooks to a supported Fabric Spark runtime and validate library compatibility.",
        ))
    return out


def rules_for_pipelines(payload: dict[str, Any]) -> list[Recommendation]:
    out: list[Recommendation] = []
    pipelines = payload.get("pipelines") or []
    activities = payload.get("activities") or []
    linked = payload.get("linked_services") or []

    if pipelines:
        out.append(Recommendation(
            id="pl.pipelines_inventory",
            area="pipelines",
            title=f"{len(pipelines)} Synapse pipeline(s) to migrate",
            severity="info",
            effort="high",
            detail="Synapse pipelines migrate to Fabric Data Factory (Data pipelines).",
            fabric_action="Use the Fabric pipeline import tooling; review unsupported activities and linked services.",
        ))

    # Activity-level Fabric-unsupported detection.
    unsupported = [a for a in activities if (a.get("support") == "unsupported")]
    if unsupported:
        per_type: dict[str, list[str]] = {}
        for a in unsupported:
            per_type.setdefault(a["type"], []).append(f"{a['pipeline']}::{a['name']}")
        for atype, hits in per_type.items():
            sample = ", ".join(hits[:5])
            more = "" if len(hits) <= 5 else f" (+{len(hits) - 5} more)"
            out.append(Recommendation(
                id=f"pl.unsupported.{atype}",
                area="pipelines.activities",
                title=f"Fabric-unsupported activity: {atype} ({len(hits)} occurrence(s))",
                severity="warning",
                effort="high",
                target=atype,
                detail=f"Found in: {sample}{more}.",
                fabric_action=_action_for_activity(atype),
            ))

    partial = [a for a in activities if (a.get("support") == "partial")]
    if partial:
        out.append(Recommendation(
            id="pl.partial_activities",
            area="pipelines.activities",
            title=f"{len(partial)} partially-supported activity occurrence(s)",
            severity="info",
            effort="medium",
            detail="These activities exist in Fabric but configuration / auth options differ.",
            fabric_action="Re-validate parameters, authentication, and runtime behavior after import.",
        ))

    # Linked service compatibility.
    unsupported_ls = [ls for ls in linked if ls.get("fabric_supported") is False]
    if unsupported_ls:
        per_type = {}
        for ls in unsupported_ls:
            per_type.setdefault(ls.get("type", "?"), []).append(ls.get("name", "?"))
        for ls_type, hits in per_type.items():
            out.append(Recommendation(
                id=f"pl.unsupported_ls.{ls_type}",
                area="pipelines.linked_services",
                title=f"Fabric-unsupported linked service type: {ls_type} ({len(hits)})",
                severity="warning",
                effort="high",
                target=ls_type,
                detail=f"Linked services: {', '.join(hits[:5])}{'' if len(hits) <= 5 else ' (+more)'}",
                fabric_action="Replace with a supported Fabric connector or implement via Spark notebooks.",
            ))

    self_hosted = [ir for ir in (payload.get("integration_runtimes") or [])
                   if (ir.get("type") or "").lower().startswith("self")]
    if self_hosted:
        out.append(Recommendation(
            id="pl.self_hosted_ir",
            area="pipelines.integration_runtimes",
            title=f"{len(self_hosted)} self-hosted integration runtime(s)",
            severity="warning",
            effort="medium",
            detail="Self-hosted IRs need an equivalent gateway in Fabric (on-premises data gateway).",
            fabric_action="Provision an on-premises data gateway and re-point linked connections.",
        ))

    # Run-history derived signals.
    run_history = payload.get("run_history")
    if isinstance(run_history, dict):
        out.extend(_rules_for_run_history(run_history))

    # v2 — expression-language compatibility findings.
    expr = payload.get("expression_findings") or []
    if expr:
        by_rule: dict[str, list[str]] = {}
        sev_by_rule: dict[str, str] = {}
        for f in expr:
            by_rule.setdefault(f.get("rule_id", "?"), []).append(
                f"{f.get('pipeline')}::{f.get('activity')}"
            )
            sev_by_rule.setdefault(f.get("rule_id", "?"), f.get("severity", "info"))
        for rule_id, hits in by_rule.items():
            sample = ", ".join(sorted(set(hits))[:5])
            out.append(Recommendation(
                id=f"pl.expr.{rule_id}",
                area="pipelines.expressions",
                title=f"Expression compat: {rule_id} ({len(hits)} hit(s))",
                severity=sev_by_rule.get(rule_id, "info"),  # type: ignore[arg-type]
                effort="medium",
                detail=f"Found in: {sample}",
                fabric_action="Adjust expressions to Fabric Data Factory equivalents (system vars, secrets, getMetadata).",
            ))

    # v2 — trigger schedule mappings (informational).
    sched = payload.get("schedule_mappings") or []
    if sched:
        out.append(Recommendation(
            id="pl.schedule_mappings",
            area="pipelines.triggers",
            title=f"{len(sched)} trigger schedule(s) mapped to Fabric equivalents",
            severity="info",
            effort="low",
            detail="Trigger payloads were translated into Fabric scheduling primitives where possible.",
            fabric_action="Recreate the schedules in Fabric Data Factory using the captured cadence/start time.",
        ))
    return out


def _action_for_activity(activity_type: str) -> str:
    return _ACTIVITY_ACTIONS.get(activity_type, "No direct equivalent in Fabric — refactor or replace.")


def _rules_for_run_history(run_history: dict[str, Any]) -> list[Recommendation]:
    """Surface Fabric-relevant signals from observed pipeline run statistics.

    - Idle pipelines (no runs in the longest window): may not need migration now.
    - Low success rate (28d window) on terminal runs: investigate before cutover.
    - Heavy data movers (avg MB/run in 28d window) get a sizing hint.
    """
    out: list[Recommendation] = []
    by_pipeline = run_history.get("by_pipeline") or []
    if not by_pipeline:
        return out

    idle: list[str] = []
    low_sr: list[tuple[str, float, int]] = []
    heavy: list[tuple[str, float]] = []

    for stats in by_pipeline:
        pname = stats.get("pipeline") or "?"
        windows = {w.get("window_days"): w for w in (stats.get("windows") or [])}
        widest = max(windows) if windows else None
        wide_w = windows.get(widest) if widest is not None else None
        w28 = windows.get(28) or wide_w
        if wide_w is not None and (wide_w.get("run_count") or 0) == 0:
            idle.append(pname)
            continue
        if w28 is not None:
            sr = w28.get("success_rate")
            terminal = (w28.get("succeeded") or 0) + (w28.get("failed") or 0)
            if sr is not None and sr < 0.95 and terminal >= 5:
                low_sr.append((pname, sr, terminal))
            avg_mb = w28.get("avg_data_moved_mb_per_run")
            if avg_mb is not None and avg_mb >= 1024:  # >= 1 GB / run
                heavy.append((pname, avg_mb))

    if idle:
        sample = ", ".join(idle[:5])
        more = "" if len(idle) <= 5 else f" (+{len(idle) - 5} more)"
        out.append(Recommendation(
            id="pl.runs.idle",
            area="pipelines.runs",
            title=f"{len(idle)} pipeline(s) idle in observed window",
            severity="info",
            effort="low",
            detail=f"No runs observed: {sample}{more}.",
            fabric_action=(
                "Confirm with owners whether these pipelines are still in use; "
                "deprioritize or retire before migration to reduce scope."
            ),
        ))

    for pname, sr, terminal in sorted(low_sr, key=lambda x: x[1]):
        out.append(Recommendation(
            id=f"pl.runs.low_success.{pname}",
            area="pipelines.runs",
            title=f"Pipeline {pname}: {sr * 100:.1f}% success (28d, n={terminal})",
            severity="warning",
            effort="medium",
            target=pname,
            detail="Failure rate exceeds 5% over the last 28 days.",
            fabric_action=(
                "Investigate root cause and stabilize before migration; failures will "
                "carry over and may be harder to diagnose post-cutover."
            ),
        ))

    if heavy:
        # Single rollup recommendation; details list the offenders.
        items = "; ".join(f"{p} ({mb:,.0f} MB/run)" for p, mb in
                          sorted(heavy, key=lambda x: -x[1])[:5])
        more = "" if len(heavy) <= 5 else f" (+{len(heavy) - 5} more)"
        out.append(Recommendation(
            id="pl.runs.heavy_data_movement",
            area="pipelines.runs",
            title=f"{len(heavy)} pipeline(s) move >=1 GB / run on average",
            severity="info",
            effort="medium",
            detail=f"Top offenders: {items}{more}.",
            fabric_action=(
                "Factor sustained data movement into Fabric capacity sizing and "
                "consider staging copies into OneLake to reduce egress."
            ),
        ))
    return out


_ACTIVITY_ACTIONS: dict[str, str] = {
    "ExecuteDataFlow": "Rebuild the mapping data flow as a Fabric Dataflow Gen2 or Spark notebook.",
    "ExecuteWranglingDataflow": "Rebuild as a Fabric Dataflow Gen2 (Power Query online).",
    "ExecuteSSISPackage": "No SSIS-IR in Fabric — re-implement in Fabric Data Factory pipelines or Spark.",
    "Custom": "Custom .NET on Azure Batch is not supported — re-implement in Spark notebooks or Functions.",
    "HDInsightHive": "Re-implement using Fabric Spark.",
    "HDInsightPig": "Re-implement using Fabric Spark.",
    "HDInsightMapReduce": "Re-implement using Fabric Spark.",
    "HDInsightStreaming": "Re-implement using Fabric Eventstream / Spark Structured Streaming.",
    "HDInsightSpark": "Migrate to Fabric Spark notebooks / job definitions.",
    "AzureMLBatchExecution": "Move to Azure ML v2 (call from a Web/Webhook activity) or Fabric Data Science.",
    "AzureMLUpdateResource": "No Fabric equivalent — orchestrate AML v2 via REST.",
    "AzureMLExecutePipeline": "Move to Azure ML v2 pipelines invoked via REST.",
    "DataLakeAnalyticsU-SQL": "ADLA is retired — re-implement in Fabric Spark or Warehouse.",
}


def rules_for_monitoring(payload: dict[str, Any]) -> list[Recommendation]:
    """Translate observed DWU usage into Fabric capacity sizing hints."""
    out: list[Recommendation] = []
    series = payload.get("series") or []
    if not series:
        return out

    # Group DWU-percent series by pool and look at p95.
    by_pool: dict[str, dict[str, dict[str, Any]]] = {}
    for s in series:
        by_pool.setdefault(s["resource_name"], {})[s["metric_name"]] = s

    for pool, metrics in by_pool.items():
        used_pct = metrics.get("DWUUsedPercent") or {}
        p95 = used_pct.get("p95_value")
        avg = used_pct.get("avg_value")
        if p95 is None and avg is None:
            continue
        if p95 is not None and p95 < 30:
            sev, hint = "info", "Pool is under-utilized; consider downsizing or migrating to a small Fabric capacity."
        elif p95 is not None and p95 > 85:
            sev, hint = "warning", "Pool is heavily utilized; size Fabric capacity above current SKU and validate concurrency."
        else:
            sev, hint = "info", "Pool utilization is moderate; pick Fabric capacity at or slightly above current SKU."
        out.append(Recommendation(
            id=f"mon.dwu.{pool}",
            area="monitoring.dwu",
            title=f"DWU usage on '{pool}': p95={p95}, avg={avg}",
            severity=sev,  # type: ignore[arg-type]
            effort="low",
            target=pool,
            detail=f"Last-window DWUUsedPercent p95={p95}, avg={avg}.",
            fabric_action=hint,
        ))

        failed = metrics.get("ConnectionsBlockedByFirewall") or {}
        if (failed.get("max_value") or 0) > 0:
            out.append(Recommendation(
                id=f"mon.failed_conn.{pool}",
                area="monitoring.connections",
                title=f"Connections blocked by firewall on '{pool}'",
                severity="warning",
                effort="low",
                target=pool,
                detail=f"Max ConnectionsBlockedByFirewall in window: {failed.get('max_value')}.",
                fabric_action="Investigate firewall / auth issues before migration; replicate firewall rules in Fabric.",
            ))

    return out
