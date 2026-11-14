"""Record participant lease store tests."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from podcast_mcp.services.record.participants import RecordParticipantStore
from podcast_mcp.util.coded_error import CodedValueError


def test_mint_verify_binds_the_share(tmp_path: Path) -> None:
    store = RecordParticipantStore(tmp_path / "sync.db")
    pid, lease = store.mint(session_id="sess", share_id="share-a")
    assert pid.startswith("p_")
    assert store.verify(pid, lease, share_id="share-a", session_id="sess")
    assert not store.verify(pid, lease, share_id="share-b", session_id="sess")
    assert not store.verify(pid, lease, share_id="", session_id="sess")
    assert not store.verify(pid, "not-the-lease", share_id="share-a", session_id="sess")
    assert not store.verify("p_missing", lease, share_id="share-a", session_id="sess")
    assert not store.verify(pid, lease, share_id="share-a", session_id="other-sess")
    store.close()


def test_mint_refuses_an_empty_share_id(tmp_path: Path) -> None:
    store = RecordParticipantStore(tmp_path / "sync.db")
    with pytest.raises(CodedValueError, match="share"):
        store.mint(session_id="sess", share_id="")
    store.close()


def test_the_lease_table_holds_only_ids_and_a_lease_hash(tmp_path: Path) -> None:
    path = tmp_path / "sync.db"
    store = RecordParticipantStore(path)
    store.mint(session_id="sess", share_id="share-a")
    store.close()
    with sqlite3.connect(path) as conn:
        columns = [row[1] for row in conn.execute("PRAGMA table_info(record_participant_leases)")]
        tables = {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert columns == [
        "participant_id",
        "session_id",
        "share_id",
        "lease_hash",
        "lease_expires_ns",
    ]
    assert "record_participants" not in tables


def test_verify_rejects_expired_lease(tmp_path: Path) -> None:
    store = RecordParticipantStore(tmp_path / "sync.db")
    pid, lease = store.mint(session_id="sess", share_id="share-a")
    with store._lock:
        store._conn.execute(
            "UPDATE record_participant_leases SET lease_expires_ns = ? WHERE participant_id = ?",
            (time.time_ns() - 1, pid),
        )
    assert not store.verify(pid, lease, share_id="share-a", session_id="sess")
    store.close()


def test_revoke_is_scoped_to_session_and_persists(tmp_path: Path) -> None:
    path = tmp_path / "sync.db"
    store = RecordParticipantStore(path)
    pid, lease = store.mint(session_id="sess", share_id="share-a")
    store.revoke(pid, session_id="other-sess")
    assert store.verify(pid, lease, share_id="share-a", session_id="sess")
    store.revoke(pid, session_id="sess")
    assert not store.verify(pid, lease, share_id="share-a", session_id="sess")
    store.close()
    reopened = RecordParticipantStore(path)
    assert not reopened.verify(pid, lease, share_id="share-a", session_id="sess")
    reopened.close()


def test_invites_of_scopes_share_and_session(tmp_path: Path) -> None:
    store = RecordParticipantStore(tmp_path / "sync.db")
    a, _ = store.mint(session_id="sess", share_id="share-a")
    b, _ = store.mint(session_id="sess", share_id="share-a")
    c, _ = store.mint(session_id="sess", share_id="share-b")
    d, _ = store.mint(session_id="other", share_id="share-a")
    assert store.invites_of({a, b, c}, session_id="sess") == {
        a: "share-a",
        b: "share-a",
        c: "share-b",
    }
    assert store.invites_of({d}, session_id="sess") == {}
    assert store.invites_of({d}, session_id="other") == {d: "share-a"}
    assert store.invites_of(set(), session_id="sess") == {}
    store.revoke(a, session_id="sess")
    assert store.invites_of({a}, session_id="sess") == {a: "share-a"}
    store.close()


def test_clear_except_keeps_only_the_named_room(tmp_path: Path) -> None:
    store = RecordParticipantStore(tmp_path / "sync.db")
    old, _ = store.mint(session_id="old", share_id="share-a")
    kept, kept_lease = store.mint(session_id="new", share_id="share-b")
    store.set_track_choice("old", old, "t1")
    store.set_track_choice("new", kept, "t2")
    store.clear_except("new")
    assert store.invites_of({old, kept}, session_id="old") == {}
    assert store.verify(kept, kept_lease, share_id="share-b", session_id="new")
    assert store.track_choices("old") == {}
    assert store.track_choices("new") == {kept: "t2"}
    store.close()
