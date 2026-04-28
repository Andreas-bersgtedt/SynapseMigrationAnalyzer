"""pyodbc-based SQL client for Synapse dedicated SQL pools using AAD access tokens."""
from __future__ import annotations

import logging
import struct
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pyodbc

from ..._odbc import resolve_odbc_driver
from ...auth import get_sql_access_token
from ...config import AppConfig

log = logging.getLogger(__name__)

# SQL_COPT_SS_ACCESS_TOKEN; required to pass an AAD token via pyodbc.
_SQL_COPT_SS_ACCESS_TOKEN = 1256

_QUERIES_DIR = Path(__file__).parent / "queries"


class DedicatedPoolSqlClient:
    """Connects to a single dedicated SQL pool using a service-principal access token."""

    def __init__(self, cfg: AppConfig, server_fqdn: str, database: str) -> None:
        self._cfg = cfg
        self._server = server_fqdn
        self._database = database

    def _connection_string(self) -> str:
        sql = self._cfg.sql
        driver = resolve_odbc_driver(sql.odbc_driver)
        return (
            f"Driver={{{driver}}};"
            f"Server=tcp:{self._server},1433;"
            f"Database={self._database};"
            f"Encrypt=yes;TrustServerCertificate=no;"
            f"Connection Timeout={sql.login_timeout};"
        )

    def _token_struct(self) -> bytes:
        token = get_sql_access_token(self._cfg.azure)
        encoded = token.encode("utf-16-le")
        return struct.pack("=i", len(encoded)) + encoded

    @contextmanager
    def connect(self) -> Iterator[pyodbc.Connection]:
        log.debug("Connecting to %s / %s", self._server, self._database)
        attrs = {_SQL_COPT_SS_ACCESS_TOKEN: self._token_struct()}
        conn = pyodbc.connect(self._connection_string(), attrs_before=attrs)
        conn.timeout = self._cfg.sql.query_timeout
        try:
            yield conn
        finally:
            conn.close()

    def fetch_all(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self.connect() as conn:
            cur = conn.cursor()
            cur.execute(sql, params)
            cols = [c[0] for c in cur.description] if cur.description else []
            return [dict(zip(cols, row)) for row in cur.fetchall()]

    def fetch_query_file(self, name: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        """Load `<queries>/<name>.sql` and execute it."""
        sql_path = _QUERIES_DIR / f"{name}.sql"
        sql = sql_path.read_text(encoding="utf-8")
        return self.fetch_all(sql, params)
