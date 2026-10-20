"""``ensure_wal`` retries the transient answers a concurrent first open gets (#1880)."""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from podcast_mcp.util.sqlite_wal import ensure_wal, retry_transient


def _error(message: str, code: int) -> sqlite3.OperationalError:
    exc = sqlite3.OperationalError(message)
    exc.sqlite_errorcode = code  # type: ignore[attr-defined]
    return exc


class _FailsThenWal:
    """A real connection whose first *failures* WAL switches answer *error*."""

    def __init__(self, real: sqlite3.Connection, error: sqlite3.OperationalError, failures: int):
        self._real = real
        self._error = error
        self.failures = failures
        self.attempts = 0

    def execute(self, sql: str, *args: object) -> sqlite3.Cursor:
        if sql.upper().startswith("PRAGMA JOURNAL_MODE=WAL"):
            self.attempts += 1
            if self.attempts <= self.failures:
                raise self._error
        return self._real.execute(sql, *args)


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


@pytest.mark.parametrize(
    "error",
    [
        _error("database is locked", sqlite3.SQLITE_BUSY),
        _error("attempt to write a readonly database", sqlite3.SQLITE_READONLY),
        _error("attempt to write a readonly database", sqlite3.SQLITE_READONLY_RECOVERY),
    ],
    ids=["busy", "readonly", "readonly_recovery"],
)
def test_a_transient_answer_is_retried_until_the_switch_lands(
    tmp_path: Path, error: sqlite3.OperationalError
) -> None:
    clock = _Clock()
    with closing(sqlite3.connect(tmp_path / "fresh.db")) as real:
        connection = _FailsThenWal(real, error, failures=3)
        ensure_wal(
            connection,  # type: ignore[arg-type]
            monotonic=clock.monotonic,
            sleep=clock.sleep,
        )
        assert connection.attempts == 4
        assert real.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert len(clock.slept) == 3


def test_a_persistent_readonly_answer_stops_at_the_deadline(tmp_path: Path) -> None:
    clock = _Clock()
    with closing(sqlite3.connect(tmp_path / "fresh.db")) as real:
        connection = _FailsThenWal(
            real, _error("attempt to write a readonly database", sqlite3.SQLITE_READONLY), 10**6
        )
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            ensure_wal(
                connection,  # type: ignore[arg-type]
                timeout_sec=1.0,
                retry_sec=0.25,
                monotonic=clock.monotonic,
                sleep=clock.sleep,
            )
    assert clock.slept == [0.25] * 4


@pytest.mark.skipif(os.name != "posix" or os.geteuid() == 0, reason="needs a file mode we obey")
def test_a_file_this_process_cannot_write_fails_at_once(tmp_path: Path) -> None:
    path = tmp_path / "locked.db"
    with closing(sqlite3.connect(path)) as setup:
        setup.execute("CREATE TABLE t (x)")
        setup.commit()
    os.chmod(path, 0o444)
    clock = _Clock()
    with closing(sqlite3.connect(path)) as real:
        connection = _FailsThenWal(
            real, _error("attempt to write a readonly database", sqlite3.SQLITE_READONLY), 10**6
        )
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            ensure_wal(
                connection,  # type: ignore[arg-type]
                monotonic=clock.monotonic,
                sleep=clock.sleep,
            )
    assert clock.slept == []


def test_an_unrelated_operational_error_is_not_retried(tmp_path: Path) -> None:
    clock = _Clock()
    with closing(sqlite3.connect(tmp_path / "fresh.db")) as real:
        connection = _FailsThenWal(real, _error("disk I/O error", sqlite3.SQLITE_IOERR), 1)
        with pytest.raises(sqlite3.OperationalError, match="disk I/O"):
            ensure_wal(
                connection,  # type: ignore[arg-type]
                monotonic=clock.monotonic,
                sleep=clock.sleep,
            )
    assert clock.slept == []


def test_retry_transient_repeats_any_step_not_only_the_wal_switch(tmp_path: Path) -> None:
    clock = _Clock()
    calls: list[int] = []

    def step() -> None:
        calls.append(1)
        if len(calls) <= 2:
            raise _error("attempt to write a readonly database", sqlite3.SQLITE_READONLY)

    with closing(sqlite3.connect(tmp_path / "fresh.db")) as real:
        retry_transient(real, step, monotonic=clock.monotonic, sleep=clock.sleep)
    assert len(calls) == 3
    assert len(clock.slept) == 2
