from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Iterable

from ...reporting.generic import write_csv_rows, write_json_model, write_markdown
from .html_report import write_html
from .models import FabricMappingReport


def write_reports(result: FabricMappingReport, out_dir: Path, formats: Iterable[str]) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    fmts = {f.lower() for f in formats}
    written: list[Path] = []

    if "json" in fmts:
        written.append(write_json_model(result, out_dir / "fabric_mapping.json"))

    if "csv" in fmts:
        p = write_csv_rows(out_dir / "fabric_recommendations.csv", result.recommendations)
        if p:
            written.append(p)

    if "markdown" in fmts:
        sev = Counter(r.severity for r in result.recommendations)
        lines = [
            "# Fabric Warehouse Migration Recommendations",
            "",
            f"- Workspace: `{result.workspace_name}`",
            f"- Generated: {result.generated_at.isoformat()}",
            f"- Total recommendations: {len(result.recommendations)} "
            f"(blockers: {sev.get('blocker', 0)}, warnings: {sev.get('warning', 0)}, info: {sev.get('info', 0)})",
            "",
            "## Inputs analyzed",
            "",
            "| Module | Source | Counts |",
            "|---|---|---|",
        ]
        for s in result.inputs:
            counts = ", ".join(f"{k}={v}" for k, v in sorted(s.counts.items())) or "-"
            lines.append(f"| {s.module} | `{s.source_file}` | {counts} |")
        lines.append("")
        if result.recommendations:
            lines.append("## Recommendations")
            lines.append("")
            lines.append("| Severity | Effort | Area | Target | Title | Action |")
            lines.append("|---|---|---|---|---|---|")
            for r in sorted(result.recommendations, key=lambda x: ("blocker", "warning", "info").index(x.severity)):
                lines.append(
                    f"| {r.severity} | {r.effort} | {r.area} | {r.target or ''} | {r.title} | "
                    f"{r.fabric_action or ''} |"
                )
            lines.append("")
            lines.append("## Details")
            lines.append("")
            for r in result.recommendations:
                lines.append(f"### {r.title}")
                lines.append(f"- **Severity:** {r.severity} | **Effort:** {r.effort}")
                lines.append(f"- **Area:** `{r.area}`")
                if r.target:
                    lines.append(f"- **Target:** `{r.target}`")
                lines.append(f"- {r.detail}")
                if r.fabric_action:
                    lines.append(f"- **Fabric action:** {r.fabric_action}")
                lines.append("")
        written.append(write_markdown(out_dir / "fabric_mapping.md", lines))

    if "html" in fmts:
        written.append(write_html(result, out_dir))

    return written
