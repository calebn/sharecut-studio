from __future__ import annotations

import os
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace

import pytest

from podcast_mcp.util import registry_backup as publisher
from podcast_mcp.util import registry_backup_posix as posix
from podcast_mcp.util import registry_backup_windows as windows
from podcast_mcp.util.coded_error import HostSetupError


def assert_refusal(error, path, problem, fix, code="registry_backup_integrity_changed"):
    assert isinstance(error, HostSetupError)
    assert error.code == code
    assert error.path == path
    shown = f'"{path}"' if isinstance(path, PureWindowsPath) else str(path)
    assert str(error) == f"{problem.format(path=shown)}; {fix}"
    assert (
        error.guest_message == "The host's sharing setup needs attention; ask the host to check it."
    )


def test_ambiguous_windows_anchor_is_coded(monkeypatch):
    monkeypatch.setattr(publisher, "os", SimpleNamespace(fspath=os.fspath, name="nt"))
    with pytest.raises(PermissionError) as caught:
        publisher._anchor_path("C:backup.sqlite")
    assert_refusal(
        caught.value,
        PureWindowsPath("C:backup.sqlite"),
        "registry path {path} has an ambiguous Windows anchor",
        "choose a fully anchored local Windows path or an ordinary relative path",
        "registry_backup_invalid_path",
    )


def test_invalid_windows_name_keeps_full_path():
    directory = windows.BackupDirectory.__new__(windows.BackupDirectory)
    directory.path = PureWindowsPath("C:/private")
    with pytest.raises(PermissionError) as caught:
        directory.exists("NUL")
    assert_refusal(
        caught.value,
        directory.path / "NUL",
        "backup path {path} does not denote an unambiguous Windows regular file",
        "choose a plain filename without reserved devices, streams, forbidden characters, trailing dot or space",
        "registry_backup_invalid_path",
    )


@pytest.fixture
def private_directory(tmp_path):
    tmp_path.chmod(0o700)
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    directory = posix.BackupDirectory.__new__(posix.BackupDirectory)
    directory.path = tmp_path
    directory._chain = [(fd, None)]
    try:
        yield directory
    finally:
        directory.close()


def test_posix_directory_replacement_is_coded(private_directory):
    directory = private_directory
    child = directory.path / "child"
    child.mkdir(mode=0o700)
    fd = os.open(child, os.O_RDONLY | os.O_DIRECTORY)
    child.rename(directory.path / "retained")
    child.mkdir(mode=0o700)
    try:
        with pytest.raises(PermissionError) as caught:
            posix._verify_chain([(directory.fd, None), (fd, "child")], Path("parent/child"))
        assert_refusal(
            caught.value,
            Path("parent/child"),
            "registry directory {path} changed during access",
            "stop processes replacing this directory, then retry",
        )
        assert (directory.path / "retained").is_dir()
    finally:
        os.close(fd)


def test_posix_unopened_registry_replacement_is_coded(private_directory, monkeypatch):
    directory = private_directory
    target = directory.path / "registry.sqlite"
    target.write_bytes(b"original")
    target.chmod(0o600)
    real_stat = os.stat
    calls = 0

    def stat_entry(name, *args, **kwargs):
        nonlocal calls
        if name == "registry.sqlite" and kwargs.get("dir_fd") == directory.fd:
            calls += 1
            if calls == 2:
                target.rename(directory.path / "original.sqlite")
                target.write_bytes(b"substituted")
                target.chmod(0o600)
        return real_stat(name, *args, **kwargs)

    monkeypatch.setattr(posix.os, "stat", stat_entry)
    with pytest.raises(PermissionError) as caught:
        posix._check_unopened_file(directory.path, directory.fd, target.name)
    assert_refusal(
        caught.value,
        target,
        "registry file {path} changed during access",
        "stop processes replacing this registry file, then retry",
    )
    assert target.read_bytes() == b"substituted"


@pytest.mark.parametrize("site", ["remove-file", "verify-file", "reader", "remove-workspace"])
def test_posix_backup_identity_refusals(private_directory, monkeypatch, site):
    directory = private_directory
    target = directory.path / "backup.sqlite"
    if site == "remove-workspace":
        target.mkdir(mode=0o700)
    else:
        target.write_bytes(b"retained bytes")
        target.chmod(0o600)
    expected = (-1, -1)
    opened = []
    real_open = os.open

    def tracked_open(*args, **kwargs):
        fd = real_open(*args, **kwargs)
        opened.append(fd)
        return fd

    monkeypatch.setattr(posix.os, "open", tracked_open)
    if site == "reader":
        original_verify = directory.verify_file

        def verify_then_replace(name, identity):
            original_verify(name, identity)
            target.rename(directory.path / "original.sqlite")
            target.write_bytes(b"retained bytes")
            target.chmod(0o600)

        monkeypatch.setattr(directory, "verify_file", verify_then_replace)
        expected = posix.identity(target.stat())
    with pytest.raises(PermissionError) as caught:
        if site == "remove-file":
            directory.remove_file(target.name, expected)
        elif site == "verify-file":
            directory.verify_file(target.name, expected)
        elif site == "remove-workspace":
            directory.remove_workspace(target.name, expected)
        else:
            with directory.snapshot_reader(target.name, expected):
                pytest.fail("changed snapshot must not stream")
    problem, fix = {
        "remove-file": (
            "cleanup refused substituted backup file {path}",
            "inspect the retained file and stop replacements before retrying",
        ),
        "verify-file": (
            "backup file {path} changed identity or regular-file type",
            "stop processes replacing this backup file, then retry",
        ),
        "reader": (
            "backup snapshot {path} changed before streaming",
            "stop processes replacing this snapshot, then retry the backup",
        ),
        "remove-workspace": (
            "cleanup refused substituted backup workspace {path}",
            "inspect the retained workspace and stop replacements before retrying",
        ),
    }[site]
    assert_refusal(caught.value, target, problem, fix)
    assert (
        target.is_dir() if site == "remove-workspace" else target.read_bytes() == b"retained bytes"
    )
    for fd in opened:
        with pytest.raises(OSError):
            os.fstat(fd)


@pytest.mark.parametrize("site", ["remove-file", "verify-file", "reader", "remove-workspace"])
def test_windows_backup_identity_refusals(tmp_path, monkeypatch, site):
    target = tmp_path / "backup.sqlite"
    if site == "remove-workspace":
        target.mkdir(mode=0o700)
    else:
        target.write_bytes(b"retained bytes")
    closed = []
    opened = []

    def open_handle(path, *_args):
        fd = os.open(path, os.O_RDONLY)
        opened.append(fd)
        return fd

    def close_handle(fd):
        closed.append(fd)
        os.close(fd)

    api = SimpleNamespace(
        open_file=open_handle,
        open_directory=open_handle,
        file_identity=lambda _fd, _path: (1, 2),
        close=close_handle,
        verify_handle=lambda *_args, **_kwargs: None,
        kernel=SimpleNamespace(CreateFileW=open_handle),
        crt=SimpleNamespace(open_osfhandle=lambda fd, _flags: fd, get_osfhandle=lambda fd: fd),
    )
    directory = windows.BackupDirectory.__new__(windows.BackupDirectory)
    directory.path, directory._api, directory._handles = tmp_path, api, []
    if site == "reader":
        monkeypatch.setattr(directory, "verify_file", lambda _name, _identity: None)
    with pytest.raises(PermissionError) as caught:
        if site == "remove-file":
            directory.remove_file(target.name, (3, 4))
        elif site == "verify-file":
            directory.verify_file(target.name, (3, 4))
        elif site == "remove-workspace":
            directory.remove_workspace(target.name, (3, 4))
        else:
            with directory.snapshot_reader(target.name, (3, 4)):
                pytest.fail("changed snapshot must not stream")
    problem, fix = {
        "remove-file": (
            "cleanup refused substituted backup file {path}",
            "inspect the retained file and stop replacements before retrying",
        ),
        "verify-file": (
            "backup file {path} changed identity or regular-file type",
            "stop processes replacing this backup file, then retry",
        ),
        "reader": (
            "backup snapshot {path} changed before streaming",
            "stop processes replacing this snapshot, then retry the backup",
        ),
        "remove-workspace": (
            "cleanup refused substituted backup workspace {path}",
            "inspect the retained workspace and stop replacements before retrying",
        ),
    }[site]
    assert_refusal(caught.value, target, problem, fix)
    assert (
        target.is_dir() if site == "remove-workspace" else target.read_bytes() == b"retained bytes"
    )
    assert closed == opened if site != "reader" else closed == []
    for fd in opened:
        with pytest.raises(OSError):
            os.fstat(fd)
