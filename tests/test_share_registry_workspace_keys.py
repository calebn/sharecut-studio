"""Share links name their folder by a key that survives the app container moving.

The registry encodes every workspace it stores and decodes only where a row leaves it. The
Files-visible ``shares.json`` carries no workspace, and a registry row that names no usable folder
reads as absent while its slug stays reserved.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.app.move_project import MoveRefused, move_episode_folder
from podcast_mcp.services.collaboration import share_pending
from podcast_mcp.services.collaboration.review_shares import (
    _load,
    _save,
    create_share,
    list_shares,
    shares_path,
)
from podcast_mcp.services.collaboration.share import (
    ShareService,
    lookup_share,
    open_share_workspace,
    sweep_all_pending,
    workspace_from_share_row,
)
from podcast_mcp.services.collaboration.share_registry import (
    RECORD_REVIEW_VERSION_SENTINEL,
    SqliteShareRegistry,
    get_share_registry,
    reset_share_registry_for_tests,
)
from podcast_mcp.util import host_platform

T0 = datetime(2030, 1, 1, tzinfo=UTC)
OLDER_CONTAINER = "/var/mobile/Containers/Data/Application/OLD-UUID"


@pytest.fixture(autouse=True)
def project_writes() -> Iterator[None]:
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


@pytest.fixture(autouse=True)
def finalize_effects(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(share_pending, "start_sweep_timer", lambda delay, fn: None)
    monkeypatch.setattr(share_pending, "delete_object_store_object_if_unused", MagicMock())
    monkeypatch.setattr(share_pending, "delete_all_proxies_if_unused", MagicMock())


@pytest.fixture
def container(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, host: Callable[..., None]) -> Path:
    """An iOS host whose home is ``tmp_path/container-a``, with its registry at the real default."""
    home = tmp_path.resolve() / "container-a"
    (home / "Documents").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("PODCAST_SHARE_REGISTRY")
    reset_share_registry_for_tests()
    host(host_platform.IOS)
    return home


def _move_container(home: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The reinstall: the same files at a new path, the process now living there."""
    moved = home.with_name("container-b")
    home.rename(moved)
    monkeypatch.setenv("HOME", str(moved))
    reset_share_registry_for_tests()
    return moved


def _project(folder: Path) -> Path:
    folder.mkdir(parents=True)
    project = EpisodeProject.create("episode", str(folder))
    project.ensure_dirs()
    return save_project(project).resolve()


def _seed_review(folder: Path, token: str, **sidecar_only: object) -> dict:
    """A review link as ``create_share`` leaves it (registry row, sidecar row) minus the version."""
    row = {
        "id": f"id-{token}",
        "token": token,
        "project_workspace": str(folder.resolve()),
        "review_version_id": "v1",
        "created_at": T0.isoformat(),
        "last_used_at": T0.isoformat(),
        "capabilities": ["play"],
        **sidecar_only,
    }
    get_share_registry().claim_active(row)
    path = shares_path(ProjectWorkspace.open(folder / "episode.sharecut").project)
    path.parent.mkdir(parents=True, exist_ok=True)
    _save(path, [*_load(path), row])
    return row


def _mint_record(project_file: Path, expires_at: str | None = None) -> dict:
    return create_share(
        ProjectWorkspace.open(project_file).project,
        review_version_id=RECORD_REVIEW_VERSION_SENTINEL,
        kind="record",
        role="guest",
        session_id="room-1",
        expires_at=expires_at,
    )


def _raw(table: str, token: str) -> str:
    registry = get_share_registry()
    assert isinstance(registry, SqliteShareRegistry)
    found = registry._conn.execute(
        f"SELECT project_workspace FROM {table} WHERE token = ?", (token,)
    ).fetchone()
    return str(found[0])


def _set_raw(table: str, token: str, value: str) -> None:
    registry = get_share_registry()
    assert isinstance(registry, SqliteShareRegistry)
    registry._conn.execute(
        f"UPDATE {table} SET project_workspace = ? WHERE token = ?", (value, token)
    )


def test_a_container_host_stores_the_workspace_relative_to_its_home(container: Path) -> None:
    project_file = _project(container / "Documents" / "Episode")
    row = _mint_record(project_file)

    assert _raw("active_shares", row["token"]) == "Documents/Episode"
    assert get_share_registry().get_active(row["token"])["project_workspace"] == str(
        project_file.parent
    )


def test_links_survive_the_container_moving(
    container: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_file = _project(container / "Documents" / "Episode")
    room = _mint_record(project_file)
    review = _seed_review(project_file.parent, "alpha-beta-gamma")
    parked = _seed_review(project_file.parent, "delta-eps-zeta")
    ShareService(ProjectWorkspace.open(project_file)).revoke(
        parked["token"], restorable_for=30, now=T0
    )

    moved = _move_container(container, monkeypatch)
    now_file = moved / "Documents" / "Episode" / "episode.sharecut"
    ws = ProjectWorkspace.open(now_file)

    listed = {row["token"] for row in list_shares(ws.project) if row.get("token")}
    assert listed == {room["token"], review["token"]}
    assert lookup_share(review["token"])["project_workspace"] == str(now_file.parent)
    guest_row, guest_ws = open_share_workspace(room["token"], kind="record")
    assert guest_row["project_workspace"] == str(now_file.parent)
    assert guest_ws.path == now_file
    pending = get_share_registry().list_pending(str(now_file.parent))
    assert [row["token"] for row in pending] == [parked["token"]]
    assert ShareService(ws).restore(parked["token"], now=T0 + timedelta(seconds=3)) == {
        "restored": True,
        "token": parked["token"],
    }
    assert lookup_share(parked["token"])["project_workspace"] == str(now_file.parent)


def test_a_pending_revoke_is_finalized_after_the_container_moves(
    container: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_file = _project(container / "Documents" / "Episode")
    parked = _seed_review(project_file.parent, "alpha-beta-gamma")
    ShareService(ProjectWorkspace.open(project_file)).revoke(
        parked["token"], restorable_for=30, now=T0
    )
    _move_container(container, monkeypatch)

    assert sweep_all_pending(now=T0 + timedelta(seconds=60)) == 1

    registry = get_share_registry()
    assert registry.list_pending() == []
    assert registry.is_reserved(parked["token"], now=T0 + timedelta(seconds=61))


def test_a_move_inside_the_container_keeps_links_and_its_undo_restores_them(
    container: Path,
) -> None:
    project_file = _project(container / "Documents" / "Episode")
    link = _seed_review(project_file.parent, "alpha-beta-gamma")
    (container / "Documents" / "Archive").mkdir()
    calls: list[Path] = []

    def serve(path: Path) -> None:
        calls.append(path)

    result = move_episode_folder(
        project_file,
        str(container / "Documents" / "Archive"),
        jobs=None,
        caller_client_id=None,
        serve=serve,
    )

    moved = result.project_path.parent
    assert moved == container / "Documents" / "Archive" / "Episode"
    assert _raw("active_shares", link["token"]) == "Documents/Archive/Episode"
    assert lookup_share(link["token"])["project_workspace"] == str(moved)

    def refuse_first(path: Path) -> None:
        calls.append(path)
        if len(calls) == 2:
            raise RuntimeError("the page could not follow the move")

    (container / "Documents" / "Back").mkdir()
    with pytest.raises(MoveRefused):
        move_episode_folder(
            result.project_path,
            str(container / "Documents" / "Back"),
            jobs=None,
            caller_client_id=None,
            serve=refuse_first,
        )

    assert _raw("active_shares", link["token"]) == "Documents/Archive/Episode"
    assert lookup_share(link["token"])["project_workspace"] == str(moved)


def test_an_edited_sidecar_cannot_redirect_or_re_arm_a_link(tmp_path: Path) -> None:
    real = _project(tmp_path / "real")
    other = _project(tmp_path / "other")
    link = _seed_review(
        real.parent, "alpha-beta-gamma", general_access="link", require_sign_in=False
    )
    path = shares_path(ProjectWorkspace.open(real).project)
    edited = json.loads(path.read_text(encoding="utf-8"))
    edited[0].update(
        project_workspace=str(other.parent),
        capabilities=["play", "comment", "edit"],
        role="producer",
        kind="record",
        review_version_id="v-other",
        require_sign_in=True,
        general_access="restricted",
        follow_latest=True,
    )
    path.write_text(json.dumps(edited), encoding="utf-8")

    row = lookup_share(link["token"])

    assert row["project_workspace"] == str(real.parent)
    assert workspace_from_share_row(row).path == real
    assert row["capabilities"] == ["play"]
    assert (row["kind"], row["role"], row["review_version_id"]) == ("review", None, "v1")
    assert (row["require_sign_in"], row["general_access"], row["follow_latest"]) == (
        True,
        "restricted",
        True,
    )


def test_a_new_sidecar_row_names_no_workspace_and_no_token(tmp_path: Path) -> None:
    project_file = _project(tmp_path / "real")
    row = _mint_record(project_file)

    (stored,) = _load(shares_path(ProjectWorkspace.open(project_file).project))

    assert stored["id"] == row["id"]
    assert not {"project_workspace", "token"} & stored.keys()
    assert open_share_workspace(row["token"], kind="record")[1].path == project_file


def test_a_relative_stored_value_on_desktop_is_not_resolved_against_the_working_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_file = _project(tmp_path / "real")
    row = _mint_record(project_file)
    _set_raw("active_shares", row["token"], "real")
    monkeypatch.chdir(tmp_path)

    registry = get_share_registry()
    assert registry.get_active(row["token"]) is None
    assert registry.list_active_for_workspace("real") == []
    assert registry.is_reserved(row["token"])
    with pytest.raises(KeyError):
        lookup_share(row["token"], kind="record")


@pytest.mark.parametrize("stored", [f"{OLDER_CONTAINER}/Documents/Episode", "../elsewhere"])
def test_an_active_row_that_names_no_folder_in_this_container_is_invisible_but_reserved(
    container: Path, stored: str
) -> None:
    project_file = _project(container / "Documents" / "Episode")
    row = _mint_record(project_file)
    _set_raw("active_shares", row["token"], stored)

    registry = get_share_registry()
    assert registry.get_active(row["token"]) is None
    assert registry.list_active_for_workspace(str(project_file.parent)) == []
    assert registry.is_reserved(row["token"])
    with pytest.raises(KeyError):
        lookup_share(row["token"], kind="record")
    with pytest.raises(ValueError, match="reserved"):
        registry.claim_active({**row, "id": "another"})
    assert registry.demote_to_cooldown(row["token"], reason="revoked") is True
    assert registry.is_reserved(row["token"])


def test_an_unresolvable_pending_row_is_finalized_not_released_or_leased_again(
    container: Path,
) -> None:
    project_file = _project(container / "Documents" / "Episode")
    parked = _seed_review(project_file.parent, "alpha-beta-gamma")
    ShareService(ProjectWorkspace.open(project_file)).revoke(
        parked["token"], restorable_for=30, now=T0
    )
    _set_raw("pending_revokes", parked["token"], f"{OLDER_CONTAINER}/Documents/Episode")
    registry = get_share_registry()
    later = T0 + timedelta(seconds=120)

    assert registry.list_pending() == []
    assert registry.claim_due(now=later) == []
    assert registry.restore_group(parked["token"], now=T0 + timedelta(seconds=3)) == []

    assert sweep_all_pending(now=later) == 1

    assert _count("pending_revokes") == 0
    assert registry.is_reserved(parked["token"], now=later)
    assert sweep_all_pending(now=later) == 0


def _count(table: str) -> int:
    registry = get_share_registry()
    assert isinstance(registry, SqliteShareRegistry)
    return int(registry._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def test_the_sweep_demotes_an_expired_unresolvable_active_row_to_the_cooldown(
    container: Path,
) -> None:
    project_file = _project(container / "Documents" / "Episode")
    row = _mint_record(project_file, expires_at="2029-12-01T00:00:00Z")
    _set_raw("active_shares", row["token"], f"{OLDER_CONTAINER}/Documents/Episode")
    registry = get_share_registry()

    sweep_all_pending(now=T0)

    assert _count("active_shares") == 0
    assert registry.is_reserved(row["token"], now=T0 + timedelta(days=364))
    assert not registry.is_reserved(row["token"], now=T0 + timedelta(days=366))


def test_the_sweep_leaves_an_unexpired_unresolvable_active_row_reserved(container: Path) -> None:
    project_file = _project(container / "Documents" / "Episode")
    row = _mint_record(project_file, expires_at="2031-01-01T00:00:00Z")
    _set_raw("active_shares", row["token"], f"{OLDER_CONTAINER}/Documents/Episode")
    unlimited = _mint_record(project_file)
    _set_raw("active_shares", unlimited["token"], f"{OLDER_CONTAINER}/Documents/Episode")

    sweep_all_pending(now=T0)

    assert _count("active_shares") == 2
    assert get_share_registry().is_reserved(row["token"], now=T0)


def test_the_sweep_never_touches_an_expired_resolvable_row(container: Path) -> None:
    project_file = _project(container / "Documents" / "Episode")
    row = _mint_record(project_file, expires_at="2029-12-01T00:00:00Z")

    sweep_all_pending(now=T0)

    assert _count("active_shares") == 1
    assert _raw("active_shares", row["token"]) == "Documents/Episode"
