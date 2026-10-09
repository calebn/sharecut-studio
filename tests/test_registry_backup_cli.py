import json
import os
import sqlite3
import stat
from contextlib import closing
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits import share_registry
from podcast_mcp.edits.share_registry import get_share_registry


def test_cli_backup_publishes_secret_then_refuses_same_name(tmp_path: Path) -> None:
    registry = get_share_registry()
    secret = registry.recording_key_secret()
    output = tmp_path / "backups"
    output.mkdir(mode=0o700)
    destination = output / "new.sqlite"
    runner = CliRunner()
    arguments = ["review", "backup-registry", "--dest", str(destination)]
    created = runner.invoke(app, arguments)
    assert created.exit_code == 0, created.output
    assert json.loads(created.stdout) == {
        "source": str(registry.db_path),
        "backup": str(destination),
    }
    assert secret.hex() not in created.output
    with closing(sqlite3.connect(destination)) as restored:
        assert restored.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
    original = destination.stat().st_ino, destination.read_bytes()
    refused = runner.invoke(app, arguments)
    assert refused.exit_code == 1
    assert "must be unused" in refused.output
    assert (destination.stat().st_ino, destination.read_bytes()) == original
    assert list(output.iterdir()) == [destination]
    assert registry.recording_key_secret() == secret


def test_cli_default_names_are_distinct_complete_backups() -> None:
    registry = get_share_registry()
    secret = registry.recording_key_secret()
    runner = CliRunner()
    paths = []
    for _ in range(2):
        result = runner.invoke(app, ["review", "backup-registry"])
        assert result.exit_code == 0, result.output
        destination = Path(json.loads(result.stdout)["backup"])
        paths.append(destination)
        with closing(sqlite3.connect(destination)) as restored:
            assert (
                restored.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
    assert paths[0] != paths[1]
    assert all(path.parent == registry.db_path.parent for path in paths)


@pytest.mark.skipif(os.name != "posix", reason="POSIX raw destination namespace")
@pytest.mark.parametrize("destination_kind", ["parent-alias", "leaf-alias", "dotdot"])
def test_cli_backup_refuses_raw_destination_aliases_before_snapshot(
    tmp_path: Path, monkeypatch, destination_kind: str
) -> None:
    registry = get_share_registry()
    secret = registry.recording_key_secret()
    registry.claim_active(
        {
            "token": "cli-raw-path-token",
            "id": "cli-raw-path-token",
            "project_workspace": str(tmp_path),
            "review_version_id": "version",
        }
    )
    registry_path = registry.db_path
    registry_before = (
        registry_path.stat().st_ino,
        registry_path.read_bytes(),
        stat.S_IMODE(registry_path.stat().st_mode),
    )
    output = tmp_path / "backups"
    output.mkdir(mode=0o700)
    sentinel = output / "existing.sqlite"
    sentinel.write_bytes(b"prior private backup")
    sentinel_before = sentinel.stat().st_ino, sentinel.read_bytes()

    if destination_kind == "parent-alias":
        unsafe = tmp_path / "replaceable"
        unsafe.mkdir(mode=0o700)
        unsafe.chmod(0o777)
        alias_parent = unsafe / "backups-alias"
        alias_parent.symlink_to(output, target_is_directory=True)
        destination = alias_parent / "new.sqlite"
        alias_object = alias_parent
    elif destination_kind == "leaf-alias":
        destination = output / "new.sqlite"
        destination.symlink_to(sentinel)
        alias_object = destination
    else:
        unsafe = tmp_path / "replaceable"
        unsafe.mkdir(mode=0o700)
        unsafe.chmod(0o777)
        destination = unsafe / ".." / output.name / "new.sqlite"

    if destination_kind != "dotdot":
        alias_inode = alias_object.lstat().st_ino
        alias_target = alias_object.resolve()

    result = CliRunner().invoke(app, ["review", "backup-registry", "--dest", str(destination)])
    assert result.exit_code == 1, result.output
    assert not result.stdout.strip().startswith("{")
    assert (
        registry_path.stat().st_ino,
        registry_path.read_bytes(),
        stat.S_IMODE(registry_path.stat().st_mode),
    ) == registry_before
    assert registry.recording_key_secret() == secret
    assert registry.get_active("cli-raw-path-token")["token"] == "cli-raw-path-token"
    assert (sentinel.stat().st_ino, sentinel.read_bytes()) == sentinel_before
    assert not list(registry_path.parent.glob(".registry-snapshot-*"))
    if destination_kind == "leaf-alias":
        assert destination.is_symlink()
        assert destination.lstat().st_ino == alias_inode
        assert destination.resolve() == alias_target
        assert sorted(output.iterdir(), key=lambda path: path.name) == sorted(
            [sentinel, destination], key=lambda path: path.name
        )
    else:
        if destination_kind == "parent-alias":
            assert alias_object.is_symlink()
            assert alias_object.lstat().st_ino == alias_inode
            assert alias_object.resolve() == alias_target
        assert not (output / "new.sqlite").exists()
        assert list(output.iterdir()) == [sentinel]
    if destination_kind != "leaf-alias":
        assert stat.S_IMODE(unsafe.stat().st_mode) == 0o777


@pytest.mark.skipif(os.name != "posix", reason="POSIX raw registry namespace")
def test_cli_backup_refuses_raw_default_registry_alias_before_copy(tmp_path, monkeypatch):
    target = tmp_path / "trusted" / "registry.sqlite"
    with closing(share_registry.SqliteShareRegistry(target)) as owner:
        secret = owner.recording_key_secret()
        owner.claim_active(
            {
                "token": "cli-source-sentinel",
                "id": "cli-source-sentinel",
                "project_workspace": str(tmp_path),
                "review_version_id": "version",
            }
        )
    before = target.stat().st_ino, target.read_bytes(), stat.S_IMODE(target.stat().st_mode)
    unsafe = tmp_path / "replaceable"
    unsafe.mkdir(mode=0o700)
    unsafe.chmod(0o777)
    alias = unsafe / "registry.sqlite"
    alias.symlink_to(target)
    output = tmp_path / "backups"
    output.mkdir(mode=0o700)
    destination = output / "new.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(alias))
    share_registry.reset_share_registry_for_tests()

    result = CliRunner().invoke(app, ["review", "backup-registry", "--dest", str(destination)])

    assert result.exit_code == 1, result.output
    assert not result.stdout.strip().startswith("{")
    assert not destination.exists()
    assert list(output.iterdir()) == []
    assert not list(target.parent.glob(".registry-snapshot-*"))
    assert (
        target.stat().st_ino,
        target.read_bytes(),
        stat.S_IMODE(target.stat().st_mode),
    ) == before
    with closing(sqlite3.connect(target)) as observer:
        assert observer.execute("SELECT token FROM active_shares ORDER BY token").fetchall() == [
            ("cli-source-sentinel",)
        ]
        assert observer.execute("SELECT secret FROM recording_key_secret").fetchone() == (secret,)
