"""Collector for the top-N most-referenced tables/views on a dedicated pool."""
from __future__ import annotations

from ..models import TopConsumedObject
from ..sql_client import DedicatedPoolSqlClient


def _coerce_int(value: object) -> int:
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def collect_top_consumed_objects(
    sql: DedicatedPoolSqlClient,
) -> list[TopConsumedObject]:
    """Return tables/views most frequently referenced in recent workload SQL.

    Sourced from ``sys.dm_pdw_sql_requests`` (the distributed SQL request
    history DMV). Tokens that resolve to a real ``INFORMATION_SCHEMA``
    entry are counted; everything else is dropped. The DMV is a rolling
    buffer, so the absolute counts are only meaningful relative to each
    other within a single run.
    """
    rows = sql.fetch_query_file("top_consumed_objects")
    out: list[TopConsumedObject] = []
    for r in rows:
        name = r.get("object_name")
        otype = r.get("object_type")
        if not name or not otype:
            continue
        out.append(
            TopConsumedObject(
                object_name=str(name),
                object_type=str(otype),
                usage_count=_coerce_int(r.get("usage_count")),
            )
        )
    return out
