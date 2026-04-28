from __future__ import annotations

from ..models import CodeObject
from ..sql_client import DedicatedPoolSqlClient
from ..tsql_surface_gap import stable_code_object_id


def collect_code_objects(sql: DedicatedPoolSqlClient) -> list[CodeObject]:
    rows = sql.fetch_query_file("code_objects")
    return [
        CodeObject(
            schema_name=r["schema_name"],
            object_name=r["object_name"],
            object_type=r["object_type"],
            definition=(r.get("definition") or "")[:50_000] or None,
            code_object_id=stable_code_object_id(
                r["schema_name"], r["object_name"], r["object_type"],
            ),
        )
        for r in rows
    ]
