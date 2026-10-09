"""Disposable registry proofs for private backups and failed initialization."""

from __future__ import annotations

import multiprocessing
import os
import sqlite3
import stat
from collections.abc import Callable
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.edits import share_registry


class ProbeConnection(sqlite3.Connection):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.failures: dict[str, BaseException] = {}
        self.closed = False
        self.before_backup: Callable[[sqlite3.Connection], None] | None = None
        self.on_busy: Callable[[], None] | None = None
        self.busy_count = 0

    def execute(self, sql: str, *args: Any, **kwargs: Any) -> sqlite3.Cursor:
        if sql in self.failures:
            raise self.failures[sql]
        try:
            return super().execute(sql, *args, **kwargs)
        except sqlite3.OperationalError as exc:
            if "locked" in str(exc):
                self.busy_count += 1
                if self.on_busy:
                    self.on_busy()
            raise

    def executescript(self, sql: str, /) -> sqlite3.Cursor:
        if "schema" in self.failures:
            raise self.failures["schema"]
        return super().executescript(sql)

    def backup(self, target: sqlite3.Connection, **kwargs: Any) -> None:
        if self.before_backup:
            self.before_backup(target)
        super().backup(target, **kwargs)

    def close(self) -> None:
        self.closed = True
        super().close()


@pytest.fixture
def connections(monkeypatch: pytest.MonkeyPatch) -> list[ProbeConnection]:
    opened: list[ProbeConnection] = []
    connect = sqlite3.connect

    def open_probe(*args: Any, **kwargs: Any) -> ProbeConnection:
        connection = connect(*args, **kwargs, factory=ProbeConnection)
        opened.append(connection)
        return connection

    monkeypatch.setattr(share_registry.sqlite3, "connect", open_probe)
    yield opened
    for connection in opened:
        connection.close()


@pytest.mark.parametrize("existing", [False, True])
def test_backup_is_private_during_copy_and_replaces_inode(
    tmp_path: Path, connections: list[ProbeConnection], existing: bool
) -> None:
    registry = share_registry.SqliteShareRegistry(tmp_path / "owner" / "registry.db")
    secret = registry.recording_key_secret()
    destination = tmp_path / "public" / "backup.db"
    destination.parent.mkdir()
    old = b"previous readable backup"
    if existing:
        destination.write_bytes(old)
        destination.chmod(0o644)
    held = destination.open("rb") if existing else None
    copied_paths: list[Path] = []

    def inspect(target: sqlite3.Connection) -> None:
        path = Path(target.execute("PRAGMA database_list").fetchone()[2])
        copied_paths.append(path)
        assert path.parent == destination.parent
        assert path != destination
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert destination.read_bytes() == old if existing else not destination.exists()

    connections[0].before_backup = inspect
    previous_umask = os.umask(0o022)
    try:
        assert registry.backup_to(destination) == destination.resolve()
        assert stat.S_IMODE(destination.stat().st_mode) == 0o600
        if held:
            assert held.read() == old
        with closing(sqlite3.connect(destination)) as restored:
            assert (
                restored.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
        assert not copied_paths[0].exists()
        assert list(destination.parent.iterdir()) == [destination]
    finally:
        os.umask(previous_umask)
        if held:
            held.close()
        registry.close()


@pytest.mark.parametrize("failure", [OSError("copy failed"), KeyboardInterrupt()])
def test_backup_failure_preserves_destination_and_cleans_temporary_file(
    tmp_path: Path, connections: list[ProbeConnection], failure: BaseException
) -> None:
    registry = share_registry.SqliteShareRegistry(tmp_path / "owner" / "registry.db")
    registry.recording_key_secret()
    destination = tmp_path / "copies" / "backup.db"
    destination.parent.mkdir()
    destination.write_bytes(b"original")

    def fail_after_copy(target: sqlite3.Connection) -> None:
        sqlite3.Connection.backup(connections[0], target)
        raise failure

    connections[0].before_backup = fail_after_copy
    with pytest.raises(type(failure)) as caught:
        registry.backup_to(destination)
    assert caught.value is failure
    assert destination.read_bytes() == b"original"
    assert list(destination.parent.iterdir()) == [destination]
    assert connections[-1].closed


@pytest.mark.parametrize(
    "stage", ["PRAGMA journal_mode=WAL", "PRAGMA synchronous=NORMAL", "schema", "columns"]
)
@pytest.mark.parametrize(
    "failure", [sqlite3.OperationalError("disk I/O error"), KeyboardInterrupt()]
)
def test_constructor_failure_closes_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str, failure: BaseException
) -> None:
    connect = sqlite3.connect
    opened: list[ProbeConnection] = []

    def faulty_connect(*args: Any, **kwargs: Any) -> ProbeConnection:
        connection = connect(*args, **kwargs, factory=ProbeConnection)
        connection.failures[stage] = failure
        opened.append(connection)
        return connection

    monkeypatch.setattr(share_registry.sqlite3, "connect", faulty_connect)
    if stage == "columns":

        def fail_columns(*args: Any) -> None:
            raise failure

        monkeypatch.setattr(share_registry, "_ensure_columns", fail_columns)
    try:
        with pytest.raises(type(failure)) as caught:
            share_registry.SqliteShareRegistry(tmp_path / "registry.db")
        assert caught.value is failure
        assert opened[0].closed
    finally:
        for connection in opened:
            connection.close()


@pytest.mark.parametrize("stage", ["generation", "insertion", "COMMIT"])
@pytest.mark.parametrize("rollback_fails", [False, True])
def test_failed_secret_transaction_never_serves_uncommitted_value_and_can_retry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    connections: list[ProbeConnection],
    stage: str,
    rollback_fails: bool,
) -> None:
    registry = share_registry.SqliteShareRegistry(tmp_path / "registry.db")
    poisoned = connections[0]
    original = (
        KeyboardInterrupt() if stage == "generation" else sqlite3.OperationalError("commit failed")
    )
    generated = b"x" * 32
    durable = b"y" * 32
    if rollback_fails:
        poisoned.failures["ROLLBACK"] = sqlite3.OperationalError("rollback failed")
    if stage == "COMMIT":
        poisoned.failures[stage] = original
    elif stage == "insertion":
        poisoned.failures["INSERT INTO recording_key_secret (singleton, secret) VALUES (1, ?)"] = (
            original
        )
    with monkeypatch.context() as scope:
        if stage == "generation":

            def fail_entropy(size: int) -> bytes:
                raise original

            scope.setattr(share_registry.secrets, "token_bytes", fail_entropy)
        else:
            scope.setattr(share_registry.secrets, "token_bytes", lambda size: generated)
        with pytest.raises(type(original)) as caught:
            registry.recording_key_secret()
        assert caught.value is original
    try:
        if rollback_fails:
            assert poisoned.closed
        with closing(sqlite3.connect(registry.db_path)) as observer:
            assert observer.execute("SELECT secret FROM recording_key_secret").fetchall() == []
        monkeypatch.setattr(share_registry.secrets, "token_bytes", lambda size: durable)
        assert registry.recording_key_secret() == durable
        registry.close()
        reopened = share_registry.SqliteShareRegistry(registry.db_path)
        try:
            assert reopened.recording_key_secret() == durable
        finally:
            reopened.close()
    finally:
        registry.close()


def _hold_delete_mode_writer(path: str, ready: Any, release: Any) -> None:
    connection = sqlite3.connect(path, isolation_level=None)
    try:
        connection.execute("CREATE TABLE seed (id INTEGER)")
        connection.execute("BEGIN IMMEDIATE")
        ready.set()
        release.wait(20)
        connection.execute("ROLLBACK")
    finally:
        connection.close()


@pytest.mark.parametrize("release_on_busy", [True, False])
def test_constructor_retries_real_process_wal_contention_and_bounds_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    connections: list[ProbeConnection],
    release_on_busy: bool,
) -> None:
    path = tmp_path / "registry.db"
    ctx = multiprocessing.get_context("spawn")
    ready, release = ctx.Event(), ctx.Event()
    worker = ctx.Process(target=_hold_delete_mode_writer, args=(str(path), ready, release))
    worker.start()
    connect = share_registry.sqlite3.connect
    ticks = iter([0.0, 11.0])

    def observed_connect(*args: Any, **kwargs: Any) -> ProbeConnection:
        connection = connect(*args, **kwargs)
        if release_on_busy:

            def release_writer() -> None:
                release.set()
                worker.join(10)
                assert worker.exitcode == 0

            connection.on_busy = release_writer
        return connection

    monkeypatch.setattr(share_registry.sqlite3, "connect", observed_connect)
    try:
        assert ready.wait(10)
        if release_on_busy:
            registry = share_registry.SqliteShareRegistry(path)
            try:
                secret = registry.recording_key_secret()
                assert len(secret) == 32
                assert connections[0].busy_count >= 1
                assert connections[0].execute("PRAGMA busy_timeout").fetchone()[0] == 5000
            finally:
                registry.close()
        else:
            with monkeypatch.context() as clock:
                clock.setattr("time.monotonic", lambda: next(ticks))
                with pytest.raises(sqlite3.OperationalError, match="locked"):
                    share_registry.SqliteShareRegistry(path)
            assert connections[0].closed
            assert connections[0].busy_count == 1
    finally:
        release.set()
        worker.join(10)
        if worker.is_alive():
            worker.terminate()
            worker.join()
        worker.close()


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits")
def test_disposable_registry_parent_database_and_live_wal_modes(tmp_path: Path) -> None:
    path = tmp_path / "private" / "registry.db"
    previous_umask = os.umask(0o022)
    registry = None
    try:
        registry = share_registry.SqliteShareRegistry(path)
        assert len(registry.recording_key_secret()) == 32
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(path) + suffix)
            assert sidecar.exists()
            assert stat.S_IMODE(sidecar.stat().st_mode) & 0o077 == 0
    finally:
        if registry:
            registry.close()
        os.umask(previous_umask)


def test_existing_readable_backup_descriptor_never_receives_new_secret(
    tmp_path: Path, connections: list[ProbeConnection]
) -> None:
    registry = share_registry.SqliteShareRegistry(tmp_path / "owner" / "registry.db")
    secret = registry.recording_key_secret()
    destination = tmp_path / "copies" / "backup.db"
    destination.parent.mkdir()
    destination.write_bytes(b"old readable contents")
    destination.chmod(0o644)
    with destination.open("rb") as held:
        registry.backup_to(destination)
        assert held.read() == b"old readable contents"
    with closing(sqlite3.connect(destination)) as observer:
        assert observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret


def test_secret_reopen_failure_closes_new_connection_and_later_retry_is_durable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, connections: list[ProbeConnection]
) -> None:
    registry = share_registry.SqliteShareRegistry(tmp_path / "registry.db")
    connections[0].failures["COMMIT"] = sqlite3.OperationalError("commit failed")
    connections[0].failures["ROLLBACK"] = sqlite3.OperationalError("rollback failed")
    with pytest.raises(sqlite3.OperationalError, match="commit failed"):
        registry.recording_key_secret()
    connect = share_registry.sqlite3.connect
    failure = KeyboardInterrupt()

    def fail_reopen(*args: Any, **kwargs: Any) -> ProbeConnection:
        connection = connect(*args, **kwargs)
        connection.failures["schema"] = failure
        return connection

    with monkeypatch.context() as scope:
        scope.setattr(share_registry.sqlite3, "connect", fail_reopen)
        with pytest.raises(KeyboardInterrupt) as caught:
            registry.recording_key_secret()
        assert caught.value is failure
        assert connections[-1].closed
    try:
        secret = registry.recording_key_secret()
        with closing(sqlite3.connect(registry.db_path)) as observer:
            assert (
                observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
    finally:
        registry.close()


def test_backups_use_distinct_temporary_paths(
    tmp_path: Path, connections: list[ProbeConnection]
) -> None:
    registry = share_registry.SqliteShareRegistry(tmp_path / "owner" / "registry.db")
    secret = registry.recording_key_secret()
    paths: list[str] = []

    def inspect(target: sqlite3.Connection) -> None:
        paths.append(target.execute("PRAGMA database_list").fetchone()[2])

    connections[0].before_backup = inspect
    destination = tmp_path / "copies" / "backup.db"
    try:
        registry.backup_to(destination)
        registry.backup_to(destination)
        assert len(set(paths)) == 2
        assert all(not Path(path).exists() for path in paths)
        with closing(sqlite3.connect(destination)) as observer:
            assert (
                observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
    finally:
        registry.close()


@pytest.mark.parametrize("failure", [RuntimeError("barrier failed"), KeyboardInterrupt()])
def test_secret_worker_closes_registry_when_barrier_fails(
    tmp_path: Path, connections: list[ProbeConnection], failure: BaseException
) -> None:
    from test_share_registry import _registry_secret_process

    class FailedBarrier:
        def wait(self, *, timeout: int) -> None:
            raise failure

    class UnusedQueue:
        def put(self, value: bytes) -> None:
            pytest.fail("barrier failure must prevent secret publication")

    path = tmp_path / "registry.db"
    with pytest.raises(type(failure)) as caught:
        _registry_secret_process(str(path), FailedBarrier(), UnusedQueue())
    assert caught.value is failure
    assert connections[0].closed
    with closing(sqlite3.connect(path)) as observer:
        assert observer.execute("SELECT secret FROM recording_key_secret").fetchall() == []


@pytest.mark.parametrize("entry", ["singleton", "injected"])
@pytest.mark.parametrize("failure_stage", ["entropy", "commit_and_rollback"])
def test_token_lookup_recovers_failed_secret_owner_before_listing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    connections: list[ProbeConnection],
    entry: str,
    failure_stage: str,
) -> None:
    from test_share_registry import _share_template

    registry = (
        share_registry.get_share_registry()
        if entry == "singleton"
        else share_registry.SqliteShareRegistry(tmp_path / "injected.db")
    )
    token = "durable-guest-token"
    registry.claim_active(_share_template(token=token, capabilities=["play", "view", "mcp"]))
    metadata = registry.get_active(token)
    failure = (
        OSError("entropy failed")
        if failure_stage == "entropy"
        else sqlite3.OperationalError("commit failed")
    )
    with monkeypatch.context() as scope:
        if failure_stage == "entropy":

            def fail_entropy(size: int) -> bytes:
                raise failure

            scope.setattr(share_registry.secrets, "token_bytes", fail_entropy)
        else:
            connections[0].failures["COMMIT"] = failure
            connections[0].failures["ROLLBACK"] = sqlite3.OperationalError("rollback failed")
        with pytest.raises(type(failure)) as caught:
            registry.recording_key_secret()
        assert caught.value is failure
    assert connections[0].closed
    with closing(sqlite3.connect(registry.db_path)) as observer:
        assert observer.execute("SELECT token FROM active_shares").fetchone()[0] == token
        assert observer.execute("SELECT secret FROM recording_key_secret").fetchall() == []
    try:
        recovered = share_registry.get_share_registry() if entry == "singleton" else registry
        assert recovered.get_active(token) == metadata
        secret = recovered.recording_key_secret()
        assert isinstance(secret, bytes) and len(secret) == 32
        assert recovered.get_active(token) == metadata
        with closing(sqlite3.connect(registry.db_path)) as observer:
            assert (
                observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
        reopened = share_registry.SqliteShareRegistry(registry.db_path)
        try:
            assert reopened.recording_key_secret() == secret
            assert reopened.get_active(token) == metadata
        finally:
            reopened.close()
    finally:
        registry.close()
