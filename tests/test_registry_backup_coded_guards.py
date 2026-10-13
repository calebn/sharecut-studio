from __future__ import annotations

import os
import pickle
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
        error.guest_message()
        == "The host's sharing setup needs attention; ask the host to check it."
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


@pytest.mark.skipif(os.name != "posix", reason="isolated POSIX descriptors")
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


@pytest.mark.skipif(os.name != "posix", reason="isolated POSIX descriptors")
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
@pytest.mark.skipif(os.name != "posix", reason="isolated POSIX descriptors")
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
@pytest.mark.skipif(os.name != "posix", reason="isolated POSIX descriptors")
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


@pytest.mark.parametrize(
    "site",
    [
        "anchor",
        "chain",
        "scope",
        "exists",
        "workspace",
        "created_file",
        "verify_file",
        "publish",
        "remove_file",
        "remove_workspace",
    ],
)
def test_every_windows_name_caller_supplies_full_path(monkeypatch, site):
    path = PureWindowsPath("C:/private/NUL")
    directory = windows.BackupDirectory.__new__(windows.BackupDirectory)
    directory.path = path.parent
    with pytest.raises(PermissionError) as caught:
        if site == "anchor":
            monkeypatch.setattr(publisher, "os", SimpleNamespace(fspath=os.fspath, name="nt"))
            publisher._anchor_path(str(path))
        elif site == "chain":
            windows._open_chain(None, path)
        elif site == "scope":
            with windows.registry_scope(path.parent, ("NUL",), create=False):
                pytest.fail("invalid name must refuse before acquiring resources")
        elif site in ("workspace", "created_file"):
            with getattr(directory, site)("NUL"):
                pytest.fail("invalid name must refuse before acquiring resources")
        elif site == "exists":
            directory.exists("NUL")
        elif site == "publish":
            directory.publish("stage", "NUL", (1, 2), 0)
        else:
            getattr(directory, site)("NUL", (1, 2))
    assert_refusal(
        caught.value,
        path,
        "backup path {path} does not denote an unambiguous Windows regular file",
        "choose a plain filename without reserved devices, streams, forbidden characters, trailing dot or space",
        "registry_backup_invalid_path",
    )


@pytest.mark.parametrize("site", ["verification", "cleanup", "replacement"])
@pytest.mark.skipif(os.name != "posix", reason="isolated POSIX descriptors")
def test_postpublication_coded_failure_preserves_outcome_bytes_and_cli(tmp_path, monkeypatch, site):
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app
    from podcast_mcp.edits import share_registry
    from podcast_mcp.util.registry_privacy_error import RegistryPrivacyError, RegistryPrivacyReason

    source_dir, output_dir = tmp_path / "source", tmp_path / "output"
    source_dir.mkdir(mode=0o700)
    output_dir.mkdir(mode=0o700)
    source, destination = source_dir / "live.sqlite", output_dir / "backup.sqlite"
    error_path = destination if site != "cleanup" else output_dir / "stage.sqlite"
    failure = RegistryPrivacyError(error_path, RegistryPrivacyReason.BACKUP_FILE_CHANGED)

    class BoundDirectory(posix.BackupDirectory):
        def __init__(self, path):
            self.path = path
            self._chain = [(os.open(path, os.O_RDONLY | os.O_DIRECTORY), None)]
            self.verify()

        def verify_file(self, name, expected):
            nonlocal failure
            if self.path / name == destination and site == "replacement":
                destination.unlink()
                destination.write_bytes(b"substituted final bytes")
                destination.chmod(0o600)
            try:
                super().verify_file(name, expected)
            except RegistryPrivacyError as exc:
                failure = exc
                raise
            if self.path / name == destination and site == "verification":
                raise failure

        def remove_file(self, name, expected):
            super().remove_file(name, expected)
            if self.path == output_dir and site == "cleanup":
                raise failure

    monkeypatch.setattr(posix, "BackupDirectory", BoundDirectory)
    monkeypatch.setattr(publisher, "_directory", BoundDirectory)

    def backup(_destination):
        return publisher.publish_registry_backup(
            source, destination, lambda path: path.write_bytes(b"published snapshot")
        )

    monkeypatch.setattr(share_registry, "backup_share_registry", backup)
    monkeypatch.setattr(share_registry, "default_share_registry_db_path", lambda: source)
    result = CliRunner().invoke(app, ["review", "backup-registry", "--dest", str(destination)])
    assert result.exit_code == 1
    assert result.output == (
        f"Error: registry backup was published at {destination}; backup file {error_path} "
        "changed identity or regular-file type; stop processes replacing this backup file, "
        "then retry (code registry_backup_integrity_changed) (set PODCAST_DEBUG=1 for the traceback)\n"
    )
    assert destination.read_bytes() == (
        b"substituted final bytes" if site == "replacement" else b"published snapshot"
    )
    assert isinstance(failure, HostSetupError)
    assert failure.path == error_path
    restored = pickle.loads(pickle.dumps(failure))
    assert isinstance(restored, RegistryPrivacyError)
    assert str(restored) == (
        f"registry backup was published at {destination}; backup file {error_path} "
        "changed identity or regular-file type; stop processes replacing this backup file, then retry"
    )
    assert restored.code == "registry_backup_integrity_changed"
    assert restored.path == error_path
    assert restored.reason == RegistryPrivacyReason.BACKUP_FILE_CHANGED
    assert restored.fix == "stop processes replacing this backup file, then retry"
    assert (
        restored.guest_message()
        == "The host's sharing setup needs attention; ask the host to check it."
    )
    assert (
        failure.guest_message()
        == "The host's sharing setup needs attention; ask the host to check it."
    )
    assert list(output_dir.iterdir()) == [destination]
    assert list(source_dir.iterdir()) == []


@pytest.mark.skipif(os.name != "posix", reason="isolated POSIX descriptors")
def test_registry_scope_cleanup_callback_keeps_parent_path(private_directory, monkeypatch):
    from contextlib import contextmanager

    directory = private_directory
    real_new_file = posix._new_file
    monkeypatch.setattr(
        posix, "_open_chain", lambda *_args, **_kwargs: [(os.dup(directory.fd), None)]
    )

    @contextmanager
    def substituted_file(path, parent, name, remove):
        with real_new_file(path, parent, name, remove) as created:
            created.acquire()
            created.path.rename(path / "original.sqlite")
            created.path.write_bytes(b"substituted")
            created.path.chmod(0o600)
            remove(name, created.identity)
            yield created

    monkeypatch.setattr(posix, "_new_file", substituted_file)
    with pytest.raises(PermissionError) as caught:
        with posix.registry_scope(directory.path, ("registry.sqlite",), create=True):
            pytest.fail("substituted cleanup must refuse")
    assert_refusal(
        caught.value,
        directory.path / "registry.sqlite",
        "cleanup refused substituted backup file {path}",
        "inspect the retained file and stop replacements before retrying",
    )
    assert (directory.path / "registry.sqlite").read_bytes() == b"substituted"
    assert (directory.path / "original.sqlite").read_bytes() == b""


@pytest.mark.skipif(os.name != "posix", reason="isolated POSIX descriptors")
def test_owned_posix_cleanup_removes_file_and_is_idempotent(private_directory):
    directory = private_directory
    target = directory.path / "backup.sqlite"
    target.write_bytes(b"owned")
    expected = posix.identity(target.stat())
    with target.open("rb"):
        directory.remove_file(target.name, expected)
        directory.remove_file(target.name, expected)
        assert list(directory.path.iterdir()) == []
        target.write_bytes(b"substituted")
        with pytest.raises(PermissionError) as caught:
            directory.remove_file(target.name, expected)
        assert_refusal(
            caught.value,
            target,
            "cleanup refused substituted backup file {path}",
            "inspect the retained file and stop replacements before retrying",
        )
        assert target.read_bytes() == b"substituted"


@pytest.mark.parametrize(
    ("reason", "code"),
    [
        ("invalid_backup_name", "registry_backup_invalid_path"),
        ("snapshot_changed", "registry_backup_integrity_changed"),
    ],
)
@pytest.mark.parametrize("wrapped", [False, True])
def test_new_guard_codes_keep_guest_projections_and_server_failure(
    tmp_path, monkeypatch, reason, code, wrapped
):
    import logging

    from podcast_mcp.gui.routes.guest_errors import guest_http_error, guest_ws_error
    from podcast_mcp.services.remote_mcp import protocol
    from podcast_mcp.util.registry_privacy_error import RegistryPrivacyError, RegistryPrivacyReason
    from podcast_mcp.util.tool_refusal import guest_failure_detail, tool_refusal

    error = RegistryPrivacyError(
        tmp_path / "SENTINEL-'q' \"d\" $HOME" / "secret.sqlite", RegistryPrivacyReason(reason)
    )
    if wrapped:
        wrapped_error = PermissionError("SENTINEL wrapper")
        wrapped_error.__cause__ = error
        error = wrapped_error
    message = "The host's sharing setup needs attention; ask the host to check it."
    guest = tool_refusal(error, for_guest=True)
    assert guest.message == message
    assert guest.code == code
    assert guest_failure_detail(error) == message
    http = guest_http_error(error, logger=logging.getLogger(__name__), operation="guard")
    assert http.status_code == 500
    assert http.detail == message
    assert http.headers == {"X-Sharecut-Error-Code": code}
    ws = guest_ws_error(error, logger=logging.getLogger(__name__), operation="guard")
    assert (ws.detail, ws.code, ws.close_code) == (message, code, 4403)
    assert protocol._tool_failure(1, "guest_get_project", error) == {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "content": [{"type": "text", "text": message}],
            "structuredContent": {"ok": False, "error": message, "error_code": code},
            "isError": True,
        },
    }

    def refuse(_token):
        raise error

    monkeypatch.setattr(protocol, "resolve_remote_mcp_context", refuse)
    assert protocol.handle_mcp_jsonrpc(
        "unused", {"jsonrpc": "2.0", "id": 1, "method": "initialize"}
    ) == {
        "jsonrpc": "2.0",
        "id": 1,
        "error": {"code": -32603, "message": message, "data": {"error_code": code}},
    }
