from __future__ import annotations

import csv
from pathlib import Path
from typing import Iterable

from ...reporting.generic import write_csv_rows, write_json_model, write_markdown
from .html_report import write_html
from .models import Activity, PipelinesAnalysis


def _write_activities_csv(path: Path, rows: list[Activity]) -> Path | None:
    """Write activities CSV with list fields flattened (semicolon-delimited)."""
    if not rows:
        return None
    fieldnames = list(rows[0].model_dump(mode="json").keys())
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            d = r.model_dump(mode="json")
            for k, v in list(d.items()):
                if isinstance(v, list):
                    d[k] = "; ".join(str(x) for x in v)
            writer.writerow(d)
    return path


def write_reports(result: PipelinesAnalysis, out_dir: Path, formats: Iterable[str]) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    fmts = {f.lower() for f in formats}
    written: list[Path] = []

    if "json" in fmts:
        written.append(write_json_model(result, out_dir / "pipelines.json"))

    if "csv" in fmts:
        # Activities have list-typed columns (reasons, caveats) — flatten those.
        p = _write_activities_csv(out_dir / "pipeline_activities.csv", result.activities)
        if p:
            written.append(p)
        for fname, rows in (
            ("pipelines.csv", result.pipelines),
            ("linked_services.csv", result.linked_services),
            ("datasets.csv", result.datasets),
            ("triggers.csv", result.triggers),
            ("integration_runtimes.csv", result.integration_runtimes),
        ):
            p = write_csv_rows(out_dir / fname, rows)
            if p:
                written.append(p)

    if "markdown" in fmts:
        unsupported_acts = [a for a in result.activities if a.support == "unsupported"]
        partial_acts = [a for a in result.activities if a.support == "partial"]
        unsupported_ls = [ls for ls in result.linked_services if not ls.fabric_supported]
        lines = [
            "# Synapse Migration Analyzer - Pipelines",
            "",
            f"- Workspace: `{result.workspace_name}`",
            f"- Artifacts endpoint: `{result.artifacts_endpoint}`",
            f"- Generated: {result.generated_at.isoformat()}",
            "",
            f"- Pipelines: {len(result.pipelines)}",
            f"- Activities (flattened): {len(result.activities)}  "
            f"(unsupported: **{len(unsupported_acts)}**, partial: {len(partial_acts)})",
            f"- Linked services: {len(result.linked_services)}  "
            f"(Fabric-unsupported: **{len(unsupported_ls)}**)",
            f"- Datasets: {len(result.datasets)}",
            f"- Triggers: {len(result.triggers)}",
            f"- Integration runtimes: {len(result.integration_runtimes)}",
            "",
        ]
        if result.errors:
            lines.append("## Collection errors")
            for e in result.errors:
                lines.append(f"- {e}")
            lines.append("")
        if result.pipelines:
            lines.append("## Pipelines")
            lines.append("| Name | Folder | Activities | Unsupported | Partial | Activity types |")
            lines.append("|---|---|---:|---:|---:|---|")
            for p in result.pipelines:
                lines.append(
                    f"| {p.name} | {p.folder or ''} | {p.activity_count} | "
                    f"{p.unsupported_activity_count} | {p.partial_activity_count} | "
                    f"{', '.join(p.activity_types)} |"
                )
            lines.append("")
        if unsupported_acts:
            lines.append("## Fabric-unsupported activities")
            for a in unsupported_acts:
                lines.append(f"### `{a.pipeline}` &rarr; `{a.name}` ({a.type})")
                if a.fabric_equivalent:
                    lines.append(f"- **Fabric equivalent:** {a.fabric_equivalent}")
                else:
                    lines.append("- **Fabric equivalent:** _none_")
                if a.migration_action:
                    lines.append(f"- **Action:** {a.migration_action}")
                for r in a.support_reasons:
                    lines.append(f"  - Reason: {r}")
                for c in a.support_caveats:
                    lines.append(f"  - Caveat: {c}")
                if a.doc_url:
                    lines.append(f"- Docs: <{a.doc_url}>")
                lines.append("")
        if partial_acts:
            lines.append("## Partially-compatible activities")
            lines.append("> These activities exist in Fabric Data Factory but with reduced functionality, narrower connector support, or different config — *what* is partial is listed per activity.")
            lines.append("")
            for a in partial_acts:
                lines.append(f"### `{a.pipeline}` &rarr; `{a.name}` ({a.type})")
                if a.fabric_equivalent:
                    lines.append(f"- **Fabric equivalent:** {a.fabric_equivalent}")
                if a.migration_action:
                    lines.append(f"- **Action:** {a.migration_action}")
                for r in a.support_reasons:
                    lines.append(f"  - Reason: {r}")
                for c in a.support_caveats:
                    lines.append(f"  - Caveat (this instance): {c}")
                if a.doc_url:
                    lines.append(f"- Docs: <{a.doc_url}>")
                lines.append("")
        if unsupported_ls:
            lines.append("## Fabric-unsupported linked services")
            lines.append("| Name | Type |")
            lines.append("|---|---|")
            for ls in unsupported_ls:
                lines.append(f"| {ls.name} | {ls.type} |")
            lines.append("")
        if result.linked_services:
            lines.append("## Linked services")
            lines.append("| Name | Type | Connect via | Fabric supported |")
            lines.append("|---|---|---|---|")
            for ls in result.linked_services:
                lines.append(f"| {ls.name} | {ls.type} | {ls.connect_via or ''} | {'yes' if ls.fabric_supported else 'no'} |")
            lines.append("")
        if result.integration_runtimes:
            lines.append("## Integration runtimes")
            lines.append("| Name | Type |")
            lines.append("|---|---|")
            for ir in result.integration_runtimes:
                lines.append(f"| {ir.name} | {ir.type} |")
            lines.append("")
        written.append(write_markdown(out_dir / "pipelines.md", lines))

    if "html" in fmts:
        written.append(write_html(result, out_dir))

    return written
