from __future__ import annotations

from pathlib import Path

from ..modules.dedicated_pools.models import WorkspaceAnalysis


def write_markdown(result: WorkspaceAnalysis, out_dir: Path) -> Path:
    lines: list[str] = []
    lines.append(f"# Synapse Migration Analyzer - Dedicated SQL Pools")
    lines.append("")
    lines.append(f"- **Workspace:** `{result.workspace_name}`")
    lines.append(f"- **Subscription:** `{result.subscription_id}`")
    lines.append(f"- **Resource group:** `{result.resource_group}`")
    lines.append(f"- **Generated:** {result.generated_at.isoformat()}")
    lines.append(f"- **Pools analyzed:** {len(result.pools)}")
    lines.append("")

    for pool in result.pools:
        inv = pool.inventory
        lines.append(f"## Pool: `{inv.name}`")
        lines.append("")
        lines.append(f"- Status: `{inv.status}` | SKU: `{inv.sku_name}` | DWU: `{inv.sku_capacity}` | Location: `{inv.location}`")
        lines.append(f"- Collation: `{inv.collation}` | MaxSizeBytes: `{inv.max_size_bytes}`")
        if pool.errors:
            lines.append("")
            lines.append("**Collection errors:**")
            for e in pool.errors:
                lines.append(f"- {e}")

        lines.append("")
        lines.append(f"### Schemas ({len(pool.schemas)})")
        if pool.schemas:
            lines.append("| Schema | Objects |")
            lines.append("|---|---:|")
            for s in pool.schemas:
                lines.append(f"| {s.schema_name} | {s.object_count} |")

        lines.append("")
        lines.append(f"### Tables ({len(pool.tables)})")
        if pool.tables:
            lines.append("| Schema | Table | Distribution | Dist Col | Partitioned | Rows | Reserved MB | Index Type |")
            lines.append("|---|---|---|---|---:|---:|---:|---|")
            for t in pool.tables:
                lines.append(
                    f"| {t.schema_name} | {t.table_name} | {t.distribution_policy or ''} | "
                    f"{t.distribution_column or ''} | {t.is_partitioned} | "
                    f"{t.row_count if t.row_count is not None else ''} | "
                    f"{t.reserved_space_mb if t.reserved_space_mb is not None else ''} | "
                    f"{t.index_type or ''} |"
                )

        lines.append("")
        lines.append(f"### Usage")
        if pool.usage:
            lines.append("| Metric | Value | Unit |")
            lines.append("|---|---|---|")
            for u in pool.usage:
                lines.append(f"| {u.metric} | {u.value} | {u.unit or ''} |")

        lines.append("")
        lines.append(f"### Workload groups ({len(pool.workload_groups)})")
        if pool.workload_groups:
            lines.append("| Name | Importance | Min % | Cap % | Min Grant % | Classifiers |")
            lines.append("|---|---|---:|---:|---:|---:|")
            for w in pool.workload_groups:
                lines.append(
                    f"| {w.name} | {w.importance or ''} | {w.min_resource_pct or ''} | "
                    f"{w.cap_resource_pct or ''} | {w.request_min_resource_grant_pct or ''} | "
                    f"{w.classifier_count} |"
                )

        lines.append("")
        lines.append(f"### Security principals ({len(pool.security)})")
        if pool.security:
            lines.append("| Name | Type | Roles |")
            lines.append("|---|---|---|")
            for sp in pool.security:
                lines.append(f"| {sp.name} | {sp.type} | {', '.join(sp.role_memberships)} |")
        lines.append("")

    path = out_dir / "dedicated_pools.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path
