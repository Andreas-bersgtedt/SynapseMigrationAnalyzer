"""Build a per-object "T-SQL surface gaps" rollup for dedicated pool code objects.

Each ``CodeObject`` (stored procedure / view / function) is hashed into a stable
``code_object_id`` of the form ``<schema>.<object_name>.<object_type>`` (lowercased,
non-alphanumerics collapsed to ``_``). The id is deterministic across runs as long
as the qualified name does not change, which makes diffing two analyzer runs trivial.

This module deliberately does *not* reach into the T-SQL surface heuristics module —
it consumes the existing :func:`fabric_mapping.tsql_surface.scan` output and reshapes
it for per-object reporting. Rules in fabric_mapping still produce the human-readable
recommendations.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from ..fabric_mapping import tsql_surface
from .models import CodeObject, TsqlSurfaceGap

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def stable_code_object_id(schema_name: str, object_name: str, object_type: str) -> str:
    """Compute a stable, filesystem-safe identifier for a T-SQL code object.

    The id is deterministic — same inputs always yield the same id — and contains only
    lowercase alphanumerics + dots. Use it as a join key when diffing across runs.
    """
    parts = (schema_name or "?", object_name or "?", object_type or "?")
    slug = ".".join(_SLUG_RE.sub("_", p.lower()).strip("_") for p in parts)
    return slug


def build_gaps(code_objects: Iterable[CodeObject]) -> list[TsqlSurfaceGap]:
    """Run the T-SQL surface scanner across each code object and return one row per
    (object, rule) pair with the match count.
    """
    out: list[TsqlSurfaceGap] = []
    for obj in code_objects:
        cid = obj.code_object_id or stable_code_object_id(
            obj.schema_name, obj.object_name, obj.object_type
        )
        for finding in tsql_surface.scan(obj.definition or ""):
            out.append(TsqlSurfaceGap(
                code_object_id=cid,
                schema_name=obj.schema_name,
                object_name=obj.object_name,
                object_type=obj.object_type,
                rule_id=finding.rule_id,
                label=finding.label,
                severity=finding.severity,
                matches=finding.matches,
                fabric_action=tsql_surface.fabric_action_for(finding.rule_id),
            ))
    return out


@dataclass(frozen=True)
class GapSummary:
    code_object_id: str
    rule_count: int
    total_matches: int
    severities: tuple[str, ...]


def summarize_per_object(gaps: Iterable[TsqlSurfaceGap]) -> list[GapSummary]:
    """Aggregate gaps by code_object_id for executive-summary tables."""
    by_obj: dict[str, dict] = {}
    for g in gaps:
        b = by_obj.setdefault(g.code_object_id, {"rules": set(), "matches": 0, "sev": set()})
        b["rules"].add(g.rule_id)
        b["matches"] += g.matches
        b["sev"].add(g.severity)
    return [
        GapSummary(
            code_object_id=cid,
            rule_count=len(b["rules"]),
            total_matches=b["matches"],
            severities=tuple(sorted(b["sev"])),
        )
        for cid, b in sorted(by_obj.items())
    ]
