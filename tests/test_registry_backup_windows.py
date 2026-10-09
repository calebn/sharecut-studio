from __future__ import annotations

import ctypes
import json
import os
import secrets
import sqlite3
import subprocess
import uuid
from contextlib import closing, contextmanager
from ctypes import wintypes
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from podcast_mcp.edits.share_registry import SqliteShareRegistry
from podcast_mcp.util import registry_backup
from podcast_mcp.util.registry_backup_windows import _WindowsAPI
from podcast_mcp.util.registry_cleanup import cleanup

pytestmark = pytest.mark.skipif(os.name != "nt", reason="requires native Windows NTFS and accounts")


def _system_program(name: str) -> str:
    return str(Path(os.environ["SYSTEMROOT"]) / "System32" / name)


def _run(arguments, *, account: _Account | None = None, create: bool = False):
    payload = None
    if account is not None:
        payload = (
            json.dumps({"name": account.name, "password": account.password})
            if create
            else account.name
        )
    try:
        result = subprocess.run(
            arguments, input=payload, text=True, capture_output=True, check=False, timeout=30
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("disposable Windows actor setup timed out") from None
    if result.returncode:
        message = result.stdout + result.stderr
        if account is not None:
            message = message.replace(account.password, "[redacted]")
        raise RuntimeError(
            f"disposable Windows actor setup failed with status {result.returncode}: {message}"
        )


@dataclass(frozen=True)
class _Account:
    name: str
    password: str = field(repr=False)


@pytest.fixture
def other_account():
    account = _Account("sc" + uuid.uuid4().hex[:12], secrets.token_urlsafe(24) + "aA1!")
    program = _system_program("WindowsPowerShell/v1.0/powershell.exe")
    try:
        _run(
            [
                program,
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$actor = [Console]::In.ReadToEnd() | ConvertFrom-Json; "
                "$password = ConvertTo-SecureString -String $actor.password -AsPlainText -Force; "
                "New-LocalUser -Name $actor.name -Password $password -ErrorAction Stop | Out-Null",
            ],
            account=account,
            create=True,
        )
        yield account
    finally:
        cleanup(
            [
                lambda: _run(
                    [
                        program,
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "$name = [Console]::In.ReadToEnd(); "
                        "$actor = Get-LocalUser -Name $name -ErrorAction SilentlyContinue; "
                        "if ($actor) { Remove-LocalUser -Name $name -ErrorAction Stop }",
                    ],
                    account=account,
                )
            ]
        )


@contextmanager
def _impersonate(account):
    api = _WindowsAPI()
    api.security.LogonUserW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.HANDLE),
    ]
    api.security.LogonUserW.restype = wintypes.BOOL
    api.security.ImpersonateLoggedOnUser.argtypes = [wintypes.HANDLE]
    api.security.ImpersonateLoggedOnUser.restype = wintypes.BOOL
    api.security.RevertToSelf.argtypes = []
    api.security.RevertToSelf.restype = wintypes.BOOL
    token = wintypes.HANDLE()
    api.check(
        api.security.LogonUserW(account.name, ".", account.password, 2, 0, ctypes.byref(token))
    )
    try:
        api.check(api.security.ImpersonateLoggedOnUser(token))
        try:
            yield
        finally:
            api.check(api.security.RevertToSelf())
    finally:
        api.kernel.CloseHandle(token)


def test_other_account_cannot_read_snapshot_stream_or_published_secret(
    tmp_path, monkeypatch, other_account
):
    source = SqliteShareRegistry(tmp_path / "host" / "registry.db")
    secret = source.recording_key_secret()
    output = tmp_path / "backups"
    output.mkdir()
    destination = output / "new.sqlite"
    original = registry_backup._copy_snapshot
    journal = Path(str(source.db_path) + "-journal")
    journal.touch(mode=0o600)
    source_family = list(source.db_path.parent.glob("registry.db*"))
    assert source.db_path in source_family
    assert Path(str(source.db_path) + "-wal") in source_family
    assert Path(str(source.db_path) + "-shm") in source_family
    assert journal in source_family
    checked = []

    def copy(read_fd, write_fd):
        snapshot = next(source.db_path.parent.glob(".registry-snapshot-*/registry.sqlite"))
        stage = next(output.glob("*.partial"))
        with _impersonate(other_account):
            for path in (*source_family, snapshot, stage):
                with pytest.raises(PermissionError):
                    with path.open("rb"):
                        pytest.fail("another account read private secret staging")
        checked.append(True)
        original(read_fd, write_fd)

    monkeypatch.setattr(registry_backup, "_copy_snapshot", copy)
    try:
        source.backup_to_new(destination)
        assert checked == [True]
        with _impersonate(other_account):
            with pytest.raises(PermissionError):
                with destination.open("rb"):
                    pytest.fail("another account read the published secret")
        with closing(sqlite3.connect(destination)) as restored:
            assert (
                restored.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
    finally:
        source.close()


def test_native_extended_read_grant_refuses_before_copy(tmp_path):
    source = SqliteShareRegistry(tmp_path / "host" / "registry.db")
    output = tmp_path / "backups"
    output.mkdir()
    destination = output / "new.sqlite"
    try:
        _run([_system_program("icacls.exe"), str(output), "/grant", "*S-1-1-0:(OI)(CI)R"])
        with pytest.raises(PermissionError, match="unsafe access"):
            source.backup_to_new(destination)
        assert list(output.iterdir()) == []
        assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
    finally:
        source.close()


def test_native_junction_ancestry_is_refused(tmp_path):
    source = SqliteShareRegistry(tmp_path / "host" / "registry.db")
    private = tmp_path / "backups"
    private.mkdir()
    junction = tmp_path / "alias"
    _run([_system_program("cmd.exe"), "/c", "mklink", "/J", str(junction), str(private)])
    try:
        with pytest.raises(PermissionError, match="reparse"):
            source.backup_to_new(junction / "new.sqlite")
        assert list(private.iterdir()) == []
    finally:
        junction.rmdir()
        source.close()


@pytest.mark.parametrize(
    "name", ["backup.sqlite:secret", "NUL.sqlite", "CON .bak", "backup.", "backup "]
)
def test_native_ambiguous_final_name_refuses_without_snapshot(tmp_path, name):
    source = SqliteShareRegistry(tmp_path / "host" / "registry.db")
    secret = source.recording_key_secret()
    output = tmp_path / "backups"
    output.mkdir()
    try:
        with pytest.raises(PermissionError, match="unambiguous"):
            source.backup_to_new(output / name)
        assert list(output.iterdir()) == []
        assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
        assert source.recording_key_secret() == secret
    finally:
        source.close()
