"""Registry side of a restorable revoke: pending_revokes, restore CAS, finalize lease."""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from podcast_mcp.services.collaboration.share_registry import (
    RecordRoomConflictError,
    RestoreWindowClosedError,
    ShareExpiredError,
    SqliteShareRegistry,
    backup_share_registry,
)

WINDOW = timedelta(seconds=10)
T0 = datetime(2030, 1, 1, tzinfo=UTC)


def _share(token: str, **over) -> dict:
    row = {
        "token": token,
        "id": f"id-{token}",
        "project_workspace": "/ws/a",
        "review_version_id": "v1",
        "created_at": T0.isoformat(),
        "last_used_at": T0.isoformat(),
        "capabilities": ["view"],
    }
    row.update(over)
    return row


def _room_share(token: str, session: str, role: str, **over) -> dict:
    return _share(token, kind="record", role=role, session_id=session, review_version_id="", **over)


@pytest.fixture
def registry(tmp_path: Path) -> Iterator[SqliteShareRegistry]:
    with closing(SqliteShareRegistry(tmp_path / "share_registry.sqlite")) as store:
        yield store


def _begin(registry: SqliteShareRegistry, *tokens: str, group: str | None = None, now=T0):
    return registry.begin_pending_revoke(
        list(tokens), group_id=group or tokens[0], window=WINDOW, now=now
    )


def test_revoke_kills_lookup_and_reserves_token(registry: SqliteShareRegistry):
    registry.claim_active(_share("alpha-beta-gamma"))
    pending = _begin(registry, "alpha-beta-gamma")
    assert [p["token"] for p in pending] == ["alpha-beta-gamma"]
    assert registry.get_active("alpha-beta-gamma") is None
    assert registry.is_reserved("alpha-beta-gamma", now=T0)
    with pytest.raises(ValueError, match="reserved"):
        registry.claim_active(_share("alpha-beta-gamma", id="other"))


def test_begin_skips_tokens_that_are_not_active(registry: SqliteShareRegistry):
    assert _begin(registry, "nope") == []
    registry.claim_active(_share("one-two-three"))
    _begin(registry, "one-two-three")
    assert _begin(registry, "one-two-three") == []


def test_restore_within_window_returns_same_token_and_id(registry: SqliteShareRegistry):
    registry.claim_active(_share("same-token-slug", capabilities=["view", "play"]))
    _begin(registry, "same-token-slug")
    restored = registry.restore_group("same-token-slug", now=T0 + timedelta(seconds=9))
    assert [r["token"] for r in restored] == ["same-token-slug"]
    row = registry.get_active("same-token-slug")
    assert row is not None
    assert row["id"] == "id-same-token-slug"
    assert row["capabilities"] == ["view", "play"]
    assert registry.list_pending() == []
    with closing(sqlite3.connect(registry.db_path)) as raw:
        assert raw.execute("SELECT COUNT(*) FROM cooldown_shares").fetchone()[0] == 0


def test_restore_after_window_refused(registry: SqliteShareRegistry):
    registry.claim_active(_share("late-undo-slug"))
    _begin(registry, "late-undo-slug")
    with pytest.raises(RestoreWindowClosedError) as err:
        registry.restore_group("late-undo-slug", now=T0 + WINDOW)
    assert err.value.code == "restore_window_closed"
    assert registry.get_active("late-undo-slug") is None


def test_restorable_until_is_capped_by_expires_at(registry: SqliteShareRegistry):
    expires = T0 + timedelta(seconds=4)
    registry.claim_active(_share("capped-slug-one", expires_at=expires.isoformat()))
    (pending,) = _begin(registry, "capped-slug-one")
    assert pending["restorable_until"] == expires.isoformat()
    with pytest.raises(ShareExpiredError) as err:
        registry.restore_group("capped-slug-one", now=T0 + timedelta(seconds=5))
    assert err.value.code == "share_expired"


def test_restore_unknown_group_returns_nothing(registry: SqliteShareRegistry):
    assert registry.restore_group("missing", now=T0) == []


def test_room_restores_every_token_atomically(registry: SqliteShareRegistry):
    registry.claim_active(_room_share("guest-room-tok", "sess1", "guest"))
    registry.claim_active(_room_share("prod-room-tok", "sess1", "producer"))
    _begin(registry, "guest-room-tok", "prod-room-tok", group="sess1")
    restored = registry.restore_group("sess1", now=T0 + timedelta(seconds=1))
    assert {r["token"] for r in restored} == {"guest-room-tok", "prod-room-tok"}
    assert registry.get_active("guest-room-tok") is not None
    assert registry.get_active("prod-room-tok") is not None


def test_restore_refused_when_another_room_is_live(registry: SqliteShareRegistry):
    registry.claim_active(_room_share("old-room-guest", "old", "guest"))
    _begin(registry, "old-room-guest", group="old")
    registry.claim_active(_room_share("new-room-guest", "new", "guest"))
    with pytest.raises(RecordRoomConflictError) as err:
        registry.restore_group("old", now=T0 + timedelta(seconds=1))
    assert err.value.code == "record_room_conflict"
    assert registry.get_active("old-room-guest") is None
    assert [p["token"] for p in registry.list_pending()] == ["old-room-guest"]


def test_conflict_ignores_rooms_of_other_workspaces(registry: SqliteShareRegistry):
    registry.claim_active(_room_share("old-room-guest", "old", "guest"))
    _begin(registry, "old-room-guest", group="old")
    registry.claim_active(_room_share("elsewhere-guest", "new", "guest", project_workspace="/ws/b"))
    assert registry.restore_group("old", now=T0 + timedelta(seconds=1))


def test_rebase_workspace_updates_pending_rows(registry: SqliteShareRegistry):
    registry.claim_active(_share("moved-pending-slug"))
    _begin(registry, "moved-pending-slug")
    assert registry.rebase_workspace("/ws/a", "/ws/moved") >= 2
    assert registry.list_pending("/ws/a") == []
    (pending,) = registry.list_pending("/ws/moved")
    assert pending["project_workspace"] == "/ws/moved"
    registry.restore_group("moved-pending-slug", now=T0 + timedelta(seconds=1))
    row = registry.get_active("moved-pending-slug")
    assert row is not None and row["project_workspace"] == "/ws/moved"


def test_backup_includes_pending_table(registry: SqliteShareRegistry, tmp_path: Path):
    registry.claim_active(_share("backup-pending-slug"))
    _begin(registry, "backup-pending-slug")
    out = backup_share_registry(tmp_path / "copy.sqlite", registry=registry)
    with closing(SqliteShareRegistry(out)) as restored:
        assert [p["token"] for p in restored.list_pending()] == ["backup-pending-slug"]


def test_claim_due_only_after_window_and_once(registry: SqliteShareRegistry):
    registry.claim_active(_share("due-later-slug"))
    _begin(registry, "due-later-slug")
    assert registry.claim_due(now=T0 + timedelta(seconds=5)) == []
    claimed = registry.claim_due(now=T0 + WINDOW)
    assert [c["token"] for c in claimed] == ["due-later-slug"]
    assert registry.claim_due(now=T0 + WINDOW + timedelta(seconds=1)) == []


def test_lease_expiry_makes_a_crashed_finalize_claimable_again(registry: SqliteShareRegistry):
    registry.claim_active(_share("lease-slug-one"))
    _begin(registry, "lease-slug-one")
    registry.claim_due(now=T0 + WINDOW, lease=timedelta(seconds=30))
    later = T0 + WINDOW + timedelta(seconds=31)
    assert [c["token"] for c in registry.claim_due(now=later)] == ["lease-slug-one"]


def test_complete_finalize_is_idempotent_and_keeps_the_token_reserved(
    registry: SqliteShareRegistry,
):
    registry.claim_active(_share("final-slug-one"))
    _begin(registry, "final-slug-one")
    now = T0 + WINDOW
    registry.claim_due(now=now)
    assert registry.complete_finalize(["final-slug-one"]) == 1
    assert registry.complete_finalize(["final-slug-one"]) == 0
    assert registry.is_reserved("final-slug-one", now=now)
    assert registry.get_active("final-slug-one") is None
    assert registry.restore_group("final-slug-one", now=now) == []


def test_force_claim_takes_a_group_before_its_window_ends(registry: SqliteShareRegistry):
    registry.claim_active(_share("force-slug-one"))
    _begin(registry, "force-slug-one")
    claimed = registry.claim_due(now=T0, group_id="force-slug-one", force=True)
    assert [c["token"] for c in claimed] == ["force-slug-one"]
    with pytest.raises(RestoreWindowClosedError):
        registry.restore_group("force-slug-one", now=T0)


def test_restore_and_finalize_race_has_exactly_one_winner(tmp_path: Path):
    for round_no in range(8):
        path = tmp_path / f"race{round_no}.sqlite"
        with closing(SqliteShareRegistry(path)) as setup:
            setup.claim_active(_share("race-slug-one"))
            _begin(setup, "race-slug-one")
        barrier = threading.Barrier(2)
        outcome: dict[str, object] = {}
        edge = T0 + WINDOW - timedelta(microseconds=1)

        def restore(store, barrier=barrier, outcome=outcome, edge=edge):
            barrier.wait()
            try:
                outcome["restore"] = store.restore_group("race-slug-one", now=edge)
            except RestoreWindowClosedError:
                outcome["restore"] = []

        def finalize(store, barrier=barrier, outcome=outcome):
            barrier.wait()
            outcome["finalize"] = store.claim_due(
                now=T0 + WINDOW, group_id="race-slug-one", force=True
            )

        with closing(SqliteShareRegistry(path)) as one, closing(SqliteShareRegistry(path)) as two:
            threads = [
                threading.Thread(target=restore, args=(one,)),
                threading.Thread(target=finalize, args=(two,)),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            restored = bool(outcome["restore"])
            finalized = bool(outcome["finalize"])
            assert restored != finalized
            assert (one.get_active("race-slug-one") is not None) == restored
