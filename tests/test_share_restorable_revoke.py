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
from podcast_mcp.services.collaboration.review_shares import list_shares
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
