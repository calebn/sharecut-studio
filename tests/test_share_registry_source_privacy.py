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


@pytest.mark.skipif(os.name != "nt", reason="native Windows reparse-point ancestry")
@pytest.mark.parametrize("caller", ["default", "getter", "constructor"])
def test_native_registry_junction_alias_is_refused_without_switching_source(
    tmp_path, monkeypatch, caller
):
    target = tmp_path / "trusted" / "registry.sqlite"
    with closing(share_registry.SqliteShareRegistry(target)) as owner:
        secret = owner.recording_key_secret()
        owner.claim_active(
            {
                "token": "junction-source-sentinel",
                "id": "junction-source-sentinel",
                "project_workspace": str(tmp_path),
                "review_version_id": "version",
            }
        )
    before = target.stat().st_ino, target.read_bytes(), stat.S_IMODE(target.stat().st_mode)
    alias_parent = tmp_path / "source-junction"
    subprocess.run(
        [
            str(Path(os.environ["SYSTEMROOT"]) / "System32" / "cmd.exe"),
            "/c",
            "mklink",
            "/J",
            str(alias_parent),
            str(target.parent),
        ],
        check=True,
        capture_output=True,
        env=powershell_environment(),
    )
    raw_path = alias_parent / target.name

    if caller == "default":
        monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(raw_path))
        share_registry.reset_share_registry_for_tests()
        operation = share_registry.get_share_registry
    elif caller == "getter":

        def operation():
            return share_registry.get_share_registry(raw_path)
    else:

        def operation():
            return share_registry.SqliteShareRegistry(raw_path)

    try:
        with pytest.raises(PermissionError):
            result = operation()
            if isinstance(result, share_registry.SqliteShareRegistry):
                result.close()
        assert (
            target.stat().st_ino,
            target.read_bytes(),
            stat.S_IMODE(target.stat().st_mode),
        ) == before
        with closing(sqlite3.connect(target)) as observer:
            assert observer.execute(
                "SELECT token FROM active_shares ORDER BY token"
            ).fetchall() == [("junction-source-sentinel",)]
            assert observer.execute("SELECT secret FROM recording_key_secret").fetchone() == (
                secret,
            )
    finally:
        share_registry.reset_share_registry_for_tests()
        alias_parent.rmdir()


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


@pytest.mark.skipif(os.name != "posix", reason="POSIX no-follow namespace")
@pytest.mark.parametrize("alias_kind", ["parent", "leaf"])
@pytest.mark.parametrize("caller", ["default", "getter", "constructor"])
def test_raw_registry_alias_is_refused_before_target_initialization(
    tmp_path, monkeypatch, alias_kind, caller
):
    target_parent = tmp_path / "trusted"
    target_parent.mkdir(mode=0o700)
    target = target_parent / "registry.sqlite"
    unsafe = tmp_path / "replaceable"
    unsafe.mkdir(mode=0o700)
    unsafe.chmod(0o777)
    if alias_kind == "parent":
        alias_parent = unsafe / "directory-alias"
        alias_parent.symlink_to(target_parent, target_is_directory=True)
        raw_path = alias_parent / target.name
        alias_object = alias_parent
    else:
        private_child = unsafe / "private-child"
        private_child.mkdir(mode=0o700)
        raw_path = private_child / target.name
        raw_path.symlink_to(target)
        alias_object = raw_path
    link_before = alias_object.lstat()

    if caller == "default":
        monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(raw_path))
        share_registry.reset_share_registry_for_tests()
        operation = share_registry.get_share_registry
    elif caller == "getter":

        def operation():
            return share_registry.get_share_registry(raw_path)
    else:

        def operation():
            return share_registry.SqliteShareRegistry(raw_path)

    with pytest.raises(PermissionError):
        result = operation()
        if isinstance(result, share_registry.SqliteShareRegistry):
            result.close()

    assert not target.exists(), "refusing a raw alias must happen before SQLite creates its target"
    assert alias_object.is_symlink()
    assert alias_object.lstat().st_ino == link_before.st_ino
    assert raw_path.resolve() == target
    assert stat.S_IMODE(unsafe.stat().st_mode) == 0o777

    safe_control = tmp_path / "safe-control" / "registry.sqlite"
    with closing(share_registry.SqliteShareRegistry(safe_control)) as owner:
        assert len(owner.recording_key_secret()) == 32
    assert safe_control.is_file()


@pytest.mark.skipif(os.name != "posix", reason="POSIX filenames may end in whitespace")
def test_default_registry_override_preserves_literal_path_whitespace(tmp_path, monkeypatch):
    literal = tmp_path / " registry.sqlite "
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(literal))
    share_registry.reset_share_registry_for_tests()

    registry = share_registry.get_share_registry()
    try:
        assert registry.db_path == literal
        assert len(registry.recording_key_secret()) == 32
        assert literal.is_file()
        assert not (tmp_path / " registry.sqlite").exists()
    finally:
        registry.close()
        share_registry.reset_share_registry_for_tests()


@pytest.mark.skipif(os.name != "posix", reason="POSIX no-follow ancestry")
@pytest.mark.parametrize("caller", ["default", "getter", "constructor"])
def test_raw_dotdot_path_is_refused_before_unsafe_ancestry_is_erased(tmp_path, monkeypatch, caller):
    replaceable = tmp_path / "replaceable"
    replaceable.mkdir(mode=0o700)
    replaceable.chmod(0o777)
    target_parent = tmp_path / "trusted"
    target_parent.mkdir(mode=0o700)
    raw_path = replaceable / ".." / target_parent.name / "registry.sqlite"
    target = target_parent / raw_path.name
    assert ".." in raw_path.parts

    if caller == "default":
        monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(raw_path))
        share_registry.reset_share_registry_for_tests()
        operation = share_registry.get_share_registry
    elif caller == "getter":

        def operation():
            return share_registry.get_share_registry(raw_path)
    else:

        def operation():
            return share_registry.SqliteShareRegistry(raw_path)

    with pytest.raises(PermissionError):
        result = operation()
        if isinstance(result, share_registry.SqliteShareRegistry):
            result.close()

    assert not target.exists(), "unsafe canceled ancestry must not initialize a registry"
    assert stat.S_IMODE(replaceable.stat().st_mode) == 0o777
    with closing(share_registry.SqliteShareRegistry(target)) as owner:
        assert len(owner.recording_key_secret()) == 32
    assert target.is_file()


@pytest.mark.skipif(os.name != "posix", reason="POSIX singleton path alias")
def test_default_singleton_reread_rejects_alias_swap_without_switching_authority(
    tmp_path, monkeypatch
):
    from datetime import UTC, datetime

    def seed(path: Path, token: str) -> tuple[bytes, tuple[int, int, bytes, int]]:
        with closing(share_registry.SqliteShareRegistry(path)) as owner:
            secret = owner.recording_key_secret()
            owner.claim_active(
                {
                    "token": token,
                    "id": token,
                    "project_workspace": str(path.parent),
                    "review_version_id": "version",
                    "created_at": datetime.now(UTC).isoformat(),
                }
            )
        info = path.stat()
        return secret, (info.st_ino, info.st_size, path.read_bytes(), stat.S_IMODE(info.st_mode))

    first_path = tmp_path / "first" / "registry.sqlite"
    second_path = tmp_path / "second" / "registry.sqlite"
    first_secret, first_before = seed(first_path, "first-token")
    second_secret, second_before = seed(second_path, "second-token")
    unsafe = tmp_path / "replaceable"
    unsafe.mkdir(mode=0o700)
    unsafe.chmod(0o777)
    private_child = unsafe / "private-child"
    private_child.mkdir(mode=0o700)
    alias = private_child / "registry.sqlite"
    alias.symlink_to(first_path)

    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(first_path))
    share_registry.reset_share_registry_for_tests()
    singleton = share_registry.get_share_registry()
    assert singleton.recording_key_secret() == first_secret
    original_connection = singleton._conn

    refused: list[bool] = []
    for target_path in (first_path, second_path):
        if alias.exists() or alias.is_symlink():
            alias.unlink()
        alias.symlink_to(target_path)
        alias_inode = alias.lstat().st_ino
        monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(alias))
        try:
            returned = share_registry.get_share_registry()
        except PermissionError:
            refused.append(True)
        else:
            refused.append(False)
            returned.close() if returned is not singleton else None
        assert alias.is_symlink()
        assert alias.lstat().st_ino == alias_inode
        assert alias.resolve() == target_path
        assert singleton._conn is original_connection
        assert original_connection.execute("SELECT 1").fetchone()[0] == 1
        assert singleton.recording_key_secret() == first_secret
        assert singleton.get_active("first-token")["token"] == "first-token"

    assert refused == [True, True], "each reread must re-admit the original alias namespace"
    assert stat.S_IMODE(unsafe.stat().st_mode) == 0o777
    assert share_registry._registry_singleton is singleton
    assert singleton.recording_key_secret() == first_secret
    for path, secret, before, token in (
        (first_path, first_secret, first_before, "first-token"),
        (second_path, second_secret, second_before, "second-token"),
    ):
        info = path.stat()
        assert (info.st_ino, info.st_size, path.read_bytes(), stat.S_IMODE(info.st_mode)) == before
        with closing(sqlite3.connect(path)) as observer:
            assert observer.execute(
                "SELECT token FROM active_shares ORDER BY token"
            ).fetchall() == [(token,)]
            assert observer.execute("SELECT secret FROM recording_key_secret").fetchone() == (
                secret,
            )


@pytest.mark.skipif(os.name != "posix", reason="POSIX directory privacy admission")
def test_default_registry_rejected_replacement_keeps_original_connection_usable(
    tmp_path, monkeypatch
):
    original_path = tmp_path / "original" / "registry.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(original_path))
    share_registry.reset_share_registry_for_tests()
    singleton = share_registry.get_share_registry()
    original_connection = singleton._conn
    secret = singleton.recording_key_secret()
    singleton.claim_active(
        {
            "token": "kept-owner-token",
            "id": "kept-owner-token",
            "project_workspace": str(tmp_path),
            "review_version_id": "version",
        }
    )
    before = (
        original_path.stat().st_ino,
        original_path.read_bytes(),
        stat.S_IMODE(original_path.stat().st_mode),
    )
    unsafe = tmp_path / "replaceable"
    unsafe.mkdir(mode=0o700)
    unsafe.chmod(0o777)
    private_child = unsafe / "private-child"
    private_child.mkdir(mode=0o700)
    rejected_path = private_child / "registry.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(rejected_path))

    try:
        with pytest.raises(PermissionError):
            share_registry.get_share_registry()

        assert share_registry._registry_singleton is singleton
        assert singleton._conn is original_connection
        assert original_connection.execute("SELECT 1").fetchone()[0] == 1
        assert not rejected_path.exists(), "refusal must precede target initialization"
        assert stat.S_IMODE(unsafe.stat().st_mode) == 0o777
        assert singleton.recording_key_secret() == secret
        assert singleton.get_active("kept-owner-token")["token"] == "kept-owner-token"
        assert (
            original_path.stat().st_ino,
            original_path.read_bytes(),
            stat.S_IMODE(original_path.stat().st_mode),
        ) == before
    finally:
        share_registry.reset_share_registry_for_tests()


@pytest.mark.skipif(os.name != "posix", reason="POSIX default path lifecycle")
def test_default_replacement_publishes_only_its_owned_default_and_keeps_explicit_ephemeral(
    tmp_path, monkeypatch
):
    original_path = tmp_path / "original" / "registry.sqlite"
    explicit_path = tmp_path / "explicit" / "registry.sqlite"
    replacement_path = tmp_path / "replacement" / "registry.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(original_path))
    share_registry.reset_share_registry_for_tests()
    try:
        original = share_registry.get_share_registry()
        original_secret = original.recording_key_secret()

        explicit = share_registry.get_share_registry(explicit_path)
        try:
            assert explicit is not original
            assert explicit.db_path == explicit_path
            assert share_registry._registry_singleton is original
            assert original.recording_key_secret() == original_secret
        finally:
            explicit.close()

        monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(replacement_path))
        replacement = share_registry.get_share_registry()
        assert replacement is share_registry._registry_singleton
        assert replacement is not original
        assert replacement.db_path == replacement_path
        assert replacement.recording_key_secret() != original_secret
        assert replacement_path.is_file()
    finally:
        share_registry.reset_share_registry_for_tests()


@pytest.mark.skipif(os.name != "posix", reason="POSIX default path lifecycle")
@pytest.mark.parametrize("failure_type", [OSError, KeyboardInterrupt])
def test_default_replacement_close_failure_consumes_candidate_and_preserves_error(
    tmp_path, monkeypatch, failure_type
):
    original_path = tmp_path / "original" / "registry.sqlite"
    replacement_path = tmp_path / "replacement" / "registry.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(original_path))
    share_registry.reset_share_registry_for_tests()
    original = share_registry.get_share_registry()
    original_failure = failure_type("old registry close failed")

    def fail_old_close():
        raise original_failure

    monkeypatch.setattr(original, "close", fail_old_close)
    constructor = share_registry.SqliteShareRegistry
    candidates = []

    def create_candidate(path):
        candidate = constructor(path)
        candidates.append(candidate)
        close = candidate.close

        def close_candidate():
            close()
            raise OSError("candidate release failed")

        monkeypatch.setattr(candidate, "close", close_candidate)
        return candidate

    monkeypatch.setattr(share_registry, "SqliteShareRegistry", create_candidate)
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(replacement_path))
    try:
        with pytest.raises(failure_type) as caught:
            share_registry.get_share_registry()

        assert caught.value is original_failure
        assert share_registry._registry_singleton is original
        assert len(candidates) == 1
        candidate = candidates[0]
        assert replacement_path.is_file(), "a valid admitted target is not removed by name"
        with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
            candidate._conn.execute("SELECT 1")
        assert any("cleanup" in note.lower() for note in caught.value.__notes__)
    finally:
        monkeypatch.undo()
        share_registry.reset_share_registry_for_tests()
