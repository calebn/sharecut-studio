"""One ``BEGIN IMMEDIATE`` write-transaction helper for every sqlite store."""

from __future__ import annotations

import contextlib
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager


@contextmanager
def immediate_transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """Run the body in ``BEGIN IMMEDIATE`` ... ``COMMIT`` on *conn* (``isolation_level=None``).

    ``BEGIN IMMEDIATE`` takes the database write lock up front, so every connection to
    the file (other processes included) serializes on it. If the body raises or ``COMMIT``
    fails (SQLITE_FULL, IOERR, BUSY), it rolls back, so the connection never stays inside
    an open transaction. A failing ``ROLLBACK`` is suppressed so the original error
    propagates. Not re-entrant: callers that nest keep their own depth count.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        conn.execute("COMMIT")
    except BaseException:
        with contextlib.suppress(sqlite3.Error):
            conn.execute("ROLLBACK")
        raise
