"""Shared sqlite fault injection for store transaction tests."""

from __future__ import annotations

import sqlite3
from typing import Any


class FailingConnection:
    """Delegate to a real connection; raise once on the first statement starting with *fail_on*."""

    def __init__(self, conn: sqlite3.Connection, fail_on: str) -> None:
        self._conn = conn
        self._fail_on: str | None = fail_on

    def execute(self, sql: str, *args: Any) -> sqlite3.Cursor:
        if self._fail_on is not None and sql.lstrip().startswith(self._fail_on):
            self._fail_on = None
            raise sqlite3.OperationalError("injected failure")
        return self._conn.execute(sql, *args)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._conn, name)
