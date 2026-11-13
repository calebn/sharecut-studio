from __future__ import annotations

import os
from pathlib import Path

import pytest

from podcast_mcp.util import registry_backup_posix
from podcast_mcp.util.host_platform import IOS, MACOS, using
from podcast_mcp.util.registry_privacy_error import RegistryPrivacyError, RegistryPrivacyReason

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX ancestor permissions")


def _container_under_a_world_writable_parent(tmp_path: Path) -> Path:
    outer = tmp_path / "outer"
    outer.mkdir()
    outer.chmod(0o777)
    container = outer / "container"
    container.mkdir()
    return container


def test_a_world_writable_ancestor_of_the_container_is_refused_on_desktop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    container = _container_under_a_world_writable_parent(tmp_path)
    monkeypatch.setenv("HOME", str(container))
    with using(MACOS), pytest.raises(RegistryPrivacyError) as refused:
        with registry_backup_posix.registry_scope(container / "state", ("r.sqlite",), create=True):
            pass
    assert refused.value.reason is RegistryPrivacyReason.PARENT_WRITABLE


def test_the_ios_row_stops_the_ancestor_walk_at_the_app_container(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    container = _container_under_a_world_writable_parent(tmp_path)
    monkeypatch.setenv("HOME", str(container))
    with (
        using(IOS),
        registry_backup_posix.registry_scope(container / "state", ("r.sqlite",), create=True),
    ):
        assert (container / "state").is_dir()


def test_the_ios_row_still_refuses_a_world_writable_directory_inside_the_container(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    container = tmp_path / "container"
    shared = container / "shared"
    shared.mkdir(parents=True)
    shared.chmod(0o777)
    monkeypatch.setenv("HOME", str(container))
    with using(IOS), pytest.raises(RegistryPrivacyError) as refused:
        with registry_backup_posix.registry_scope(shared / "state", ("r.sqlite",), create=True):
            pass
    assert refused.value.reason is RegistryPrivacyReason.PARENT_WRITABLE
