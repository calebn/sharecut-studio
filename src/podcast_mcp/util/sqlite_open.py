"""The one way a sqlite store opens its connection: WAL, then a busy timeout."""

from __future__ import annotations

import contextlib
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.util.sqlite_tx import DEFAULT_BUSY_TIMEOUT_MS
from podcast_mcp.util.sqlite_wal import retry_transient, switch_to_wal

IsolationLevel = Literal["DEFERRED", "EXCLUSIVE", "IMMEDIATE"] | None


def schema_setup(script: str) -> Callable[[sqlite3.Connection], None]:
    """A ``setup`` for ``open_sqlite`` that runs an idempotent schema script."""

    def apply(connection: sqlite3.Connection) -> None:
        connection.executescript(script)

    return apply


def open_sqlite(
    target: str | Path,
    *,
    uri: bool = False,
    isolation_level: IsolationLevel = None,
    row_factory: Callable[..., Any] | None = None,
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
    wal_timeout_sec: float = 10.0,
    wal_retry_sec: float = 0.05,
    verify: Callable[[], None] | None = None,
    setup: Callable[[sqlite3.Connection], None] | None = None,
) -> sqlite3.Connection:
    """Open *target* in WAL mode with a busy timeout of *busy_timeout_ms*.

    The WAL switch can return busy without invoking the busy handler, so it runs
    with the handler off (``timeout=0``) and ``ensure_wal`` retries it every
    *wal_retry_sec* for up to *wal_timeout_sec*; the busy timeout is set after it
    for the store's own statements. ``setup`` (a store's idempotent schema) runs
    inside that same bounded retry, because the first write after a concurrent first
    open can answer busy or transiently readonly just like the switch (#1932).
    ``verify`` runs after the connect and after the WAL switch and setup so a store
    can check the files sqlite just created. The connection is closed if any step
    raises, including ``KeyboardInterrupt``.
    """
    connection = sqlite3.connect(
        str(target),
        check_same_thread=False,
        isolation_level=isolation_level,
        timeout=0,
        uri=uri,
    )
    try:
        if verify is not None:
            verify()
        if row_factory is not None:
            connection.row_factory = row_factory

        def wal_and_setup() -> None:
            switch_to_wal(connection)
            if setup is not None:
                setup(connection)

        retry_transient(
            connection,
            wal_and_setup,
            timeout_sec=wal_timeout_sec,
            retry_sec=wal_retry_sec,
            monotonic=time.monotonic,
            sleep=time.sleep,
        )
        if verify is not None:
            verify()
        connection.execute(f"PRAGMA busy_timeout={busy_timeout_ms}")
    except BaseException:
        with contextlib.suppress(BaseException):
            connection.close()
        raise
    return connection
