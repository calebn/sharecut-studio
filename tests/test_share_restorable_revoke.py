"""ShareService restorable revoke: link dead at once, restorable for a window, then final."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from podcast_mcp.mcp.tools.review import revoke_record_room_tool
from podcast_mcp.models import load_project, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import share_pending
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.review_shares import list_shares, settle_shares_pending
from podcast_mcp.services.collaboration.review_versions import get_version
from podcast_mcp.services.collaboration.share import (
    ShareService,
    lookup_share,
    sweep_all_pending,
)
from podcast_mcp.services.collaboration.share_registry import (
    RecordRoomConflictError,
    RestoreWindowClosedError,
    ShareExpiredError,
    get_share_registry,
)
from podcast_mcp.util.object_store import ObjectStoreConfig

T0 = datetime(2030, 1, 1, tzinfo=UTC)
WINDOW = 10.0


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


@pytest.fixture(autouse=True)
def project_writes():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


@pytest.fixture(autouse=True)
def timers(monkeypatch) -> list[tuple[float, object]]:
    started: list[tuple[float, object]] = []
    monkeypatch.setattr(
        share_pending, "start_sweep_timer", lambda delay, fn: started.append((delay, fn))
    )
    return started


@pytest.fixture
def effects(monkeypatch) -> dict[str, MagicMock]:
    mocks = {
        "object": MagicMock(return_value=False),
        "proxies": MagicMock(),
        "summary": MagicMock(),
        "purge": MagicMock(),
        "release": MagicMock(),
        "lock_file": MagicMock(),
    }
    monkeypatch.setattr(share_pending, "delete_object_store_object_if_unused", mocks["object"])
    monkeypatch.setattr(share_pending, "delete_all_proxies_if_unused", mocks["proxies"])
    monkeypatch.setattr("podcast_mcp.services.record.persist_session_summary", mocks["summary"])
    monkeypatch.setattr("podcast_mcp.services.record.purge_session_land_rollbacks", mocks["purge"])
    monkeypatch.setattr("podcast_mcp.services.record.release_session_land_lock", mocks["release"])
    monkeypatch.setattr(
        "podcast_mcp.services.record.remove_session_land_lock_file", mocks["lock_file"]
    )
    return mocks


def _seed(minimal_project, sample_wav) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _review_share(ws: ProjectWorkspace, **kwargs) -> dict:
    ver = ReviewService(ws).publish(label="restorable")
    return ShareService(ws).create(review_version_id=ver["id"], **kwargs)


def _sidecar(ws: ProjectWorkspace, share_id: str) -> dict:
    (row,) = [r for r in list_shares(ws.project) if r["id"] == share_id]
    return row


def test_revoke_kills_the_link_and_restore_brings_back_the_same_one(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    out = ShareService(ws).revoke(share["token"], restorable_for=WINDOW, now=T0)
    assert out["revoked"] is True and out["token"] == share["token"]
    assert out["restorable_until"] == at(WINDOW).isoformat()
    with pytest.raises(KeyError):
        lookup_share(share["token"])
    side = _sidecar(ws, share["id"])
    assert side["revoked"] is True
    assert side["restorable_until"] == at(WINDOW).isoformat()
    assert ShareService(ws).list_presented() == []

    restored = ShareService(ws).restore(share["token"], now=at(3))
    assert restored == {"restored": True, "token": share["token"]}
    row = lookup_share(share["token"])
    assert row["id"] == share["id"]
    side = _sidecar(ws, share["id"])
    assert not side.get("revoked")
    assert "restorable_until" not in side and "revoked_at" not in side
    effects["object"].assert_not_called()
    assert [r["token"] for r in ShareService(ws).list_presented()] == [share["token"]]


def test_irreversible_effects_wait_for_the_window_and_run_once(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    assert svc.sweep_pending(now=at(5)) == 0
    effects["object"].assert_not_called()
    effects["proxies"].assert_not_called()

    assert svc.sweep_pending(now=at(11)) == 1
    assert svc.sweep_pending(now=at(12)) == 0
    effects["object"].assert_called_once()
    effects["proxies"].assert_called_once()
    assert get_share_registry().list_pending() == []
    assert "restorable_until" not in _sidecar(ws, share["id"])
    assert _sidecar(ws, share["id"])["revoked"] is True


def test_restore_after_the_window_is_refused_and_the_revoke_is_final(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    with pytest.raises(RestoreWindowClosedError):
        svc.restore(share["token"], now=at(10))
    with pytest.raises(RestoreWindowClosedError) as late:
        svc.restore(share["token"], now=at(20))
    assert late.value.code == "restore_window_closed"
    with pytest.raises(KeyError):
        lookup_share(share["token"])


def test_restore_of_an_unknown_token_or_room_is_not_found(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    with pytest.raises(KeyError) as share_err:
        ShareService(ws).restore("never-was-here", now=T0)
    assert share_err.value.code == "share_not_found"
    with pytest.raises(KeyError) as room_err:
        ShareService(ws).restore_room("no-such-room", now=T0)
    assert room_err.value.code == "record_room_not_found"


def test_restore_twice_is_idempotent(minimal_project, sample_wav, tmp_workspace, effects):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    svc.restore(share["token"], now=at(1))
    assert svc.restore(share["token"], now=at(2)) == {"restored": True, "token": share["token"]}


def test_expiry_caps_the_window(minimal_project, sample_wav, tmp_workspace, effects):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws, expires_at=at(4).isoformat())
    svc = ShareService(ws)
    out = svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    assert out["restorable_until"] == at(4).isoformat()
    with pytest.raises(ShareExpiredError):
        svc.restore(share["token"], now=at(5))


def test_a_second_restorable_revoke_of_a_pending_link_keeps_it_pending(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    first = svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    again = svc.revoke(share["token"], restorable_for=WINDOW, now=at(3))
    assert again == first
    effects["object"].assert_not_called()
    assert [p["token"] for p in get_share_registry().list_pending()] == [share["token"]]
    assert svc.restore(share["token"], now=at(4)) == {"restored": True, "token": share["token"]}


def _vanish_after_first_read(monkeypatch: pytest.MonkeyPatch) -> None:
    """The pending row is there for one registry read, then a sweep finalizes it."""
    registry = get_share_registry()
    real = registry.list_pending
    reads = {"n": 0}

    def list_pending(*args, **kwargs):
        reads["n"] += 1
        return real(*args, **kwargs) if reads["n"] == 1 else []

    monkeypatch.setattr(registry, "list_pending", list_pending)


def test_a_repeat_restorable_revoke_survives_a_finalize_landing_mid_call(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    first = svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    _vanish_after_first_read(monkeypatch)
    assert svc.revoke(share["token"], restorable_for=WINDOW, now=at(3)) == first


def test_a_repeat_restorable_room_revoke_survives_a_finalize_landing_mid_call(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    first = svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    _vanish_after_first_read(monkeypatch)
    again = svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=at(3))
    assert first["revoked"] == sorted([room["guest"]["token"], room["producer"]["token"]])
    assert again == first


def test_a_repeat_restorable_revoke_of_a_finalized_link_is_not_found(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    svc.revoke(share["token"])
    with pytest.raises(KeyError):
        svc.revoke(share["token"], restorable_for=WINDOW, now=at(3))


def test_a_final_revoke_of_a_pending_link_finalizes_it_at_once(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    assert svc.revoke(share["token"]) == {"revoked": True, "token": share["token"]}
    effects["object"].assert_called_once()
    assert get_share_registry().list_pending() == []
    with pytest.raises(RestoreWindowClosedError):
        svc.restore(share["token"], now=at(1))


def test_default_revoke_is_final_and_leaves_no_pending_row(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    assert ShareService(ws).revoke(share["token"]) == {"revoked": True, "token": share["token"]}
    assert get_share_registry().list_pending() == []
    effects["object"].assert_called_once()
    side = _sidecar(ws, share["id"])
    assert side["revoked"] is True and "restorable_until" not in side
    with pytest.raises(KeyError, match="share not found"):
        ShareService(ws).revoke(share["token"])


def test_pending_link_still_holds_its_media_against_another_revoke(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    deleted: list[str] = []

    class Store:
        def upload_fileobj(self, source, object_key, **_kw) -> None:
            source.read(1)

        def delete_object(self, object_key: str) -> None:
            deleted.append(object_key)

    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="r",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.media.review_media.load_object_store_config",
        lambda config_path=None: cfg,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.media.review_media.ObjectStoreClient", lambda _c: Store()
    )
    ws = _seed(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="shared-media")
    first = ShareService(ws).create(review_version_id=ver["id"])
    second = ShareService(ws).create(review_version_id=ver["id"])
    svc = ShareService(ws)
    svc.revoke(first["token"], restorable_for=WINDOW, now=T0)
    svc.revoke(second["token"])
    assert deleted == []
    svc.restore(first["token"], now=at(1))
    assert get_version(ProjectWorkspace.open(minimal_project).project, ver["id"]).object_store_key
    svc.revoke(first["token"], restorable_for=WINDOW, now=at(2))
    svc.sweep_pending(now=at(13))
    assert len(deleted) == 1


def _room(ws: ProjectWorkspace) -> dict:
    return ShareService(ws).create_record_room()


def test_room_revoke_restores_both_tokens_and_defers_room_effects(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    out = svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    assert set(out["revoked"]) == {room["guest"]["token"], room["producer"]["token"]}
    assert out["restorable_until"] == at(WINDOW).isoformat()
    for who in ("guest", "producer"):
        with pytest.raises(KeyError):
            lookup_share(room[who]["token"], kind="record")
    effects["summary"].assert_not_called()

    back = svc.restore_room(room["session_id"], now=at(2))
    assert set(back["restored"]) == set(out["revoked"])
    for who in ("guest", "producer"):
        assert lookup_share(room[who]["token"], kind="record")["session_id"] == room["session_id"]
    effects["summary"].assert_not_called()


def test_room_effects_run_once_per_room_after_the_window(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    svc.sweep_pending(now=at(11))
    svc.sweep_pending(now=at(12))
    for name in ("summary", "purge", "release", "lock_file"):
        effects[name].assert_called_once()
    effects["object"].assert_not_called()
    with pytest.raises(RestoreWindowClosedError):
        svc.restore_room(room["session_id"], now=at(13))


def test_minting_a_new_room_inside_the_window_makes_restore_conflict(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    old = _room(ws)
    svc = ShareService(ws)
    svc.revoke_room(old["session_id"], restorable_for=WINDOW, now=T0)
    new = _room(ws)
    assert lookup_share(new["guest"]["token"], kind="record")
    with pytest.raises(RecordRoomConflictError) as err:
        svc.restore_room(old["session_id"], now=at(2))
    assert err.value.code == "record_room_conflict"
    with pytest.raises(KeyError):
        lookup_share(old["guest"]["token"], kind="record")
    assert lookup_share(new["guest"]["token"], kind="record")


def test_a_second_restorable_room_revoke_keeps_the_room_pending(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    first = svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    again = svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=at(3))
    assert set(again["revoked"]) == set(first["revoked"])
    assert again["restorable_until"] == first["restorable_until"]
    effects["summary"].assert_not_called()
    back = svc.restore_room(room["session_id"], now=at(4))
    assert set(back["restored"]) == set(first["revoked"])


def test_final_room_revoke_of_a_pending_room_finalizes_it(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    out = svc.revoke_room(room["session_id"])
    assert set(out["revoked"]) == {room["guest"]["token"], room["producer"]["token"]}
    effects["summary"].assert_called_once()
    assert get_share_registry().list_pending() == []


def test_default_room_revoke_is_unchanged_and_mcp_leaves_no_pending_row(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    out = json.loads(revoke_record_room_tool(str(minimal_project), room["session_id"]))
    assert set(out["revoked"]) == {room["guest"]["token"], room["producer"]["token"]}
    assert get_share_registry().list_pending() == []
    effects["summary"].assert_called_once()


@pytest.mark.parametrize("by", ["token", "room"])
def test_cli_revoke_is_final_and_leaves_no_pending_row(
    minimal_project, sample_wav, tmp_workspace, effects, by
):
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app as cli_app

    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    flag = (
        ["--session-id", room["session_id"]]
        if by == "room"
        else ["--token", room["guest"]["token"]]
    )
    result = CliRunner().invoke(
        cli_app, ["review", "revoke-share", "--project", str(minimal_project), *flag]
    )
    assert result.exit_code == 0, result.output
    assert get_share_registry().list_pending() == []


def test_crash_a_registry_committed_but_sidecar_not_flagged_heals_on_sweep(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    real = share_pending.mark_shares_pending
    monkeypatch.setattr(
        share_pending, "mark_shares_pending", MagicMock(side_effect=OSError("disk gone"))
    )
    ShareService(ws).revoke(share["token"], restorable_for=WINDOW, now=T0)
    assert not _sidecar(ws, share["id"]).get("revoked")
    monkeypatch.setattr(share_pending, "mark_shares_pending", real)
    ShareService(ws).sweep_pending(now=at(1))
    side = _sidecar(ws, share["id"])
    assert side["revoked"] is True
    assert side["restorable_until"] == at(WINDOW).isoformat()


def test_crash_b_restore_committed_but_sidecar_still_revoked_heals_on_sweep(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    real = share_pending.settle_shares_pending
    monkeypatch.setattr(
        share_pending, "settle_shares_pending", MagicMock(side_effect=OSError("disk gone"))
    )
    svc.restore(share["token"], now=at(1))
    assert lookup_share(share["token"])
    assert _sidecar(ws, share["id"])["revoked"] is True
    monkeypatch.setattr(share_pending, "settle_shares_pending", real)
    svc.sweep_pending(now=at(2))
    side = _sidecar(ws, share["id"])
    assert not side.get("revoked") and "restorable_until" not in side


def test_crash_c_failed_finalize_is_retried_after_the_lease_lapses(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    effects["summary"].side_effect = [RuntimeError("crash mid finalize"), None]
    assert svc.sweep_pending(now=at(11)) == 0
    assert len(get_share_registry().list_pending()) == 2
    assert svc.sweep_pending(now=at(20)) == 0
    assert svc.sweep_pending(now=at(80)) == 1
    assert get_share_registry().list_pending() == []
    assert effects["summary"].call_count == 2
    effects["release"].assert_called_once()
    with pytest.raises(RestoreWindowClosedError):
        svc.restore_room(room["session_id"], now=at(81))


def test_revoke_schedules_a_best_effort_timer_past_the_window(
    minimal_project, sample_wav, tmp_workspace, effects, timers
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    ShareService(ws).revoke(share["token"], restorable_for=WINDOW, now=T0)
    assert [delay for delay, _ in timers] == [WINDOW + 1]


def test_timer_callback_sweeps_the_workspace(
    minimal_project, sample_wav, tmp_workspace, effects, timers, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    past = datetime.now(UTC) - timedelta(seconds=60)
    ShareService(ws).revoke(share["token"], restorable_for=WINDOW, now=past)
    (_, callback) = timers[0]
    callback()
    effects["object"].assert_called_once()
    assert get_share_registry().list_pending() == []


@pytest.mark.parametrize("entry", ["list", "list_presented", "create_record_room", "startup"])
def test_sweeps_run_on_list_mint_and_startup(
    minimal_project, sample_wav, tmp_workspace, effects, entry
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    past = datetime.now(UTC) - timedelta(seconds=60)
    ShareService(ws).revoke(share["token"], restorable_for=WINDOW, now=past)
    effects["object"].assert_not_called()
    svc = ShareService(ws)
    if entry == "startup":
        sweep_all_pending()
    elif entry == "create_record_room":
        svc.create_record_room()
    else:
        getattr(svc, entry)()
    effects["object"].assert_called_once()
    assert get_share_registry().list_pending() == []


def test_restore_sweeps_other_due_rows(minimal_project, sample_wav, tmp_workspace, effects):
    ws = _seed(minimal_project, sample_wav)
    old = _review_share(ws)
    fresh = _review_share(ws)
    svc = ShareService(ws)
    past = datetime.now(UTC) - timedelta(seconds=60)
    svc.revoke(old["token"], restorable_for=WINDOW, now=past)
    svc.revoke(fresh["token"], restorable_for=WINDOW, now=T0)
    svc.restore(fresh["token"], now=at(1))
    effects["object"].assert_called_once()


def test_host_start_finalizes_due_revokes(
    minimal_project, sample_wav, tmp_workspace, effects, tmp_path
):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    past = datetime.now(UTC) - timedelta(seconds=60)
    ShareService(ws).revoke(share["token"], restorable_for=WINDOW, now=past)
    effects["object"].assert_not_called()
    with TestClient(create_app()):
        pass
    effects["object"].assert_called_once()
    assert get_share_registry().list_pending() == []


def _make_settle_fail(monkeypatch) -> object:
    real = share_pending.settle_shares_pending
    monkeypatch.setattr(
        share_pending, "settle_shares_pending", MagicMock(side_effect=OSError("disk gone"))
    )
    return real


def test_failed_settle_keeps_the_pending_row_for_the_next_sweep(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    real = _make_settle_fail(monkeypatch)
    assert svc.sweep_pending(now=at(11)) == 0
    assert len(get_share_registry().list_pending()) == 1
    effects["object"].assert_not_called()
    monkeypatch.setattr(share_pending, "settle_shares_pending", real)
    assert svc.sweep_pending(now=at(80)) == 1
    assert get_share_registry().list_pending() == []
    effects["object"].assert_called_once()
    assert "restorable_until" not in _sidecar(ws, share["id"])


def test_a_stale_snapshot_cannot_flag_a_group_that_already_finalized(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    snapshot = get_share_registry().list_pending()
    assert svc.sweep_pending(now=at(11)) == 1
    share_pending._flag_sidecar(ws, snapshot, at(12))
    assert "restorable_until" not in _sidecar(ws, share["id"])


def test_reconcile_clears_a_marker_on_a_row_that_is_neither_pending_nor_active(
    minimal_project, sample_wav, tmp_workspace, effects
):
    from podcast_mcp.services.collaboration.review_shares import (
        mark_shares_pending,
        share_holds_media,
    )

    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    svc.sweep_pending(now=at(11))
    mark_shares_pending(
        ws.project.workspace_path(),
        {share["id"]: at(99).isoformat()},
        revoked_at=T0.isoformat(),
        still_pending=lambda: [share["id"]],
    )
    assert share_holds_media(_sidecar(ws, share["id"]))
    svc.sweep_pending(now=at(12))
    side = _sidecar(ws, share["id"])
    assert side["revoked"] is True and "restorable_until" not in side
    assert not share_holds_media(side)


def test_restored_sign_in_share_keeps_its_policy_while_the_sidecar_still_says_revoked(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    monkeypatch.setenv("PODCAST_SHARE_ACCOUNTS", "1")
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws, require_sign_in=True, general_access="restricted")
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    _make_settle_fail(monkeypatch)
    svc.restore(share["token"], now=at(1))
    assert _sidecar(ws, share["id"])["revoked"] is True
    row = lookup_share(share["token"])
    assert row["require_sign_in"] is True
    assert row["general_access"] == "restricted"
    assert row["revoked"] is False


def test_the_window_is_read_inside_the_transaction(tmp_path, monkeypatch):
    from podcast_mcp.services.collaboration import share_registry
    from podcast_mcp.services.collaboration.share_registry import SqliteShareRegistry

    registry = SqliteShareRegistry(tmp_path / "share_registry.sqlite")
    seen: list[bool] = []
    real = share_registry.utc_now

    def clock() -> datetime:
        seen.append(registry._conn.in_transaction)
        return real()

    monkeypatch.setattr(share_registry, "utc_now", clock)
    registry.begin_pending_revoke([], project_workspace="/ws", group_id="g", window=timedelta(1))
    registry.restore_group("g")
    registry.claim_due()
    assert seen == [True, True, True]
    registry.close()


def test_restorable_for_is_clamped_below_the_finalize_lease(
    minimal_project, sample_wav, tmp_workspace, effects, timers
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    out = ShareService(ws).revoke(share["token"], restorable_for=3600, now=T0)
    assert out["restorable_until"] == at(30).isoformat()
    assert [delay for delay, _ in timers] == [31.0]


def test_a_failed_final_room_revoke_effect_leaves_the_row_and_lease_for_a_sweep(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    effects["summary"].side_effect = [RuntimeError("summary failed"), None]
    out = svc.revoke_room(room["session_id"])
    assert set(out["revoked"]) == {room["guest"]["token"], room["producer"]["token"]}
    assert len(get_share_registry().list_pending()) == 2
    assert svc.sweep_pending(now=at(80)) == 1
    assert get_share_registry().list_pending() == []


def test_a_service_of_another_workspace_cannot_park_a_foreign_token(
    minimal_project, sample_wav, tmp_workspace, effects, tmp_path
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    other = tmp_path / "other"
    other.mkdir()
    registry = get_share_registry()
    assert (
        registry.begin_pending_revoke(
            [share["token"]],
            project_workspace=str(other),
            group_id=share["token"],
            window=timedelta(seconds=WINDOW),
            now=T0,
        )
        == []
    )
    assert lookup_share(share["token"])["id"] == share["id"]


def test_room_park_and_restore_drop_the_record_session_cache(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    from podcast_mcp.services import record

    dropped = MagicMock(wraps=record.invalidate_record_session_cache)
    monkeypatch.setattr("podcast_mcp.services.record.invalidate_record_session_cache", dropped)
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    dropped.reset_mock()
    svc = ShareService(ws)
    svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    assert dropped.call_count == 1
    svc.restore_room(room["session_id"], now=at(1))
    assert dropped.call_count == 2


def test_a_mint_cannot_take_the_room_lock_while_restore_room_runs(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    import threading

    from podcast_mcp.services.collaboration import share as share_module

    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    real = share_pending.restore
    probes: list[bool] = []

    def probe() -> None:
        got = share_module._record_room_lock.acquire(blocking=False)
        probes.append(got)
        if got:
            share_module._record_room_lock.release()

    def watched(*args, **kwargs):
        thread = threading.Thread(target=probe)
        thread.start()
        thread.join()
        return real(*args, **kwargs)

    monkeypatch.setattr(share_pending, "restore", watched)
    svc.restore_room(room["session_id"], now=at(1))
    assert probes == [False]


def test_restore_room_retried_after_a_failed_settle_reports_success_and_heals(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    real = _make_settle_fail(monkeypatch)
    first = svc.restore_room(room["session_id"], now=at(1))
    monkeypatch.setattr(share_pending, "settle_shares_pending", real)
    again = svc.restore_room(room["session_id"], now=at(2))
    assert set(again["restored"]) == set(first["restored"])
    rows = list_shares(ws.project)
    assert rows and not any(r.get("revoked") or "restorable_until" in r for r in rows)


def test_a_record_token_revoke_is_final_even_with_restorable_for(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    token = room["guest"]["token"]
    assert svc.revoke(token, restorable_for=WINDOW, now=T0) == {"revoked": True, "token": token}
    assert get_share_registry().list_pending() == []
    with pytest.raises(KeyError):
        lookup_share(token, kind="record")
    with pytest.raises(KeyError):
        svc.restore(token, now=at(1))


def test_room_park_after_one_token_was_revoked_parks_the_live_ones(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke(room["guest"]["token"])
    out = svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    assert out["revoked"] == [room["producer"]["token"]]
    back = svc.restore_room(room["session_id"], now=at(1))
    assert back["restored"] == [room["producer"]["token"]]


def test_restore_room_of_a_live_room_with_one_ended_token_reports_the_live_ones(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke(room["guest"]["token"])
    back = svc.restore_room(room["session_id"], now=T0)
    assert back["restored"] == [room["producer"]["token"]]


def test_restore_room_of_a_fully_ended_room_is_window_closed(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke_room(room["session_id"])
    with pytest.raises(RestoreWindowClosedError):
        svc.restore_room(room["session_id"], now=T0)


def test_final_revoke_of_a_token_inside_a_parked_room_finalizes_the_room(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    token = room["guest"]["token"]
    assert svc.revoke(token) == {"revoked": True, "token": token}
    assert get_share_registry().list_pending() == []
    effects["summary"].assert_called_once()
    with pytest.raises(RestoreWindowClosedError):
        svc.restore_room(room["session_id"], now=at(1))
    with pytest.raises(RestoreWindowClosedError):
        svc.restore(room["producer"]["token"], now=at(1))


def test_finalize_failure_logs_never_carry_the_bearer_token(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch, caplog
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    _make_settle_fail(monkeypatch)
    svc.sweep_pending(now=at(11))
    assert caplog.records
    assert share["token"] not in caplog.text


def test_a_non_finite_window_is_closed_or_capped_without_raising(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    first = _review_share(ws)
    second = _review_share(ws)
    svc = ShareService(ws)
    assert (
        svc.revoke(first["token"], restorable_for=float("nan"), now=T0)["restorable_until"]
        == T0.isoformat()
    )
    assert (
        svc.revoke(second["token"], restorable_for=float("inf"), now=T0)["restorable_until"]
        == at(30).isoformat()
    )


def test_a_zero_window_closes_at_once_and_the_refused_restore_sweeps_it_final(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    out = svc.revoke(share["token"], restorable_for=0, now=T0)
    assert out["restorable_until"] == T0.isoformat()
    with pytest.raises(RestoreWindowClosedError):
        svc.restore(share["token"], now=T0)
    assert get_share_registry().list_pending() == []
    effects["object"].assert_called_once()


def test_final_revoke_after_a_failed_flag_leaves_the_sidecar_revoked_and_media_free(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    from podcast_mcp.services.collaboration.review_shares import share_holds_media

    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    real = share_pending.mark_shares_pending
    monkeypatch.setattr(
        share_pending, "mark_shares_pending", MagicMock(side_effect=OSError("disk gone"))
    )
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    monkeypatch.setattr(share_pending, "mark_shares_pending", real)
    svc.revoke(share["token"])
    svc.sweep_pending(now=at(1))
    side = _sidecar(ws, share["id"])
    assert side["revoked"] is True
    assert not share_holds_media(side)


def test_revoke_room_of_a_room_being_finalized_by_another_sweeper_is_success(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    svc.revoke_room(room["session_id"], restorable_for=WINDOW, now=T0)
    held = get_share_registry().claim_due(
        project_workspace=share_pending.workspace_key(ws), group_id=room["session_id"], force=True
    )
    assert len(held) == 2
    out = svc.revoke_room(room["session_id"])
    assert out["session_id"] == room["session_id"]


def test_a_restore_racing_a_final_revoke_cannot_leave_the_sidecar_live(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    real_settle = share_pending._settle_sidecar

    raced: list[bool] = []

    def final_revoke_then_settle(ws_, ids, *, restored):
        if not raced:
            raced.append(True)
            ShareService(ws).revoke(share["token"])
        real_settle(ws_, ids, restored=restored)

    monkeypatch.setattr(share_pending, "_settle_sidecar", final_revoke_then_settle)
    svc.restore(share["token"], now=at(3))
    assert _sidecar(ws, share["id"])["revoked"] is True
    with pytest.raises(KeyError):
        lookup_share(share["token"])


def test_settling_a_restore_is_a_no_op_for_a_link_the_registry_no_longer_holds(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    ShareService(ws).revoke(share["token"])
    settle_shares_pending(ws.project.workspace_path(), [share["id"]], restored=True)
    assert _sidecar(ws, share["id"])["revoked"] is True


def test_a_room_revoke_ignores_a_pending_review_group_keyed_by_its_token(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    svc = ShareService(ws)
    svc.revoke(share["token"], restorable_for=WINDOW, now=T0)
    assert not share_pending.has_pending(ws, share["token"])
    with pytest.raises(KeyError):
        svc.revoke_room(share["token"])
    with pytest.raises(KeyError):
        svc.restore_room(share["token"], now=at(1))
    assert [p["token"] for p in get_share_registry().list_pending()] == [share["token"]]
    assert svc.restore(share["token"], now=at(2)) == {"restored": True, "token": share["token"]}
    effects["object"].assert_not_called()


def test_a_room_token_that_ended_meanwhile_is_skipped_without_an_error_log(
    minimal_project, sample_wav, tmp_workspace, effects, caplog, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    svc = ShareService(ws)
    ended = room["guest"]["token"]
    real_revoke = ShareService.revoke

    def revoke(self, token, **kwargs):
        if token == ended:
            raise KeyError(f"share not found: {token}")
        return real_revoke(self, token, **kwargs)

    monkeypatch.setattr(ShareService, "revoke", revoke)
    with caplog.at_level("DEBUG"):
        out = svc.revoke_room(room["session_id"])
    assert out["revoked"] == [room["producer"]["token"]]
    assert [r for r in caplog.records if r.levelname == "ERROR"] == []
