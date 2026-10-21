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


@pytest.mark.parametrize(
    "code, name",
    [
        (None, None),
        (sqlite3.SQLITE_IOERR, "SQLITE_IOERR"),
        (sqlite3.SQLITE_READONLY_DBMOVED, "SQLITE_READONLY_DBMOVED"),
    ],
)
def test_terminal_failure_reports_metadata_without_replacing_the_exception(
    tmp_path: Path, code: int | None, name: str | None
) -> None:
    clock = _Clock()
    error = sqlite3.OperationalError("private diagnostic input")
    if code is not None:
        vars(error).update(sqlite_errorcode=code, sqlite_errorname=name)
    error.add_note("existing note")
    cause = ValueError("original cause")
    attempts = 0

    def step() -> None:
        nonlocal attempts
        attempts += 1
        clock.now += 0.125
        raise error from cause

    with closing(sqlite3.connect(tmp_path / "private-path.db")) as real:
        with pytest.raises(sqlite3.OperationalError) as caught:
            retry_transient(real, step, monotonic=clock.monotonic, sleep=clock.sleep)
        assert real.execute("SELECT 1").fetchone() == (1,)
    assert caught.value is error
    assert caught.value.__cause__ is cause
    assert caught.value.__notes__[0] == "existing note"
    note = caught.value.__notes__[1]
    assert f"sqlite_errorcode={code}" in note
    assert f"sqlite_errorname={name}" in note
    assert f"sqlite_version={sqlite3.sqlite_version}" in note
    assert "attempts=1" in note
    assert "elapsed_sec=0.125000" in note
    assert "terminal_reason=not_transient" in note
    assert "private" not in note
    assert attempts == 1
    assert clock.slept == []
    traceback = caught.value.__traceback__
    assert traceback is not None
    while traceback.tb_next is not None:
        traceback = traceback.tb_next
    assert traceback.tb_frame.f_code is step.__code__


def test_deadline_note_describes_the_terminal_attempt(tmp_path: Path) -> None:
    clock = _Clock()
    errors = [
        _error("database is locked", sqlite3.SQLITE_BUSY),
        _error("attempt to write a readonly database", sqlite3.SQLITE_READONLY_RECOVERY),
    ]
    vars(errors[-1]).update(sqlite_errorname="SQLITE_READONLY_RECOVERY")
    attempts = 0

    def step() -> None:
        nonlocal attempts
        error = errors[min(attempts, 1)]
        attempts += 1
        raise error

    queries: list[str] = []
    with closing(sqlite3.connect(tmp_path / "fresh.db")) as real:
        real.set_trace_callback(queries.append)
        with pytest.raises(sqlite3.OperationalError) as caught:
            retry_transient(
                real,
                step,
                timeout_sec=0.5,
                retry_sec=0.25,
                monotonic=clock.monotonic,
                sleep=clock.sleep,
            )
        assert real.execute("SELECT 1").fetchone() == (1,)
    assert caught.value is errors[-1]
    assert not hasattr(errors[0], "__notes__")
    assert len(caught.value.__notes__) == 1
    note = caught.value.__notes__[0]
    assert f"sqlite_errorcode={sqlite3.SQLITE_READONLY_RECOVERY}" in note
    assert "sqlite_errorname=SQLITE_READONLY_RECOVERY" in note
    assert f"sqlite_version={sqlite3.sqlite_version}" in note
    assert "attempts=3" in note
    assert "elapsed_sec=0.500000" in note
    assert "terminal_reason=deadline" in note
    assert attempts == 3
    assert clock.slept == [0.25, 0.25]
    assert queries.count("PRAGMA database_list") == 2


def test_success_after_a_transient_failure_does_not_add_a_note(tmp_path: Path) -> None:
    clock = _Clock()
    error = _error("database is locked", sqlite3.SQLITE_BUSY)
    attempts = 0

    def step() -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise error

    with closing(sqlite3.connect(tmp_path / "fresh.db")) as real:
        retry_transient(real, step, monotonic=clock.monotonic, sleep=clock.sleep)
    assert attempts == 2
    assert clock.slept == [0.05]
    assert not hasattr(error, "__notes__")


@pytest.mark.parametrize("during_sleep", [False, True])
def test_retry_does_not_swallow_cancellation(tmp_path: Path, during_sleep: bool) -> None:
    clock = _Clock()
    cancelled = KeyboardInterrupt()
    error = _error("database is locked", sqlite3.SQLITE_BUSY)

    def step() -> None:
        if during_sleep:
            raise error
        raise cancelled

    def sleep(_seconds: float) -> None:
        raise cancelled

    with closing(sqlite3.connect(tmp_path / "fresh.db")) as real:
        with pytest.raises(KeyboardInterrupt) as caught:
            retry_transient(real, step, monotonic=clock.monotonic, sleep=sleep)
        assert real.execute("SELECT 1").fetchone() == (1,)
    assert caught.value is cancelled
    assert not hasattr(cancelled, "__notes__")
    assert not hasattr(error, "__notes__")


def test_a_readonly_file_refusal_is_reported_without_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = _Clock()
    error = _error("attempt to write a readonly database", sqlite3.SQLITE_READONLY)
    attempts = 0

    def step() -> None:
        nonlocal attempts
        attempts += 1
        raise error

    monkeypatch.setattr("podcast_mcp.util.sqlite_wal.os.access", lambda _path, _mode: False)
    with closing(sqlite3.connect(tmp_path / "fresh.db")) as real:
        with pytest.raises(sqlite3.OperationalError) as caught:
            retry_transient(real, step, monotonic=clock.monotonic, sleep=clock.sleep)
    assert caught.value is error
    assert "terminal_reason=not_transient" in error.__notes__[0]
    assert "attempts=1" in error.__notes__[0]
    assert attempts == 1
    assert clock.slept == []


def test_deadline_elapsed_includes_the_failed_step(tmp_path: Path) -> None:
    clock = _Clock()
    error = _error("database is locked", sqlite3.SQLITE_BUSY)

    def step() -> None:
        clock.now += 0.75
        raise error

    with closing(sqlite3.connect(tmp_path / "fresh.db")) as real:
        with pytest.raises(sqlite3.OperationalError) as caught:
            retry_transient(
                real,
                step,
                timeout_sec=0.5,
                monotonic=clock.monotonic,
                sleep=clock.sleep,
            )
    assert caught.value is error
    assert "terminal_reason=deadline" in error.__notes__[0]
    assert "attempts=1" in error.__notes__[0]
    assert "elapsed_sec=0.750000" in error.__notes__[0]
    assert clock.slept == []
