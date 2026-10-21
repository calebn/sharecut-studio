from __future__ import annotations

import os
import sqlite3
import time
from collections.abc import Callable

from podcast_mcp.util.sqlite_tx import is_sqlite_busy


def _transient_readonly(connection: sqlite3.Connection, exc: sqlite3.OperationalError) -> bool:
    """True for ``SQLITE_READONLY`` on a database file this process may write.

    Two processes making a fresh file WAL at once can leave one with ``attempt to write a
    readonly database`` while the other holds the switch (seen on Windows, #1880); it clears
    once the other connection is done. A file the process cannot write stays an error.
    """
    code = getattr(exc, "sqlite_errorcode", None)
    if code is None:
        if "readonly" not in str(exc).lower():
            return False
    elif code not in (sqlite3.SQLITE_READONLY, sqlite3.SQLITE_READONLY_RECOVERY):
        return False
    try:
        rows = connection.execute("PRAGMA database_list").fetchall()
    except sqlite3.Error:
        return False
    path = next((row[2] for row in rows if row[1] == "main"), "")
    return bool(path) and os.access(path, os.W_OK)


def switch_to_wal(connection: sqlite3.Connection) -> None:
    """Make *connection*'s database WAL; a no-op when it already is."""
    journal_mode = str(connection.execute("PRAGMA journal_mode").fetchone()[0]).lower()
    if journal_mode != "wal":
        connection.execute("PRAGMA journal_mode=WAL")


def retry_transient(
    connection: sqlite3.Connection,
    step: Callable[[], None],
    *,
    timeout_sec: float = 10.0,
    retry_sec: float = 0.05,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Run *step* until it stops answering busy or transiently readonly, for up to *timeout_sec*.

    *step* must be safe to repeat; any other error, and the last transient one at the
    deadline, is raised with a note describing the terminal attempt.
    """
    started = monotonic()
    deadline = started + timeout_sec
    attempts = 0
    while True:
        try:
            attempts += 1
            step()
            return
        except sqlite3.OperationalError as exc:
            transient = is_sqlite_busy(exc) or _transient_readonly(connection, exc)
            now = monotonic()
            if not transient or now >= deadline:
                reason = "deadline" if transient else "not_transient"
                exc.add_note(
                    f"SQLite retry failed: sqlite_errorcode={getattr(exc, 'sqlite_errorcode', None)} "
                    f"sqlite_errorname={getattr(exc, 'sqlite_errorname', None)} "
                    f"sqlite_version={sqlite3.sqlite_version} attempts={attempts} "
                    f"elapsed_sec={now - started:.6f} terminal_reason={reason}"
                )
                raise
            sleep(retry_sec)


def ensure_wal(
    connection: sqlite3.Connection,
    *,
    timeout_sec: float = 10.0,
    retry_sec: float = 0.05,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Switch *connection*'s database to WAL, retrying while another process holds the lock.

    A concurrent first open can answer busy or, transiently, readonly (#1880); both are
    retried until *timeout_sec*.
    """
    retry_transient(
        connection,
        lambda: switch_to_wal(connection),
        timeout_sec=timeout_sec,
        retry_sec=retry_sec,
        monotonic=monotonic,
        sleep=sleep,
    )
