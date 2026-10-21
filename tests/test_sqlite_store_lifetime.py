from __future__ import annotations

import gc
import sqlite3
import subprocess
import sys
import threading
import weakref
from collections.abc import Callable, Iterator
from contextlib import closing
from pathlib import Path
from textwrap import dedent
from typing import Any

import pytest

from podcast_mcp.services.collaboration.share_registry import SqliteShareRegistry
from podcast_mcp.services.record.live_comments import (
    RecordLiveCommentStore,
    cached_record_live_comment_store,
)
from podcast_mcp.services.record.participants import RecordParticipantStore
from podcast_mcp.services.record.upload import RecordUploadStore, cached_record_upload_store
from podcast_mcp.services.session_sync.log import (
    SyncStore,
    cached_store,
    cached_sync_store,
    pin_cached_stores,
)
from podcast_mcp.services.share_auth.store import ShareIdentityStore
from podcast_mcp.util import sqlite_open

Store = (
    SyncStore
    | RecordParticipantStore
    | RecordLiveCommentStore
    | RecordUploadStore
    | ShareIdentityStore
    | SqliteShareRegistry
)

_STORE_TYPES = (
    SyncStore,
    RecordParticipantStore,
    RecordLiveCommentStore,
    RecordUploadStore,
    ShareIdentityStore,
    SqliteShareRegistry,
)


def _cached_participant_store(path: Path) -> RecordParticipantStore:
    store = cached_store(
        path, kind="record_participant", factory=lambda: RecordParticipantStore(path)
    )
    assert store is not None
    return store


_CACHED_STORES = (
    cached_sync_store,
    _cached_participant_store,
    cached_record_live_comment_store,
    cached_record_upload_store,
)


def test_interpreter_exits_with_live_store_lock_held_by_daemon(tmp_path: Path) -> None:
    script = dedent("""
        import sys
        import threading
        from pathlib import Path

        from podcast_mcp.services.session_sync.log import SyncStore

        store = SyncStore(Path(sys.argv[1]))
        held = threading.Event()

        def hold_lock():
            with store._lock:
                held.set()
                threading.Event().wait()

        threading.Thread(target=hold_lock, daemon=True).start()
        assert held.wait(5), "daemon did not acquire the store lock"
        print("live store lock held by daemon", flush=True)
        """)
    try:
        result = subprocess.run(
            [sys.executable, "-c", script, str(tmp_path / "sync.sqlite")],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        pytest.fail(f"interpreter shutdown timed out; stdout={exc.stdout!r}; stderr={exc.stderr!r}")
    diagnostics = f"stdout={result.stdout!r}; stderr={result.stderr!r}"
    assert result.returncode == 0, diagnostics
    assert result.stdout.strip() == "live store lock held by daemon", diagnostics


@pytest.mark.parametrize("store_type", _STORE_TYPES, ids=lambda cls: cls.__name__)
def test_last_store_owner_closes_connection(
    tmp_path: Path, store_type: Callable[[Path], Store]
) -> None:
    store = store_type(tmp_path / "store.sqlite")
    connection = store._conn
    owner = weakref.ref(store)
    try:
        assert connection.execute("SELECT 1").fetchone()[0] == 1
        del store
        gc.collect()
        assert owner() is None
        with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
            connection.execute("SELECT 1")
    finally:
        connection.close()


@pytest.mark.parametrize("factory", _CACHED_STORES, ids=lambda factory: factory.__name__)
def test_cached_connection_stays_open_until_last_consumer_and_pin_release(
    tmp_path: Path, factory: Callable[[Path], Store]
) -> None:
    path = tmp_path / "store.sqlite"
    store = factory(path)
    other = factory(path)
    connection = store._conn
    owner = weakref.ref(store)
    first_pin = pin_cached_stores([path])
    second_pin = pin_cached_stores([path])
    try:
        assert other is store
        del store
        gc.collect()
        assert connection.execute("SELECT 1").fetchone()[0] == 1
        del other
        first_pin.release()
        gc.collect()
        assert owner() is not None
        assert connection.execute("SELECT 1").fetchone()[0] == 1
        second_pin.release()
        gc.collect()
        assert owner() is None
        with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
            connection.execute("SELECT 1")
    finally:
        first_pin.release()
        second_pin.release()
        connection.close()


@pytest.mark.parametrize("store_type", _STORE_TYPES, ids=lambda cls: cls.__name__)
def test_explicit_close_twice_then_owner_collection(
    tmp_path: Path, store_type: Callable[[Path], Store]
) -> None:
    store = store_type(tmp_path / "store.sqlite")
    connection = store._conn
    owner = weakref.ref(store)
    try:
        store.close()
        store.close()
        del store
        gc.collect()
        assert owner() is None
        with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
            connection.execute("SELECT 1")
    finally:
        connection.close()


@pytest.mark.parametrize("store_type", _STORE_TYPES, ids=lambda cls: cls.__name__)
def test_cyclic_store_is_collected_on_another_thread(
    tmp_path: Path, store_type: Callable[[Path], Store]
) -> None:
    store = store_type(tmp_path / "store.sqlite")
    store.__dict__["cycle"] = store
    connection = store._conn
    owner = weakref.ref(store)
    try:
        del store
        worker = threading.Thread(target=gc.collect)
        worker.start()
        worker.join(timeout=5)
        assert not worker.is_alive()
        assert owner() is None
        with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
            connection.execute("SELECT 1")
    finally:
        connection.close()


def test_last_owner_cleanup_rolls_back_pending_work_and_preserves_committed_state(
    tmp_path: Path,
) -> None:
    path = tmp_path / "sync.sqlite"
    store = cached_sync_store(path)
    connection = store._conn
    try:
        connection.execute("CREATE TABLE lifetime_probe (value TEXT)")
        connection.execute("INSERT INTO lifetime_probe VALUES ('committed')")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("INSERT INTO lifetime_probe VALUES ('pending')")
        owner = weakref.ref(store)
        del store
        gc.collect()
        assert owner() is None
        with closing(cached_sync_store(path)) as reopened:
            assert [
                row[0] for row in reopened._conn.execute("SELECT value FROM lifetime_probe")
            ] == ["committed"]
    finally:
        connection.close()


class _FailingConnection(sqlite3.Connection):
    fail_close = False
    fail_commit = False
    fail_migration = False

    def close(self) -> None:
        if self.fail_close:
            self.fail_close = False
            raise sqlite3.OperationalError("close failed")
        super().close()

    def commit(self) -> None:
        if self.fail_commit:
            raise sqlite3.OperationalError("commit failed")
        super().commit()

    def execute(self, sql: str, *args: Any, **kwargs: Any) -> sqlite3.Cursor:
        if self.fail_migration and sql == "PRAGMA table_info(record_upload_files)":
            raise sqlite3.OperationalError("migration failed")
        return super().execute(sql, *args, **kwargs)


@pytest.fixture
def opened_connections(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[_FailingConnection]]:
    opened: list[_FailingConnection] = []
    connect = sqlite3.connect

    def tracked_connect(*args: Any, **kwargs: Any) -> _FailingConnection:
        connection = connect(*args, **kwargs, factory=_FailingConnection)
        opened.append(connection)
        return connection

    monkeypatch.setattr(sqlite3, "connect", tracked_connect)
    yield opened
    for connection in opened:
        connection.fail_close = False
        connection.close()


@pytest.mark.parametrize("retry", [False, True])
def test_failed_explicit_close_preserves_retry_and_lifetime_cleanup(
    tmp_path: Path, opened_connections: list[_FailingConnection], retry: bool
) -> None:
    store = SyncStore(tmp_path / "sync.db")
    connection = opened_connections[0]
    connection.fail_close = True
    with pytest.raises(sqlite3.OperationalError, match="close failed"):
        store.close()
    assert connection.execute("SELECT 1").fetchone()[0] == 1
    if retry:
        store.close()
    owner = weakref.ref(store)
    del store
    gc.collect()
    assert owner() is None
    with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
        connection.execute("SELECT 1")


@pytest.mark.parametrize("store_type", [RecordUploadStore, ShareIdentityStore])
def test_post_open_initialization_failure_closes_connection_promptly(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    opened_connections: list[_FailingConnection],
    store_type: Callable[[Path], Store],
) -> None:
    monkeypatch.setattr(_FailingConnection, "fail_commit", True)
    monkeypatch.setattr(_FailingConnection, "fail_migration", True)
    with pytest.raises(sqlite3.OperationalError, match=r"(commit|migration) failed"):
        store_type(tmp_path / "store.sqlite")
    with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
        opened_connections[0].execute("SELECT 1")


def test_failed_cleanup_registration_closes_acquired_connection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    opened_connections: list[_FailingConnection],
) -> None:
    original = RuntimeError("registration failed")

    def fail_registration(*args: Any, **kwargs: Any) -> None:
        raise original

    monkeypatch.setattr(sqlite_open.weakref, "finalize", fail_registration)
    with pytest.raises(RuntimeError, match="registration failed") as caught:
        SyncStore(tmp_path / "sync.db")
    assert caught.value is original
    with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
        opened_connections[0].execute("SELECT 1")


def test_registry_replacement_retains_cleanup_for_failed_old_close(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, opened_connections: list[_FailingConnection]
) -> None:
    registry = SqliteShareRegistry(tmp_path / "registry.sqlite")
    old = opened_connections[0]
    old.fail_close = True
    original = RuntimeError("entropy unavailable")

    def refuse_entropy(size: int) -> bytes:
        raise original

    with monkeypatch.context() as scope:
        scope.setattr(
            "podcast_mcp.services.collaboration.share_registry.secrets.token_bytes", refuse_entropy
        )
        with pytest.raises(RuntimeError, match="entropy unavailable") as caught:
            registry.recording_key_secret()
        assert caught.value is original
    assert old.execute("SELECT secret FROM recording_key_secret").fetchall() == []
    secret = registry.recording_key_secret()
    replacement = opened_connections[1]
    assert replacement is not old
    assert registry.recording_key_secret() == secret
    owner = weakref.ref(registry)
    del caught
    del registry
    original.__traceback__ = None
    gc.collect()
    assert owner() is None
    for connection in (old, replacement):
        with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
            connection.execute("SELECT 1")
    with closing(SqliteShareRegistry(tmp_path / "registry.sqlite")) as reopened:
        assert reopened.recording_key_secret() == secret
