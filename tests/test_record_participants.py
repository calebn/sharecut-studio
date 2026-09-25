"""Record participant lease store tests."""

from __future__ import annotations

import time
from pathlib import Path

from podcast_mcp.services.record.participants import RecordParticipantStore


def test_mint_verify_and_wrong_token(tmp_path: Path) -> None:
    store = RecordParticipantStore(tmp_path / "sync.db")
    pid, lease = store.mint(
        session_id="sess",
        token="cool-token",
        role="guest",
        display_name="Ava",
    )
    assert pid.startswith("p_")
    assert store.verify(pid, lease, token="cool-token", session_id="sess")
    assert not store.verify(pid, lease, token="other-token", session_id="sess")
    assert not store.verify(pid, "not-the-lease", token="cool-token", session_id="sess")
    assert not store.verify("p_missing", lease, token="cool-token", session_id="sess")
    assert not store.verify(pid, lease, token="cool-token", session_id="other-sess")
    rows = store.for_session("sess")
    assert len(rows) == 1
    assert "lease" not in rows[0]
    assert "lease_hash" not in rows[0]
    assert "token" not in rows[0]
    assert "token_hash" not in rows[0]
    store.touch(pid)
    store.close()


def test_verify_rejects_expired_lease(tmp_path: Path) -> None:
    store = RecordParticipantStore(tmp_path / "sync.db")
    pid, lease = store.mint(
        session_id="sess",
        token="cool-token",
        role="guest",
        display_name="Ava",
    )
    with store._lock:
        store._conn.execute(
            "UPDATE record_participants SET lease_expires_ns = ? WHERE participant_id = ?",
            (time.time_ns() - 1, pid),
        )
    assert not store.verify(pid, lease, token="cool-token", session_id="sess")
    store.close()


def test_revoke_is_scoped_to_session_and_persists(tmp_path: Path) -> None:
    path = tmp_path / "sync.db"
    store = RecordParticipantStore(path)
    pid, lease = store.mint(session_id="sess", token="cool-token", role="guest", display_name="Ava")
    store.revoke(pid, session_id="other-sess")
    assert store.verify(pid, lease, token="cool-token", session_id="sess")
    store.revoke(pid, session_id="sess")
    assert not store.verify(pid, lease, token="cool-token", session_id="sess")
    store.close()
    reopened = RecordParticipantStore(path)
    assert not reopened.verify(pid, lease, token="cool-token", session_id="sess")
    reopened.close()


def test_participant_ids_for_token_scopes_token_and_session(tmp_path: Path) -> None:
    store = RecordParticipantStore(tmp_path / "sync.db")
    a, _ = store.mint(session_id="sess", token="tok-a", role="guest", display_name="Ava")
    b, _ = store.mint(session_id="sess", token="tok-a", role="guest", display_name="Bea")
    c, _ = store.mint(session_id="sess", token="tok-b", role="guest", display_name="Cy")
    d, _ = store.mint(session_id="other", token="tok-a", role="guest", display_name="Di")
    assert store.participant_ids_for_token(token="tok-a", session_id="sess") == {a, b}
    assert store.participant_ids_for_token(token="tok-b", session_id="sess") == {c}
    assert store.participant_ids_for_token(token="tok-a", session_id="other") == {d}
    store.revoke(a, session_id="sess")
    assert store.participant_ids_for_token(token="tok-a", session_id="sess") == {a, b}
    assert store.participant_ids_for_token(token="nope", session_id="sess") == set()
    store.close()
