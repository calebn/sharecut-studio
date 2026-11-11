"""POST /api/project/move and /api/project/pick-folder: move the open episode's folder."""

from __future__ import annotations

import os
import struct
import threading
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.host_file_dialog import HostPickResult
from podcast_mcp.gui.routes import project as project_routes
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.services.app import ProjectWorkspace, recent_projects
from podcast_mcp.services.collaboration.review_shares import (
    _load,
    _save,
    create_share,
    list_shares,
    shares_path,
)
from podcast_mcp.services.collaboration.share import workspace_from_share_row
from podcast_mcp.services.collaboration.share_registry import (
    RECORD_REVIEW_VERSION_SENTINEL,
    SqliteShareRegistry,
    get_share_registry,
)
from podcast_mcp.services.session_sync import cached_sync_store, sync_db_path
from podcast_mcp.util.project_state import project_commit_lock
from review_platform import requires_safe_failed_cleanup
from review_platform import (
    unmarked_tests_run_as_unsupported_platform as unmarked_tests_run_as_unsupported_platform,
)

CODE = "x-sharecut-error-code"
MOVE = "/api/project/move"
PICK = "/api/project/pick-folder"
LOOPBACK = ("127.0.0.1", 50000)
SERVICE = "podcast_mcp.services.app.move_project"


def _tone(path: Path) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(48000)
        out.writeframes(struct.pack("<h", 1000) * 48000)


@pytest.fixture
def episode(tmp_path: Path) -> Path:
    """The served episode: a project file with relative media and a premix."""
    folder = tmp_path / "episode_ws"
    (folder / "raw").mkdir(parents=True)
    _tone(folder / "raw" / "host.wav")
    project = EpisodeProject.create("test_episode", str(folder))
    project.ensure_dirs()
    saved = save_project(project)
    (folder / "artifacts").mkdir(exist_ok=True)
    _tone(folder / "artifacts" / "premix.wav")
    return saved.resolve()


@pytest.fixture
def dest_parent(tmp_path: Path) -> Path:
    parent = tmp_path / "elsewhere"
    parent.mkdir()
    return parent.resolve()


def _app(episode: Path):
    return create_app(served_project=episode)


def _client(app, peer: tuple[str, int] = LOOPBACK) -> TestClient:
    return TestClient(app, client=peer)


def _move(client: TestClient, episode: Path, dest_parent: Path | str, **extra):
    return client.post(MOVE, json={"path": str(episode), "dest_parent": str(dest_parent), **extra})


def _refused(res, status: int, code: str) -> None:
    assert (res.status_code, res.headers.get(CODE)) == (status, code), res.text


def _registry_workspace(table: str, token: str) -> str:
    registry = get_share_registry()
    assert isinstance(registry, SqliteShareRegistry)
    return registry._conn.execute(
        f"SELECT project_workspace FROM {table} WHERE token = ?", (token,)
    ).fetchone()[0]


def test_move_carries_the_whole_folder_and_the_project_loads_there(episode, dest_parent) -> None:
    folder = episode.parent
    (folder / "history").mkdir(exist_ok=True)
    (folder / "history" / "index.json").write_text("{}", encoding="utf-8")
    app = _app(episode)

    res = _move(_client(app), episode, dest_parent)

    new_folder = dest_parent / folder.name
    new_file = new_folder / "episode.sharecut"
    assert res.status_code == 200, res.text
    assert res.json() == {"project_path": str(new_file), "previous_path": str(episode)}
    assert not folder.exists()
    assert (new_folder / "history" / "index.json").is_file()
    assert (new_folder / "artifacts" / "premix.wav").is_file()
    assert (new_folder / "raw" / "host.wav").is_file()
    moved = ProjectWorkspace.open(new_file).project
    assert Path(moved.workspace_dir).resolve() == new_folder
    assert app.state.served_project == new_file


def test_the_new_folder_is_numbered_when_the_name_is_taken(episode, dest_parent) -> None:
    (dest_parent / episode.parent.name).mkdir()

    res = _move(_client(_app(episode)), episode, dest_parent)

    assert res.status_code == 200, res.text
    assert res.json()["project_path"] == str(
        dest_parent / f"{episode.parent.name} 2" / "episode.sharecut"
    )
    assert list((dest_parent / episode.parent.name).iterdir()) == []


def test_the_recent_list_follows_the_move(episode, dest_parent) -> None:
    recent_projects.record_recent(episode)

    res = _move(_client(_app(episode)), episode, dest_parent)

    paths = [entry.path for entry in recent_projects.read_recent()]
    assert paths == [res.json()["project_path"]]


def _seed_share(project, token: str) -> dict:
    """A review link as ``create_share`` leaves it (registry row plus sidecar row), minus the
    published version, which needs the pinned FFmpeg."""
    row = {
        "id": f"id-{token}",
        "token": token,
        "project_workspace": str(Path(project.workspace_dir).resolve()),
        "review_version_id": "v1",
        "created_at": "2026-01-01T00:00:00+00:00",
        "last_used_at": "2026-01-01T00:00:00+00:00",
        "capabilities": ["play"],
    }
    get_share_registry().claim_active(row)
    path = shares_path(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    _save(path, [*_load(path), row])
    return row


def test_shares_follow_the_move_and_still_resolve(episode, dest_parent) -> None:
    project = ProjectWorkspace.open(episode).project
    live = _seed_share(project, "live-slug")
    ended = _seed_share(project, "ended-slug")
    get_share_registry().demote_to_cooldown(ended["token"], reason="revoked")

    res = _move(_client(_app(episode)), episode, dest_parent)

    new_file = Path(res.json()["project_path"])
    row = get_share_registry().get_active(live["token"])
    assert row is not None
    assert row["project_workspace"] == str(new_file.parent)
    assert workspace_from_share_row(row).path == new_file
    assert _registry_workspace("cooldown_shares", ended["token"]) == str(new_file.parent)
    listed = list_shares(ProjectWorkspace.open(new_file).project)
    assert [s["token"] for s in listed if s.get("token")] == [live["token"]]
    assert {s["project_workspace"] for s in listed} == {str(new_file.parent)}


def test_a_live_job_for_the_episode_blocks_the_move(episode, dest_parent) -> None:
    app = _app(episode)
    app.state.jobs.adopt_agent_job(
        tool_id="t", label="Working", claim="c1", project_path=str(episode)
    )

    _refused(_move(_client(app), episode, dest_parent), 409, "move_busy_jobs")
    assert episode.is_file()


@requires_safe_failed_cleanup
def test_an_open_record_room_blocks_the_move(episode, dest_parent) -> None:
    ws = ProjectWorkspace.open(episode)
    create_share(
        ws.project,
        review_version_id=RECORD_REVIEW_VERSION_SENTINEL,
        kind="record",
        role="guest",
        session_id="room1",
    )

    _refused(_move(_client(_app(episode)), episode, dest_parent), 409, "move_room_open")
    assert episode.is_file()


def test_another_connected_window_blocks_the_move_but_the_callers_own_does_not(
    episode, dest_parent
) -> None:
    app = _app(episode)
    store = cached_sync_store(sync_db_path(ProjectWorkspace.open(episode).project))
    store.touch_client("tab-a", role="editor")
    store.touch_client("tab-b", role="viewer")

    _refused(
        _move(_client(app), episode, dest_parent, client_id="tab-a"), 409, "move_others_connected"
    )

    store.remove_client("tab-b")
    allowed = _move(_client(app), episode, dest_parent, client_id="tab-a")
    assert allowed.status_code == 200, allowed.text


def test_moving_into_the_folder_it_is_already_in_is_refused(episode) -> None:
    res = _move(_client(_app(episode)), episode, episode.parent.parent)

    _refused(res, 409, "move_dest_exists")
    assert episode.is_file()


def test_a_destination_taken_during_the_move_is_refused_and_leaves_the_episode(
    episode, dest_parent, monkeypatch
) -> None:
    real_rename = os.rename

    def raced(src, dst):
        (Path(dst) / "squatter.txt").write_text("x", encoding="utf-8")
        return real_rename(src, dst)

    monkeypatch.setattr(f"{SERVICE}.os.rename", raced)

    res = _move(_client(_app(episode)), episode, dest_parent)

    _refused(res, 409, "move_dest_exists")
    assert episode.is_file()


def test_a_different_volume_is_refused(episode, dest_parent, monkeypatch) -> None:
    monkeypatch.setattr(f"{SERVICE}._device_of", lambda path: 2 if Path(path) == dest_parent else 1)

    res = _move(_client(_app(episode)), episode, dest_parent)

    _refused(res, 409, "move_cross_volume")
    assert episode.is_file()
    assert list(dest_parent.iterdir()) == []


def test_a_rename_the_system_refuses_leaves_everything_unchanged(
    episode, dest_parent, monkeypatch
) -> None:
    def refuse(src, dst):
        raise PermissionError("in use")

    monkeypatch.setattr(f"{SERVICE}.os.rename", refuse)
    app = _app(episode)

    res = _move(_client(app), episode, dest_parent)

    _refused(res, 409, "move_in_use")
    assert episode.is_file()
    assert list(dest_parent.iterdir()) == []
    assert app.state.served_project == episode


def test_a_busy_project_lock_is_a_conflict(episode, dest_parent, monkeypatch) -> None:
    monkeypatch.setattr(f"{SERVICE}.LOCK_WAIT_SEC", 0.2)
    project = ProjectWorkspace.open(episode).project
    app = _app(episode)
    started, release = threading.Event(), threading.Event()

    def hold() -> None:
        with project_commit_lock(project):
            started.set()
            release.wait(10)

    holder = threading.Thread(target=hold)
    holder.start()
    try:
        assert started.wait(5)
        res = _move(_client(app), episode, dest_parent)
    finally:
        release.set()
        holder.join()

    _refused(res, 409, "project_busy")
    assert episode.is_file()
    assert list(dest_parent.iterdir()) == []


def _registry_fails(monkeypatch) -> None:
    def broken(self, old, new):
        raise RuntimeError("registry write failed")

    monkeypatch.setattr(SqliteShareRegistry, "rebase_workspace", broken)


def test_a_failure_after_the_rename_puts_the_folder_back(episode, dest_parent, monkeypatch) -> None:
    recent_projects.record_recent(episode)
    _registry_fails(monkeypatch)
    app = _app(episode)

    res = _move(_client(app), episode, dest_parent)

    _refused(res, 500, "move_failed")
    assert episode.is_file()
    assert list(dest_parent.iterdir()) == []
    assert app.state.served_project == episode
    assert [entry.path for entry in recent_projects.read_recent()] == [str(episode)]


def test_when_the_folder_cannot_be_put_back_the_new_path_is_reported(
    episode, dest_parent, monkeypatch
) -> None:
    real_rename = os.rename

    def one_way(src, dst):
        if Path(src) != episode.parent:
            raise OSError("cannot go back")
        return real_rename(src, dst)

    monkeypatch.setattr(f"{SERVICE}.os.rename", one_way)
    _registry_fails(monkeypatch)
    app = _app(episode)

    res = _move(_client(app), episode, dest_parent)

    new_file = dest_parent / episode.parent.name / "episode.sharecut"
    _refused(res, 409, "project_moved_partial")
    assert res.json()["detail"]["project_path"] == str(new_file)
    assert new_file.is_file()
    assert app.state.served_project == new_file


def test_a_lan_peer_is_refused(episode, dest_parent) -> None:
    res = _move(_client(_app(episode), ("203.0.113.9", 50000)), episode, dest_parent)

    _refused(res, 403, "reveal_not_allowed")
    assert episode.is_file()


def test_a_relayed_request_is_refused_as_not_a_host(episode, dest_parent) -> None:
    res = _client(_app(episode)).post(
        MOVE,
        json={"path": str(episode), "dest_parent": str(dest_parent)},
        headers={"x-sharecut-relayed": "1"},
    )

    _refused(res, 403, "authz_denied")
    assert episode.is_file()


def test_a_project_other_than_the_served_one_is_refused(episode, dest_parent, tmp_path) -> None:
    other = save_project(EpisodeProject.create("other_episode", str(tmp_path / "other")))

    res = _move(_client(_app(episode)), other, dest_parent)

    _refused(res, 403, "project_path_not_allowed")


@pytest.mark.parametrize("bad", ["relative/dir", "", "~/somewhere"])
def test_a_destination_that_is_not_an_absolute_path_is_refused(episode, bad) -> None:
    _refused(_move(_client(_app(episode)), episode, bad), 400, "move_dest_invalid")


def test_a_destination_inside_the_episode_is_refused(episode) -> None:
    _refused(
        _move(_client(_app(episode)), episode, episode.parent / "raw"), 400, "move_dest_invalid"
    )
    assert episode.is_file()


def test_a_destination_that_is_a_file_is_refused(episode, tmp_path) -> None:
    afile = tmp_path / "plain.txt"
    afile.write_text("x", encoding="utf-8")

    _refused(_move(_client(_app(episode)), episode, afile), 400, "move_dest_invalid")


def test_a_missing_destination_is_refused(episode, tmp_path) -> None:
    _refused(_move(_client(_app(episode)), episode, tmp_path / "nope"), 400, "move_dest_invalid")


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="needs POSIX permissions")
def test_an_unwritable_destination_is_refused(episode, tmp_path) -> None:
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        _refused(_move(_client(_app(episode)), episode, locked), 400, "move_dest_invalid")
    finally:
        locked.chmod(0o700)


def _pick(app, peer: tuple[str, int] = LOOPBACK, **headers):
    return _client(app, peer).post(PICK, headers=headers)


def test_pick_folder_answers_the_chosen_folder(episode, tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        project_routes, "pick_folder", lambda: HostPickResult(path=str(tmp_path.resolve()))
    )

    res = _pick(_app(episode))

    assert (res.status_code, res.json()) == (200, {"folder": str(tmp_path.resolve())})


def test_pick_folder_answers_cancelled(episode, monkeypatch) -> None:
    monkeypatch.setattr(project_routes, "pick_folder", lambda: HostPickResult(cancelled=True))

    assert _pick(_app(episode)).json() == {"cancelled": True}


def test_pick_folder_answers_unavailable_with_its_detail(episode, monkeypatch) -> None:
    monkeypatch.setattr(
        project_routes,
        "pick_folder",
        lambda: HostPickResult(unavailable=True, detail="no dialog here"),
    )

    assert _pick(_app(episode)).json() == {"unavailable": True, "detail": "no dialog here"}


def test_pick_folder_refuses_a_second_dialog(episode, monkeypatch) -> None:
    monkeypatch.setattr(project_routes, "pick_folder", lambda: HostPickResult(cancelled=True))
    assert project_routes._PICK_LOCK.acquire(blocking=False)
    try:
        _refused(_pick(_app(episode)), 409, "file_dialog_open")
    finally:
        project_routes._PICK_LOCK.release()


def test_pick_folder_is_loopback_and_host_only(episode, monkeypatch) -> None:
    calls: list[int] = []
    monkeypatch.setattr(
        project_routes, "pick_folder", lambda: calls.append(1) or HostPickResult(cancelled=True)
    )

    lan = _pick(_app(episode), ("203.0.113.9", 50000))
    relayed = _pick(_app(episode), **{"x-sharecut-relayed": "1"})

    _refused(lan, 403, "reveal_not_allowed")
    _refused(relayed, 403, "authz_denied")
    assert calls == []
