from __future__ import annotations

import multiprocessing
import sqlite3
import sys
import time
import traceback
from contextlib import closing
from multiprocessing.connection import Connection, wait
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

import pytest

from podcast_mcp.services.collaboration.share_registry import SqliteShareRegistry
from podcast_mcp.services.session_sync import sqlite as session_sqlite
from podcast_mcp.util import sqlite_open
from process_helpers import reap
from test_share_registry import _share_template
from test_share_registry_recovery import ProbeConnection


def _observe_registry_actors(
    processes: list[BaseProcess], receivers: list[Connection], timeout: float
) -> list[Any]:
    results: list[Any] = [None] * len(processes)
    phases = ["entry unobserved"] * len(processes)
    pending = set(range(len(processes)))
    deadline = time.monotonic() + timeout

    def diagnostic(index: int, reason: str) -> str:
        process = processes[index]
        return (
            f"actor {index} PID {process.pid} exitcode={process.exitcode}: {reason}; "
            f"last observed phase={phases[index]}"
        )

    while pending:
        remaining = deadline - time.monotonic()
        ready = (
            wait(
                [receivers[i] for i in pending] + [processes[i].sentinel for i in pending],
                timeout=remaining,
            )
            if remaining > 0
            else []
        )
        if not ready:
            raise AssertionError(
                "; ".join(diagnostic(i, "result deadline expired") for i in sorted(pending))
            )
        for index in sorted(pending):
            receiver = receivers[index]
            while True:
                try:
                    if not receiver.poll():
                        break
                    message = receiver.recv()
                except (EOFError, BrokenPipeError) as exc:
                    if isinstance(exc, BrokenPipeError) and getattr(exc, "winerror", None) != 109:
                        raise
                    if results[index] is None:
                        raise AssertionError(diagnostic(index, "EOF without result")) from None
                    break
                if not isinstance(message, tuple) or len(message) != 2:
                    raise AssertionError(diagnostic(index, "invalid report envelope"))
                tag, payload = message
                if tag == "progress" and isinstance(payload, str):
                    phases[index] = payload
                elif tag == "result" and isinstance(payload, tuple) and len(payload) == 3:
                    if results[index] is not None:
                        raise AssertionError(diagnostic(index, "duplicate result"))
                    if payload[0] == "error":
                        if not isinstance(payload[1], str) or not isinstance(payload[2], str):
                            raise AssertionError(diagnostic(index, "invalid error report"))
                        raise AssertionError(diagnostic(index, f"{payload[1]}: {payload[2]}"))
                    if payload[0] != "ok":
                        raise AssertionError(diagnostic(index, "invalid result status"))
                    results[index] = payload
                    phases[index] = "result received"
                else:
                    raise AssertionError(diagnostic(index, "invalid report envelope"))
            if results[index] is not None:
                pending.remove(index)
            elif processes[index].sentinel in ready:
                processes[index].join(timeout=0)
                raise AssertionError(diagnostic(index, "exited without result"))
    return results


def _join_registry_actor(process: BaseProcess, index: int) -> None:
    process.join(timeout=20)
    assert process.exitcode == 0, (
        f"actor {index} PID {process.pid} exitcode={process.exitcode}: "
        "clean exit required; last observed phase at result=result received"
    )


def _cleanup_registry_actors(started: list[BaseProcess], endpoints: list[Connection]) -> None:
    initiating_failure = sys.exception()
    cleanup_failure = None
    for process in started:
        try:
            reap(process, timeout=0)
            process.close()
        except BaseException as exc:
            cleanup_failure = cleanup_failure or exc
    for endpoint in endpoints:
        try:
            endpoint.close()
        except BaseException as exc:
            cleanup_failure = cleanup_failure or exc
    if cleanup_failure is not None:
        if initiating_failure is None:
            raise cleanup_failure
        initiating_failure.add_note(
            f"Actor cleanup failed: {type(cleanup_failure).__name__}: {cleanup_failure}"
        )


def _exit_without_result(sender: Connection) -> None:
    sender.close()


def test_registry_cleanup_retains_secondary_failure_with_primary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    receiver, sender = multiprocessing.Pipe(duplex=False)
    original = RuntimeError("original observation failure")

    def fail_close(connection: Connection) -> None:
        raise OSError("controlled endpoint close failure")

    try:
        with monkeypatch.context() as patch_close:
            patch_close.setattr(type(receiver), "close", fail_close)
            with pytest.raises(RuntimeError) as caught:
                try:
                    raise original
                finally:
                    _cleanup_registry_actors([], [receiver])
        assert caught.value is original
        assert getattr(original, "__notes__", []) == [
            "Actor cleanup failed: OSError: controlled endpoint close failure"
        ]
    finally:
        receiver.close()
        sender.close()


@pytest.mark.parametrize("closed_poll", [False, True])
def test_registry_observer_identifies_exit_without_result(
    monkeypatch: pytest.MonkeyPatch, closed_poll: bool
) -> None:
    ctx = multiprocessing.get_context("spawn")
    receiver, sender = ctx.Pipe(duplex=False)
    process = ctx.Process(target=_exit_without_result, args=(sender,))
    try:
        process.start()
        sender.close()
        if closed_poll:
            process.join(timeout=5)
            assert process.exitcode == 0
            closure = BrokenPipeError("The pipe has been ended")
            closure.winerror = 109

            def poll_closed(connection: Connection, timeout: float = 0.0) -> bool:
                raise closure

            monkeypatch.setattr(type(receiver), "poll", poll_closed)
        with pytest.raises(
            AssertionError, match=rf"actor 0 PID {process.pid}.*last observed phase"
        ):
            _observe_registry_actors([process], [receiver], timeout=5)
    finally:
        _cleanup_registry_actors([process] if process.pid else [], [receiver, sender])


def _stalled_registry_report(sender: Connection, entered: Any) -> None:
    stall = multiprocessing.Event()
    try:
        sender.send(("progress", "target entered"))
        entered.set()
        stall.wait()
    finally:
        sender.close()


def _failed_registry_report(sender: Connection, entered: Any) -> None:
    try:
        sender.send(("progress", "reading registry state"))
        sender.send(("result", ("error", "RuntimeError", "controlled state read failure")))
        entered.set()
    finally:
        sender.close()


def _completed_registry_report(sender: Connection, label: str, exitcode: int) -> None:
    try:
        sender.send(("result", ("ok", label, b"private-control-secret")))
    finally:
        sender.close()
    raise SystemExit(exitcode)


@pytest.mark.parametrize(
    ("target", "phase", "reason"),
    [
        (_stalled_registry_report, "target entered", "result deadline expired"),
        (
            _failed_registry_report,
            "reading registry state",
            "RuntimeError: controlled state read failure",
        ),
    ],
)
def test_registry_observer_attributes_live_stall_and_explicit_error(
    target: Any, phase: str, reason: str
) -> None:
    ctx = multiprocessing.get_context("spawn")
    pipes = [ctx.Pipe(duplex=False) for _ in range(2)]
    entered = ctx.Event()
    processes = [
        ctx.Process(target=_completed_registry_report, args=(pipes[0][1], "first", 0)),
        ctx.Process(target=target, args=(pipes[1][1], entered)),
    ]
    started = []
    try:
        for process, (_, sender) in zip(processes, pipes, strict=True):
            process.start()
            started.append(process)
            sender.close()
        assert entered.wait(timeout=5)
        with pytest.raises(AssertionError) as caught:
            _observe_registry_actors(processes, [r for r, _ in pipes], timeout=0.2)
        message = str(caught.value)
        assert f"actor 1 PID {processes[1].pid} exitcode=" in message
        assert reason in message
        assert f"last observed phase={phase}" in message
        assert "private-control-secret" not in message
        assert "first" not in message
    finally:
        _cleanup_registry_actors(started, [endpoint for pipe in pipes for endpoint in pipe])


@pytest.mark.parametrize("exitcode", [0, 7])
def test_registry_result_arrival_preserves_order_and_requires_clean_exit(exitcode: int) -> None:
    ctx = multiprocessing.get_context("spawn")
    pipes = [ctx.Pipe(duplex=False) for _ in range(2)]
    processes = [
        ctx.Process(target=_completed_registry_report, args=(sender, str(index), exitcode))
        for index, (_, sender) in enumerate(pipes)
    ]
    started = []
    try:
        for process, (_, sender) in zip(processes, pipes, strict=True):
            process.start()
            started.append(process)
            sender.close()
        for process in processes:
            process.join(timeout=5)
            assert process.exitcode == exitcode
        results = _observe_registry_actors(processes, [r for r, _ in pipes], timeout=5)
        assert results == [
            ("ok", "0", b"private-control-secret"),
            ("ok", "1", b"private-control-secret"),
        ]
        for index, process in enumerate(processes):
            if exitcode:
                with pytest.raises(AssertionError) as caught:
                    _join_registry_actor(process, index)
                assert f"actor {index} PID {process.pid} exitcode=7" in str(caught.value)
                assert "last observed phase at result=result received" in str(caught.value)
                assert "private-control-secret" not in str(caught.value)
            else:
                _join_registry_actor(process, index)
    finally:
        _cleanup_registry_actors(started, [endpoint for pipe in pipes for endpoint in pipe])


@pytest.mark.parametrize("mutation", ["claim", "release", "demote"])
def test_failed_token_commit_and_rollback_quarantines_pending_state_and_recovers(
    tmp_path: Path, mutation: str
) -> None:
    path = tmp_path / "registry.db"
    registry = SqliteShareRegistry(path)
    try:
        secret = registry.recording_key_secret()
        registry.claim_active(_share_template(token="durable-token", id="durable-id"))
        poisoned = ProbeConnection(str(path), isolation_level=None)
        poisoned.row_factory = sqlite3.Row
        registry._conn.close()
        registry._conn = poisoned
        failure = sqlite3.OperationalError("commit failed")
        poisoned.failures["COMMIT"] = failure
        poisoned.failures["ROLLBACK"] = sqlite3.OperationalError("rollback failed")
        with pytest.raises(sqlite3.OperationalError) as caught:
            if mutation == "claim":
                registry.claim_active(_share_template(token="uncommitted-token", id="ghost-id"))
            elif mutation == "release":
                registry.release_claim("durable-token")
            else:
                registry.demote_to_cooldown("durable-token", reason="revoked")
        assert caught.value is failure
        with closing(sqlite3.connect(path)) as observer:
            assert observer.execute("SELECT token, id FROM active_shares").fetchall() == [
                ("durable-token", "durable-id")
            ]
            assert (
                observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
        assert registry.get_active("uncommitted-token") is None
        durable_row = registry.get_active("durable-token")
        assert durable_row is not None and durable_row["id"] == "durable-id"
        assert registry.recording_key_secret() == secret
        registry.claim_active(_share_template(token="after-recovery", id="future-id"))
        with closing(sqlite3.connect(path)) as observer:
            assert observer.execute(
                "SELECT token, id FROM active_shares ORDER BY token"
            ).fetchall() == [("after-recovery", "future-id"), ("durable-token", "durable-id")]
        fresh = SqliteShareRegistry(path)
        try:
            assert fresh.recording_key_secret() == secret
            assert fresh.get_active("after-recovery")["id"] == "future-id"
        finally:
            fresh.close()
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            poisoned.execute("SELECT 1")
    finally:
        registry.close()


def _construction_actor(path: str, barrier: Any, sender: Connection) -> None:
    try:
        sender.send(("progress", "target entered"))
        _run_construction_actor(path, barrier, sender)
    finally:
        sender.close()


def _run_construction_actor(path: str, barrier: Any, sender: Connection) -> None:
    connect = sqlite3.connect

    class SchemaRaceConnection(sqlite3.Connection):
        met = False

        def executescript(self, sql_script: str) -> sqlite3.Cursor:
            # The setup retries a busy answer; only the first attempt meets the other actor.
            if not SchemaRaceConnection.met:
                SchemaRaceConnection.met = True
                barrier.wait(timeout=15)
            return super().executescript(sql_script)

    def open_connection(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        return connect(*args, **kwargs, factory=SchemaRaceConnection)

    registry = None
    try:
        try:
            sender.send(("progress", "constructing registry"))
            with patch(
                "podcast_mcp.services.collaboration.share_registry.sqlite3.connect", open_connection
            ):
                registry = SqliteShareRegistry(Path(path))
            sender.send(("progress", "reading registry state"))
            secret = registry.recording_key_secret()
            sender.send(("progress", "reporting result"))
            sender.send(("result", ("ok", secret, None)))
        except BaseException as exc:
            sender.send(
                (
                    "result",
                    (
                        "error",
                        type(exc).__name__,
                        "\n".join(
                            (
                                str(exc),
                                f"sqlite_errorcode={getattr(exc, 'sqlite_errorcode', None)}",
                                f"sqlite_errorname={getattr(exc, 'sqlite_errorname', None)}",
                                "".join(traceback.format_exception(exc)),
                            )
                        ),
                    ),
                )
            )
    finally:
        if registry:
            try:
                sender.send(("progress", "closing registry"))
            finally:
                registry.close()


def test_concurrent_registry_construction_shares_one_schema_and_secret(tmp_path: Path) -> None:
    path = tmp_path / "registry.db"
    ctx = multiprocessing.get_context("spawn")
    barrier = ctx.Barrier(2)
    pipes = [ctx.Pipe(duplex=False) for _ in range(2)]
    processes = [
        ctx.Process(target=_construction_actor, args=(str(path), barrier, sender))
        for _, sender in pipes
    ]
    started = []
    try:
        for process, (_, sender) in zip(processes, pipes, strict=True):
            process.start()
            started.append(process)
            sender.close()
        results = _observe_registry_actors(
            processes, [receiver for receiver, _ in pipes], timeout=20
        )
        for index, process in enumerate(processes):
            _join_registry_actor(process, index)
        assert [r[0] for r in results] == ["ok", "ok"]
        secrets_seen = {r[1] for r in results}
        assert len(secrets_seen) == 1 and len(next(iter(secrets_seen))) == 32
        with closing(sqlite3.connect(path)) as observer:
            assert observer.execute("SELECT secret FROM recording_key_secret").fetchone()[
                0
            ] == next(iter(secrets_seen))
        registry = SqliteShareRegistry(path)
        try:
            registry.claim_active(_share_template(token="after-race", id="after-race-id"))
            assert registry.get_active("after-race") is not None
        finally:
            registry.close()
    finally:
        _cleanup_registry_actors(started, [endpoint for pipe in pipes for endpoint in pipe])


def test_construction_actor_reports_sqlite_cause_to_parent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sqlite_error = sqlite3.OperationalError("distinctive readonly failure")
    sqlite_error.sqlite_errorcode = 1032
    sqlite_error.sqlite_errorname = "SQLITE_READONLY_DBMOVED"
    sqlite_error.add_note("controlled SQLite actor diagnostic")

    def fail_construction(path: Path) -> None:
        cause = ValueError("controlled lower-level failure")
        raise sqlite_error from cause

    class Sender:
        def __init__(self) -> None:
            self.messages: list[tuple[str, Any]] = []

        def send(self, message: tuple[str, Any]) -> None:
            self.messages.append(message)

        def close(self) -> None:
            return None

    class Receiver:
        def __init__(self, messages: list[tuple[str, Any]]) -> None:
            self.messages = list(messages)

        def poll(self) -> bool:
            return bool(self.messages)

        def recv(self) -> tuple[str, Any]:
            return self.messages.pop(0)

    class Process:
        pid = 17
        exitcode = 0
        sentinel = object()

    sender = Sender()
    monkeypatch.setitem(
        _run_construction_actor.__globals__, "SqliteShareRegistry", fail_construction
    )
    monkeypatch.setitem(
        _observe_registry_actors.__globals__, "wait", lambda objects, timeout: objects
    )

    _construction_actor("unused.db", None, cast(Connection, sender))

    with pytest.raises(AssertionError) as caught:
        _observe_registry_actors(
            cast(list[BaseProcess], [Process()]),
            cast(list[Connection], [Receiver(sender.messages)]),
            timeout=1,
        )

    diagnostic = str(caught.value)
    assert "distinctive readonly failure" in diagnostic
    assert "sqlite_errorcode=1032" in diagnostic
    assert "sqlite_errorname=SQLITE_READONLY_DBMOVED" in diagnostic
    assert "controlled SQLite actor diagnostic" in diagnostic
    assert "controlled lower-level failure" in diagnostic
    assert "fail_construction" in diagnostic


@pytest.mark.parametrize("stage", ["wal_read", "retry_sleep"])
def test_session_wal_interrupt_closes_real_connection_and_propagates_interrupt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str
) -> None:
    original_connect = sqlite3.connect
    interrupt = KeyboardInterrupt("cancel session initialization")
    opened = []

    def open_connection(*args: Any, **kwargs: Any) -> ProbeConnection:
        connection = original_connect(*args, **kwargs, factory=ProbeConnection)
        connection.failures["PRAGMA journal_mode"] = (
            interrupt if stage == "wal_read" else sqlite3.OperationalError("database is locked")
        )
        opened.append(connection)
        return connection

    def interrupt_sleep(seconds: float) -> None:
        raise interrupt

    monkeypatch.setattr(session_sqlite.sqlite3, "connect", open_connection)
    if stage == "retry_sleep":
        monkeypatch.setattr(sqlite_open.time, "sleep", interrupt_sleep)
    try:
        with pytest.raises(KeyboardInterrupt) as caught:
            session_sqlite.connect_session_db(tmp_path / "session.db")
        assert caught.value is interrupt
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            opened[0].execute("SELECT 1")
    finally:
        for connection in opened:
            connection.close()


def test_secret_rollback_interrupt_propagates_with_original_commit_context_and_closes_owner(
    tmp_path: Path,
) -> None:
    path = tmp_path / "registry.db"
    registry = SqliteShareRegistry(path)
    poisoned = ProbeConnection(str(path), isolation_level=None)
    poisoned.row_factory = sqlite3.Row
    registry._conn.close()
    registry._conn = poisoned
    original = sqlite3.OperationalError("original commit failure")
    interrupt = KeyboardInterrupt("rollback cancelled")
    poisoned.failures["COMMIT"] = original
    poisoned.failures["ROLLBACK"] = interrupt
    try:
        with pytest.raises(KeyboardInterrupt) as caught:
            registry.recording_key_secret()
        assert caught.value is interrupt
        assert caught.value.__context__ is original
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            poisoned.execute("SELECT 1")
        with closing(sqlite3.connect(path)) as observer:
            assert observer.execute("SELECT secret FROM recording_key_secret").fetchall() == []
        secret = registry.recording_key_secret()
        assert isinstance(secret, bytes) and len(secret) == 32
        with closing(sqlite3.connect(path)) as observer:
            assert (
                observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
    finally:
        registry.close()


def test_registry_rollback_cancellation_closes_owner_and_retains_commit_context(tmp_path):
    registry = SqliteShareRegistry(tmp_path / "registry.db")
    try:
        secret = registry.recording_key_secret()
        registry.claim_active(_share_template(token="durable-token"))
        registry._conn.close()
        poisoned = ProbeConnection(str(registry.db_path), isolation_level=None)
        poisoned.row_factory = sqlite3.Row
        registry._conn = poisoned
        original = sqlite3.OperationalError("commit failed")
        cancellation = KeyboardInterrupt()
        poisoned.failures["COMMIT"] = original
        poisoned.failures["ROLLBACK"] = cancellation
        with pytest.raises(KeyboardInterrupt) as caught:
            registry.release_claim("durable-token")
        assert caught.value is cancellation
        assert caught.value.__context__ is original
        assert poisoned.closed
        assert registry.get_active("durable-token") is not None
        assert registry.recording_key_secret() == secret
        assert registry.release_claim("durable-token")
        with closing(sqlite3.connect(registry.db_path)) as observer:
            assert observer.execute("SELECT token FROM active_shares").fetchall() == []
    finally:
        registry.close()
