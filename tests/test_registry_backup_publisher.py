from __future__ import annotations

import os
import sqlite3
import stat
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

import pytest

from podcast_mcp.edits.share_registry import SqliteShareRegistry
from podcast_mcp.util import registry_backup


@pytest.fixture
def backup_paths(tmp_path: Path):
    source = SqliteShareRegistry(tmp_path / "host" / "registry.db")
    output = tmp_path / "backups"
    output.mkdir(mode=0o700)
    try:
        yield source, output / "new.sqlite"
    finally:
        source.close()


def assert_snapshot(path: Path, secret: bytes) -> None:
    with closing(sqlite3.connect(path)) as observer:
        assert observer.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert observer.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        assert observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
    assert not any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal"))


def test_private_owned_stream_descriptor_and_standalone_snapshot(backup_paths, monkeypatch):
    source, destination = backup_paths
    secret = source.recording_key_secret()
    copy = registry_backup._copy_snapshot
    observed = []

    def inspect(read_fd, write_fd):
        if os.name == "posix":
            assert stat.S_IMODE(os.fstat(read_fd).st_mode) == 0o600
            assert stat.S_IMODE(os.fstat(write_fd).st_mode) == 0o600
        assert not destination.exists()
        snapshot = next(source.db_path.parent.glob(".registry-snapshot-*/registry.sqlite"))
        assert_snapshot(snapshot, secret)
        observed.append(os.fstat(write_fd).st_ino)
        copy(read_fd, write_fd)

    monkeypatch.setattr(registry_backup, "_copy_snapshot", inspect)
    assert source.backup_to_new(destination) == destination
    assert observed == [destination.stat().st_ino]
    assert_snapshot(destination, secret)
    assert list(destination.parent.iterdir()) == [destination]
    assert not list(source.db_path.parent.glob(".registry-snapshot-*"))


@pytest.mark.parametrize("stage", ["stream", "file_fsync", "publish"])
@pytest.mark.parametrize("failure", [OSError("injected backup error"), KeyboardInterrupt()])
def test_prepublication_failures_preserve_other_backup_and_clean_owned_files(
    backup_paths, monkeypatch, stage, failure
):
    source, destination = backup_paths
    source.recording_key_secret()
    previous = destination.with_name("previous.sqlite")
    previous.write_bytes(b"previous backup")
    original_fsync = os.fsync

    def fail(*args, **kwargs):
        if stage == "stream":
            os.write(args[1], b"partial private bytes")
        raise failure

    def fsync(fd):
        if stat.S_ISREG(os.fstat(fd).st_mode):
            raise failure
        return original_fsync(fd)

    if stage == "stream":
        monkeypatch.setattr(registry_backup, "_copy_snapshot", fail)
    elif stage == "file_fsync":
        monkeypatch.setattr(os, "fsync", fsync)
    else:
        backend = (
            registry_backup.WindowsDirectory if os.name == "nt" else registry_backup.PosixDirectory
        )
        monkeypatch.setattr(backend, "publish", fail)
    with pytest.raises(type(failure)) as caught:
        source.backup_to_new(destination)
    assert caught.value is failure
    assert previous.read_bytes() == b"previous backup"
    assert list(destination.parent.iterdir()) == [previous]
    assert not list(source.db_path.parent.glob(".registry-snapshot-*"))


def test_directory_durability_failure_keeps_published_backup(backup_paths, monkeypatch):
    source, destination = backup_paths
    secret = source.recording_key_secret()
    backend = (
        registry_backup.WindowsDirectory if os.name == "nt" else registry_backup.PosixDirectory
    )

    def fail(self):
        raise OSError("directory sync failed")

    monkeypatch.setattr(backend, "sync", fail)
    with pytest.raises(OSError, match="was published"):
        source.backup_to_new(destination)
    assert_snapshot(destination, secret)
    assert list(destination.parent.iterdir()) == [destination]


@pytest.mark.parametrize("cleanup_failure", [OSError("cleanup failed"), KeyboardInterrupt()])
def test_cleanup_failure_preserves_original_cancellation(
    backup_paths, monkeypatch, cleanup_failure
):
    source, destination = backup_paths
    backend = (
        registry_backup.WindowsDirectory if os.name == "nt" else registry_backup.PosixDirectory
    )
    original = backend.remove_file
    cancellation = KeyboardInterrupt()

    def copy(read_fd, write_fd):
        raise cancellation

    def fail_stage_cleanup(self, name, expected):
        if name.endswith(".partial"):
            raise cleanup_failure
        original(self, name, expected)

    monkeypatch.setattr(registry_backup, "_copy_snapshot", copy)
    monkeypatch.setattr(backend, "remove_file", fail_stage_cleanup)
    with pytest.raises(KeyboardInterrupt) as caught:
        source.backup_to_new(destination)
    assert caught.value is cancellation
    assert any("cleanup" in note for note in caught.value.__notes__)
    assert not destination.exists()
    assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
    assert len(list(destination.parent.iterdir())) == 1


def test_concurrent_same_destination_has_one_immutable_winner(backup_paths, monkeypatch):
    source, destination = backup_paths
    secret = source.recording_key_secret()
    second = SqliteShareRegistry(source.db_path)
    backend = (
        registry_backup.WindowsDirectory if os.name == "nt" else registry_backup.PosixDirectory
    )
    publish = backend.publish
    barrier = threading.Barrier(2)

    def race(self, *args):
        barrier.wait()
        return publish(self, *args)

    def attempt(owner):
        try:
            return owner.backup_to_new(destination)
        except FileExistsError:
            return "refused"

    monkeypatch.setattr(backend, "publish", race)
    try:
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(attempt, [source, second]))
        assert results.count(destination) == 1
        assert results.count("refused") == 1
        assert_snapshot(destination, secret)
        assert list(destination.parent.iterdir()) == [destination]
        assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
    finally:
        second.close()


@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
def test_reserved_destination_sidecar_refuses_before_snapshot(backup_paths, suffix):
    source, destination = backup_paths
    sidecar = Path(str(destination) + suffix)
    sidecar.write_bytes(b"existing state")
    with pytest.raises(FileExistsError):
        source.backup_to_new(destination)
    assert sidecar.read_bytes() == b"existing state"
    assert not destination.exists()
    assert not list(source.db_path.parent.glob(".registry-snapshot-*"))


def test_missing_destination_parent_is_not_created(backup_paths):
    source, destination = backup_paths
    missing = destination.parent / "missing" / "new.sqlite"
    with pytest.raises(FileNotFoundError):
        source.backup_to_new(missing)
    assert not missing.parent.exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="native macOS extended ACL")
def test_mac_extended_read_grant_is_refused_before_secret_copy(backup_paths):
    source, destination = backup_paths
    source.recording_key_secret()
    result = subprocess.run(
        ["/bin/chmod", "+a", "everyone allow read,search", str(destination.parent)],
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, "disposable ACL setup failed"
    try:
        with pytest.raises(PermissionError, match="ACL"):
            source.backup_to_new(destination)
        assert not destination.exists()
        assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
    finally:
        subprocess.run(
            ["/bin/chmod", "-N", str(destination.parent)], check=True, capture_output=True
        )
