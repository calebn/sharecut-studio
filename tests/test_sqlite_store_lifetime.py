"""SQLite connections follow their last store owner, including cache pins."""

from __future__ import annotations

import gc
import sqlite3
import weakref
from collections.abc import Callable
from pathlib import Path

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
