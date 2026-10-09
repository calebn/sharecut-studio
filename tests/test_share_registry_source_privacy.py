from __future__ import annotations

import os
import sqlite3
import stat
import subprocess
import sys
from contextlib import closing, contextmanager
from pathlib import Path

import pytest

from podcast_mcp.edits import share_registry
from registry_windows_fixture import powershell_environment


@contextmanager
def readable_acl(path: Path, *, inherited: bool = False):
    if os.name == "nt":
        program = str(Path(os.environ["SYSTEMROOT"]) / "System32" / "icacls.exe")
        grant = "(OI)(CI)(IO)R" if inherited else "RX" if path.is_dir() else "R"
        subprocess.run(
            [program, str(path), "/grant", f"*S-1-1-0:{grant}"], check=True, capture_output=True
        )
        try:
            yield
        finally:
            if path.exists():
                subprocess.run(
                    [program, str(path), "/remove:g", "*S-1-1-0"], check=True, capture_output=True
                )
        return
    grant = "everyone allow read,search" if path.is_dir() else "everyone allow read"
    if inherited:
        grant += ",file_inherit,directory_inherit"
    subprocess.run(["/bin/chmod", "+a", grant, str(path)], check=True, capture_output=True)
    try:
        yield
    finally:
        if path.exists():
            subprocess.run(["/bin/chmod", "-N", str(path)], check=True, capture_output=True)


def acl_listing(path: Path) -> str:
    if os.name == "nt":
        return subprocess.run(
            [str(Path(os.environ["SYSTEMROOT"]) / "System32" / "icacls.exe"), str(path)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    return subprocess.run(
        ["/bin/ls", "-lde", str(path)], check=True, capture_output=True, text=True
    ).stdout


def assert_refused_without_repair(action, target: Path) -> None:
    before = target.stat()
    contents = target.read_bytes() if target.is_file() else None
    acl = acl_listing(target)
    refused = False
    try:
        result = action()
        if isinstance(result, share_registry.SqliteShareRegistry):
            result.close()
    except PermissionError:
        refused = True
    assert target.stat().st_ino == before.st_ino
    assert acl_listing(target) == acl
    if contents is not None:
        unchanged = target.read_bytes() == contents
        assert unchanged, "unsafe source contents must remain unchanged"
    assert refused, "readable source ACL must fail closed before SQLite or secret access"


@pytest.mark.skipif(sys.platform != "darwin" and os.name != "nt", reason="native ACL setup")
@pytest.mark.parametrize("inherited", [False, True])
def test_initial_source_directory_acl_refused_before_database_creation(tmp_path, inherited):
    parent = tmp_path / "source"
    path = parent / "registry.sqlite"
    if inherited:
        with readable_acl(tmp_path, inherited=True):
            parent.mkdir() if os.name == "nt" else parent.mkdir(mode=0o700)
            try:
                listing = acl_listing(parent)
                assert "inherited" in listing if sys.platform == "darwin" else "(I)" in listing
                if os.name == "nt":
                    assert any(
                        "(I)" in line and ("Everyone" in line or "S-1-1-0" in line)
                        for line in listing.splitlines()
                    )
                    from podcast_mcp.util.registry_backup_windows import _WindowsAPI

                    api = _WindowsAPI()
                    for ancestor in parent.parents:
                        handle = api.open_directory(ancestor)
                        try:
                            api.verify_handle(handle, private=False, directory=True, path=ancestor)
                        finally:
                            api.close(handle)
                assert_refused_without_repair(
                    lambda: share_registry.SqliteShareRegistry(path), parent
                )
                assert not path.exists()
            finally:
                if os.name == "nt":
                    subprocess.run(
                        [
                            str(Path(os.environ["SYSTEMROOT"]) / "System32" / "icacls.exe"),
                            str(parent),
                            "/inheritance:r",
                        ],
                        check=True,
                        capture_output=True,
                    )
                else:
                    subprocess.run(
                        ["/bin/chmod", "-N", str(parent)], check=True, capture_output=True
                    )
    else:
        parent.mkdir(mode=0o700)
        with readable_acl(parent):
            assert_refused_without_repair(lambda: share_registry.SqliteShareRegistry(path), parent)
            assert not path.exists()


@pytest.mark.skipif(sys.platform != "darwin" and os.name != "nt", reason="native ACL setup")
@pytest.mark.parametrize("suffix", ["", "-wal", "-shm", "-journal"])
def test_existing_source_family_acl_refused_without_replacement(tmp_path, suffix):
    path = tmp_path / "source" / "registry.sqlite"
    with closing(share_registry.SqliteShareRegistry(path)) as owner:
        secret = owner.recording_key_secret()
    target = Path(str(path) + suffix)
    if suffix:
        target.write_bytes(b"")
        target.chmod(0o600)
    with readable_acl(target):
        assert_refused_without_repair(lambda: share_registry.SqliteShareRegistry(path), target)
    if suffix:
        target.unlink()
    with closing(share_registry.SqliteShareRegistry(path)) as recovered:
        assert recovered.recording_key_secret() == secret


@pytest.mark.skipif(sys.platform != "darwin" and os.name != "nt", reason="native ACL setup")
@pytest.mark.parametrize("site", ["directory", "", "-wal", "-shm", "-journal"])
@pytest.mark.parametrize("poisoned", [False, True])
@pytest.mark.parametrize("initialized", [False, True])
def test_secret_access_and_poisoned_reopen_recheck_source_acl(
    tmp_path, monkeypatch, site, poisoned, initialized
):
    path = tmp_path / "source" / "registry.sqlite"
    owner = share_registry.SqliteShareRegistry(path)
    secret = owner.recording_key_secret() if initialized else None
    if poisoned:
        failure = OSError("registry write failed")
        transaction = share_registry.immediate_transaction

        @contextmanager
        def fail_transaction(connection):
            with transaction(connection):
                yield
                raise failure

        with monkeypatch.context() as patch:
            patch.setattr(share_registry, "immediate_transaction", fail_transaction)
            with pytest.raises(OSError) as caught:
                owner.purge_expired_cooldown()
            assert caught.value is failure
        assert owner._connection_failed
    target = path.parent if site == "directory" else Path(str(path) + site)
    if not target.exists():
        target.write_bytes(b"")
        target.chmod(0o600)
    try:
        with readable_acl(target):
            assert_refused_without_repair(owner.recording_key_secret, target)
    finally:
        owner.close()
        if site in ("-wal", "-shm", "-journal") and target.exists():
            target.unlink()
    with closing(share_registry.SqliteShareRegistry(path)) as recovered:
        if initialized:
            assert recovered.recording_key_secret() == secret
        else:
            with closing(sqlite3.connect(path)) as observer:
                assert observer.execute("SELECT secret FROM recording_key_secret").fetchall() == []
            assert len(recovered.recording_key_secret()) == 32


def test_fresh_main_is_private_and_empty_before_sqlite_opens(tmp_path, monkeypatch):
    path = tmp_path / "new-source" / "registry.sqlite"
    connect = sqlite3.connect
    observed = []

    def inspect(database, *args, **kwargs):
        candidate = Path(database)
        if candidate == path:
            assert candidate.exists(), "main file must be created privately before SQLite opens"
            assert candidate.read_bytes() == b""
            assert_private(candidate)
            assert_private(candidate.parent)
            observed.append(candidate.stat().st_ino)
        return connect(database, *args, **kwargs)

    monkeypatch.setattr(share_registry.sqlite3, "connect", inspect)
    previous = os.umask(0) if os.name == "posix" else None
    try:
        with closing(share_registry.SqliteShareRegistry(path)) as owner:
            assert len(owner.recording_key_secret()) == 32
            assert observed == [path.stat().st_ino]
            for entry in path.parent.iterdir():
                assert_private(entry)
    finally:
        if previous is not None:
            os.umask(previous)


def assert_private(path: Path) -> None:
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == (0o700 if path.is_dir() else 0o600)
        return
    from podcast_mcp.util.registry_backup_windows import _WindowsAPI

    api = _WindowsAPI()
    if path.is_dir():
        handle = api.open_directory(path)
        try:
            api.verify_handle(handle, private=True, directory=True)
        finally:
            api.kernel.CloseHandle(handle)
    else:
        fd = os.open(path, os.O_RDONLY)
        try:
            api.verify_handle(api.crt.get_osfhandle(fd), private=True, directory=False)
        finally:
            os.close(fd)


@pytest.mark.skipif(os.name != "posix", reason="POSIX ordinary-account replaceable ancestry")
@pytest.mark.parametrize("existing", [False, True])
def test_private_source_below_replaceable_ancestor_is_refused(tmp_path, existing):
    ancestor = tmp_path / "replaceable"
    ancestor.mkdir(mode=0o700)
    path = ancestor / "private" / "registry.sqlite"
    if existing:
        with closing(share_registry.SqliteShareRegistry(path)) as owner:
            owner.recording_key_secret()
    else:
        path.parent.mkdir(mode=0o700)
    before = path.read_bytes() if existing else None
    ancestor.chmod(0o777)
    try:
        with pytest.raises(PermissionError):
            with closing(share_registry.SqliteShareRegistry(path)):
                pytest.fail(
                    "source ancestry permits an ordinary account to replace the private leaf"
                )
        assert path.read_bytes() == before if existing else not path.exists()
    finally:
        ancestor.chmod(0o700)


@pytest.mark.skipif(os.name != "nt", reason="native Windows protected child inheritance")
def test_fresh_windows_directory_installs_protected_private_inheritable_acl(tmp_path):
    path = tmp_path / "new-source" / "registry.sqlite"
    with closing(share_registry.SqliteShareRegistry(path)) as owner:
        assert len(owner.recording_key_secret()) == 32
        result = subprocess.run(
            [
                str(
                    Path(os.environ["SYSTEMROOT"])
                    / "System32"
                    / "WindowsPowerShell"
                    / "v1.0"
                    / "powershell.exe"
                ),
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$acl = Get-Acl -LiteralPath $env:SHARECUT_TEST_SOURCE; $acl.AreAccessRulesProtected; $acl.Sddl",
            ],
            check=True,
            capture_output=True,
            text=True,
            env=powershell_environment(overrides={"SHARECUT_TEST_SOURCE": str(path.parent)}),
        )
        lines = result.stdout.strip().splitlines()
        assert lines[0] == "True"
        assert "D:P" in lines[1]
        assert "OICI" in lines[1]


@pytest.mark.skipif(os.name != "nt", reason="native Windows replaceable source ancestry")
@pytest.mark.parametrize("existing", [False, True])
def test_windows_private_source_below_replaceable_ancestor_is_refused(tmp_path, existing):
    ancestor = tmp_path / "replaceable"
    ancestor.mkdir()
    path = ancestor / "private" / "registry.sqlite"
    if existing:
        with closing(share_registry.SqliteShareRegistry(path)) as owner:
            owner.recording_key_secret()
    else:
        path.parent.mkdir()
    before = path.read_bytes() if existing else None
    program = str(Path(os.environ["SYSTEMROOT"]) / "System32" / "icacls.exe")
    subprocess.run(
        [program, str(ancestor), "/grant", "*S-1-1-0:M"], check=True, capture_output=True
    )
    try:
        with pytest.raises(PermissionError):
            with closing(share_registry.SqliteShareRegistry(path)):
                pytest.fail("untrusted Windows source ancestry accepted")
        assert path.read_bytes() == before if existing else not path.exists()
    finally:
        subprocess.run(
            [program, str(ancestor), "/remove:g", "*S-1-1-0"], check=True, capture_output=True
        )


def test_sidecar_disappearance_is_not_a_privacy_failure(tmp_path, monkeypatch):
    path = tmp_path / "source" / "registry.sqlite"
    with closing(share_registry.SqliteShareRegistry(path)) as owner:
        secret = owner.recording_key_secret()
        journal = Path(str(path) + "-journal")
        journal.touch(mode=0o600)
        original = os.stat
        disappeared = []

        def stat_after_checkpoint(name, *args, **kwargs):
            if name == journal.name and kwargs.get("dir_fd") is not None and not disappeared:
                journal.unlink()
                disappeared.append(True)
            return original(name, *args, **kwargs)

        if os.name == "nt":
            from podcast_mcp.util.registry_backup_windows import _WindowsAPI

            open_file = _WindowsAPI.open_file

            def open_after_checkpoint(api, candidate):
                if candidate == journal and not disappeared:
                    journal.unlink()
                    disappeared.append(True)
                return open_file(api, candidate)

            monkeypatch.setattr(_WindowsAPI, "open_file", open_after_checkpoint)
        else:
            monkeypatch.setattr(os, "stat", stat_after_checkpoint)
        assert owner.recording_key_secret() == secret
        assert disappeared == [True]
