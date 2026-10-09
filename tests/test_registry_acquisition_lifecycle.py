from __future__ import annotations

import os
import sqlite3
import stat
from contextlib import closing, contextmanager, suppress

import pytest

from podcast_mcp.edits import share_registry
from podcast_mcp.util import registry_backup as publisher
from podcast_mcp.util import registry_backup_posix as posix


@pytest.fixture
def owned_backup(tmp_path):
    source = share_registry.SqliteShareRegistry(tmp_path / "host" / "registry.sqlite")
    secret = source.recording_key_secret()
    output = tmp_path / "output"
    output.mkdir(mode=0o700)
    previous = output / "previous.sqlite"
    previous.write_bytes(b"prior backup")
    try:
        yield source, output / "new.sqlite", secret
    finally:
        source.close()


def assert_authority(source, destination, secret):
    assert source.recording_key_secret() == secret
    assert destination.with_name("previous.sqlite").read_bytes() == b"prior backup"


def assert_closed(fd, expected, fstat):
    try:
        current = fstat(fd)
    except OSError:
        return
    assert (current.st_dev, current.st_ino) != expected, "acquired native resource leaked"


@pytest.mark.parametrize("body_site", ["backup", "normalize"])
@pytest.mark.parametrize("body_kind", [OSError, KeyboardInterrupt])
@pytest.mark.parametrize("close_kind", [OSError, KeyboardInterrupt])
def test_public_snapshot_sqlite_close_preserves_initiating_object(
    owned_backup, monkeypatch, body_site, body_kind, close_kind
):
    source, destination, secret = owned_backup
    body = body_kind("snapshot body interrupted")
    close_error = close_kind("snapshot close interrupted")
    connect = sqlite3.connect
    snapshots = []

    class Snapshot(sqlite3.Connection):
        def execute(self, sql, *args, **kwargs):
            if body_site == "normalize" and sql == "PRAGMA journal_mode=DELETE":
                raise body
            return super().execute(sql, *args, **kwargs)

        def close(self):
            super().close()
            snapshots.append(self)
            raise close_error

    def open_snapshot(*args, **kwargs):
        return connect(*args, **kwargs, factory=Snapshot)

    class Source:
        def backup(self, connection):
            raise body

    with monkeypatch.context() as patch:
        if body_site == "backup":
            patch.setattr(source, "_conn", Source())
        patch.setattr(share_registry.sqlite3, "connect", open_snapshot)
        with pytest.raises(BaseException) as caught:
            source.backup_to_new(destination)
    assert len(snapshots) == 1
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        snapshots[0].execute("SELECT 1")
    assert not destination.exists()
    assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
    assert list(destination.parent.iterdir()) == [destination.with_name("previous.sqlite")]
    assert_authority(source, destination, secret)
    assert caught.value is body


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX descriptor validity")
@pytest.mark.parametrize(
    "site", ["snapshot-first", "snapshot-publisher", "stage-first", "stage-publisher"]
)
@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_created_file_identity_failure_closes_native_resource(
    owned_backup, monkeypatch, site, kind
):
    import fcntl

    source, destination, secret = owned_backup
    failure = kind("first acquired identity unavailable")
    fstat, close = os.fstat, os.close
    acquired = []
    metadata_calls = 0
    injected = False
    first = site.endswith("first")

    def inspect(fd):
        nonlocal metadata_calls, injected
        info = fstat(fd)
        if stat.S_ISREG(info.st_mode) and (
            not first or fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDWR
        ):
            paths = list(source.db_path.parent.glob(".registry-snapshot-*/registry.sqlite"))
            paths += list(destination.parent.glob("*.partial"))
            for path in paths:
                value = path.stat()
                expected = (value.st_dev, value.st_ino)
                target = (
                    path.name.endswith(".partial")
                    if site.startswith("stage")
                    else path.name == "registry.sqlite"
                )
                if target and expected == (info.st_dev, info.st_ino):
                    metadata_calls += 1
                    if not acquired:
                        acquired.append((fd, expected, path))
                    if metadata_calls == (1 if first else 2):
                        injected = True
                        raise failure
        return info

    try:
        with monkeypatch.context() as patch:
            patch.setattr(os, "fstat", inspect)
            with pytest.raises(BaseException) as caught:
                source.backup_to_new(destination)
        assert injected and len(acquired) == 1
        fd, expected, path = acquired[0]
        assert_closed(fd, expected, fstat)
        assert caught.value is failure
        assert not destination.exists()
        if first:
            assert metadata_calls == 1, (
                "unknown identity must never be reacquired to authorize deletion"
            )
            assert path.exists(), "unknown created entry must remain safe residue"
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
            assert any(
                "cleanup" in note.lower() or "identity" in note.lower()
                for note in getattr(caught.value, "__notes__", [])
            )
        else:
            assert not path.exists(), (
                "known creation identity permits cleanup after later metadata failure"
            )
        assert_authority(source, destination, secret)
    finally:
        for fd, expected, _ in acquired:
            with suppress(OSError):
                info = fstat(fd)
                if (info.st_dev, info.st_ino) == expected:
                    close(fd)


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX close ownership")
@pytest.mark.parametrize("after_close", [False, True])
@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_initial_snapshot_close_attempt_is_not_retried_and_names_drain(
    owned_backup, monkeypatch, after_close, kind
):
    source, destination, secret = owned_backup
    failure = kind("initial snapshot descriptor close failed")
    create, close, fstat = posix.BackupDirectory.created_file, os.close, os.fstat
    target = []
    attempts = []

    @contextmanager
    def capture(directory, name):
        with create(directory, name) as created:
            if name == "registry.sqlite":
                info = fstat(created.fd)
                target.append((created.fd, (info.st_dev, info.st_ino)))
            yield created

    def interrupt(fd):
        if target and fd == target[0][0]:
            attempts.append(fd)
            if after_close:
                close(fd)
            raise failure
        return close(fd)

    try:
        with monkeypatch.context() as patch:
            patch.setattr(posix.BackupDirectory, "created_file", capture)
            patch.setattr(os, "close", interrupt)
            with pytest.raises(BaseException) as caught:
                source.backup_to_new(destination)
        assert len(attempts) == 1, "never retry a descriptor after an ambiguous close"
        assert caught.value is failure
        if after_close:
            assert_closed(*target[0], fstat)
        else:
            assert (fstat(target[0][0]).st_dev, fstat(target[0][0]).st_ino) == target[0][1]
        assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
        assert not destination.exists()
        assert_authority(source, destination, secret)
    finally:
        if target:
            with suppress(OSError):
                info = fstat(target[0][0])
                if (info.st_dev, info.st_ino) == target[0][1]:
                    close(target[0][0])


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX workspace acquisition")
@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_workspace_unknown_identity_retains_private_entry_with_note(
    owned_backup, monkeypatch, kind
):
    source, destination, secret = owned_backup
    failure = kind("workspace identity unavailable")
    native_stat = os.stat
    lookups = []
    directory = publisher._directory
    native_fstat = os.fstat
    handles = []

    def acquire(path):
        value = directory(path)
        handles.extend(
            (fd, (native_fstat(fd).st_dev, native_fstat(fd).st_ino)) for fd, _ in value._chain
        )
        return value

    def inspect(path, *args, **kwargs):
        if str(path).startswith(".registry-snapshot-"):
            lookups.append(str(path))
            raise failure
        return native_stat(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(os, "stat", inspect)
        patch.setattr(publisher, "_directory", acquire)
        with pytest.raises(BaseException) as caught:
            source.backup_to_new(destination)
    for fd, expected in handles:
        assert_closed(fd, expected, native_fstat)
    assert caught.value is failure
    assert len(lookups) == 1
    residue = list(source.db_path.parent.glob(".registry-snapshot-*"))
    assert len(residue) == 1
    assert stat.S_IMODE(residue[0].stat().st_mode) == 0o700
    assert list(residue[0].iterdir()) == []
    assert any(
        "identity" in note.lower() or "cleanup" in note.lower()
        for note in getattr(caught.value, "__notes__", [])
    )
    assert not destination.exists()
    assert_authority(source, destination, secret)


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX workspace open")
@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_known_workspace_open_failure_removes_only_creation(owned_backup, monkeypatch, kind):
    source, destination, secret = owned_backup
    failure = kind("workspace open interrupted")
    initialize = posix.BackupDirectory.__init__

    def open_directory(directory, path):
        if path.name.startswith(".registry-snapshot-"):
            raise failure
        initialize(directory, path)

    monkeypatch.setattr(posix.BackupDirectory, "__init__", open_directory)
    with pytest.raises(BaseException) as caught:
        source.backup_to_new(destination)
    assert caught.value is failure
    assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
    assert not destination.exists()
    assert_authority(source, destination, secret)


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX validation unwind")
@pytest.mark.parametrize("name_kind", ["snapshot", "stage"])
@pytest.mark.parametrize("secondary_kind", [OSError, KeyboardInterrupt])
def test_public_known_creation_validation_failure_preserves_error_without_metadata_retry(
    owned_backup, monkeypatch, name_kind, secondary_kind
):
    source, destination, secret = owned_backup
    failure = OSError("created file validation failed")
    secondary = secondary_kind("unwind metadata interrupted")
    verify, fstat, close = posix.BackupDirectory.verify_file, os.fstat, os.close
    acquired = []
    body_failed = False

    def validate(directory, name, expected):
        nonlocal body_failed
        target = name == "registry.sqlite" if name_kind == "snapshot" else name.endswith(".partial")
        if target and not body_failed:
            body_failed = True
            raise failure
        return verify(directory, name, expected)

    def inspect(fd):
        info = fstat(fd)
        paths = list(source.db_path.parent.glob(".registry-snapshot-*/registry.sqlite"))
        paths += list(destination.parent.glob("*.partial"))
        for path in paths:
            value = path.stat()
            if (value.st_dev, value.st_ino) == (info.st_dev, info.st_ino):
                target = (
                    path.name == "registry.sqlite"
                    if name_kind == "snapshot"
                    else path.name.endswith(".partial")
                )
                if target:
                    if body_failed:
                        raise secondary
                    if not acquired:
                        acquired.append((fd, (info.st_dev, info.st_ino), path))
        return info

    try:
        with monkeypatch.context() as patch:
            patch.setattr(posix.BackupDirectory, "verify_file", validate)
            patch.setattr(os, "fstat", inspect)
            with pytest.raises(BaseException) as caught:
                source.backup_to_new(destination)
        assert body_failed and acquired
        assert caught.value is failure
        fd, expected, path = acquired[0]
        assert_closed(fd, expected, fstat)
        assert not path.exists()
        assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
        assert not destination.exists()
        assert_authority(source, destination, secret)
    finally:
        for fd, expected, _ in acquired:
            with suppress(OSError):
                info = fstat(fd)
                if (info.st_dev, info.st_ino) == expected:
                    close(fd)


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX source creation")
@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt, FileExistsError])
def test_public_source_new_main_validation_failure_removes_known_creation(
    tmp_path, monkeypatch, kind
):
    path = tmp_path / "source" / "registry.sqlite"
    failure = kind("new source validation interrupted")
    check, fstat, close = posix._check_file, os.fstat, os.close
    acquired = []

    def refuse(fd, **kwargs):
        info = fstat(fd)
        if path.exists() and info.st_ino == path.stat().st_ino:
            acquired.append((fd, (info.st_dev, info.st_ino)))
            raise failure
        return check(fd, **kwargs)

    monkeypatch.setattr(posix, "_check_file", refuse)
    try:
        with pytest.raises(BaseException) as caught:
            share_registry.SqliteShareRegistry(path)
        assert caught.value is failure
        assert acquired
        assert_closed(*acquired[0], fstat)
        assert not path.exists(), "failed known empty creation is not durable source authority"
        assert path.parent.exists(), "source ancestry is durable scaffolding"
    finally:
        for fd, expected in acquired:
            with suppress(OSError):
                info = fstat(fd)
                if (info.st_dev, info.st_ino) == expected:
                    close(fd)


def test_public_source_valid_creation_survives_later_sqlite_failure(tmp_path, monkeypatch):
    path = tmp_path / "source" / "registry.sqlite"
    failure = OSError("SQLite connection unavailable")

    def fail(*args, **kwargs):
        assert path.exists()
        raise failure

    with monkeypatch.context() as patch:
        patch.setattr(share_registry.sqlite3, "connect", fail)
        with pytest.raises(OSError) as caught:
            share_registry.SqliteShareRegistry(path)
    assert caught.value is failure
    assert path.read_bytes() == b""
    with closing(share_registry.SqliteShareRegistry(path)) as recovered:
        assert len(recovered.recording_key_secret()) == 32


@pytest.mark.skipif(os.name != "posix", reason="actual no-replace POSIX publication")
@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_cancellation_after_native_publication_keeps_completed_final(
    owned_backup, monkeypatch, kind
):
    source, destination, secret = owned_backup
    publish = posix.BackupDirectory.publish
    failure = kind("publication returned interrupted")

    def interrupt(directory, *args):
        publish(directory, *args)
        raise failure

    monkeypatch.setattr(posix.BackupDirectory, "publish", interrupt)
    with pytest.raises(BaseException) as caught:
        source.backup_to_new(destination)
    assert caught.value is failure
    with closing(sqlite3.connect(destination)) as observer:
        assert observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
        assert observer.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    assert sorted(destination.parent.iterdir(), key=lambda path: path.name) == sorted(
        [destination.with_name("previous.sqlite"), destination], key=lambda path: path.name
    )
    assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
    assert_authority(source, destination, secret)


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX source identity")
@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_source_first_identity_failure_closes_and_retains_unknown_main(
    tmp_path, monkeypatch, kind
):
    import fcntl

    path = tmp_path / "source" / "registry.sqlite"
    failure = kind("source initial identity unavailable")
    fstat, close = os.fstat, os.close
    acquired = []
    attempts = []

    def inspect(fd):
        info = fstat(fd)
        if (
            path.exists()
            and info.st_ino == path.stat().st_ino
            and fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDWR
        ):
            acquired.append((fd, (info.st_dev, info.st_ino)))
            raise failure
        return info

    def release(fd):
        if acquired and fd == acquired[0][0]:
            attempts.append(fd)
        close(fd)

    with monkeypatch.context() as patch:
        patch.setattr(os, "fstat", inspect)
        patch.setattr(os, "close", release)
        with pytest.raises(BaseException) as caught:
            share_registry.SqliteShareRegistry(path)
    assert caught.value is failure
    assert len(acquired) == len(attempts) == 1
    assert_closed(*acquired[0], fstat)
    assert path.read_bytes() == b""
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert any(
        "identity" in note.lower() or "cleanup" in note.lower()
        for note in getattr(caught.value, "__notes__", [])
    )


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX replacement identity")
@pytest.mark.parametrize("site", ["snapshot", "stage", "source"])
def test_public_validation_failure_preserves_substituted_name(tmp_path, monkeypatch, site):
    failure = OSError("validation failed after replacement")
    replacement = b"replacement must survive"
    output = tmp_path / "output"
    output.mkdir(mode=0o700)
    destination = output / "new.sqlite"
    source_path = tmp_path / "host" / "registry.sqlite"
    source = None if site == "source" else share_registry.SqliteShareRegistry(source_path)
    targets = []
    verify, check, fstat = posix.BackupDirectory.verify_file, posix._check_file, os.fstat

    def substitute(path):
        original = path.with_name(path.name + ".held")
        path.rename(original)
        path.write_bytes(replacement)
        path.chmod(0o600)
        targets.append((path, original))
        raise failure

    def validate(directory, name, expected):
        target = name == "registry.sqlite" if site == "snapshot" else name.endswith(".partial")
        if target and not targets:
            substitute(directory.path / name)
        return verify(directory, name, expected)

    def source_check(fd, **kwargs):
        if source_path.exists() and fstat(fd).st_ino == source_path.stat().st_ino and not targets:
            substitute(source_path)
        return check(fd, **kwargs)

    try:
        with monkeypatch.context() as patch:
            if site == "source":
                patch.setattr(posix, "_check_file", source_check)
            else:
                patch.setattr(posix.BackupDirectory, "verify_file", validate)
            with pytest.raises(BaseException) as caught:
                if source is None:
                    share_registry.SqliteShareRegistry(source_path)
                else:
                    source.backup_to_new(destination)
        assert caught.value is failure
        assert len(targets) == 1
        assert targets[0][0].read_bytes() == replacement
        assert targets[0][1].exists()
        assert not destination.exists()
    finally:
        if source is not None:
            source.close()


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX reader metadata")
@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_reader_metadata_failure_closes_reader_and_drains_names(
    owned_backup, monkeypatch, kind
):
    source, destination, secret = owned_backup
    failure = kind("reader metadata interrupted")
    reader, fstat, close = posix.BackupDirectory.snapshot_reader, os.fstat, os.close
    active = False
    target = []
    calls = 0

    @contextmanager
    def open_reader(directory, *args):
        nonlocal active
        active = True
        with reader(directory, *args) as fd:
            yield fd

    def inspect(fd):
        nonlocal calls
        info = fstat(fd)
        paths = list(source.db_path.parent.glob(".registry-snapshot-*/registry.sqlite"))
        if active and paths and info.st_ino == paths[0].stat().st_ino:
            calls += 1
            if calls == 3:
                target.append((fd, (info.st_dev, info.st_ino)))
                raise failure
        return info

    try:
        with monkeypatch.context() as patch:
            patch.setattr(posix.BackupDirectory, "snapshot_reader", open_reader)
            patch.setattr(os, "fstat", inspect)
            with pytest.raises(BaseException) as caught:
                source.backup_to_new(destination)
        assert target and caught.value is failure
        assert_closed(*target[0], fstat)
        assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
        assert not destination.exists()
        assert_authority(source, destination, secret)
    finally:
        for fd, expected in target:
            with suppress(OSError):
                info = fstat(fd)
                if (info.st_dev, info.st_ino) == expected:
                    close(fd)


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX descriptor cleanup")
@pytest.mark.parametrize("site", ["reader", "stage"])
@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_file_close_failure_preserves_body_and_drains_later_cleanup(
    owned_backup, monkeypatch, site, kind
):
    source, destination, secret = owned_backup
    failure = OSError("stream body failed")
    close_failure = kind("file release interrupted after actual close")
    native_close, native_fstat = os.close, os.fstat
    targets = []
    fired = []

    def copy(read_fd, stage_fd):
        targets.extend(
            (fd, (native_fstat(fd).st_dev, native_fstat(fd).st_ino)) for fd in (read_fd, stage_fd)
        )
        raise failure

    def release(fd):
        native_close(fd)
        index = 0 if site == "reader" else 1
        if targets and fd == targets[index][0] and not fired:
            fired.append(fd)
            raise close_failure

    with monkeypatch.context() as patch:
        patch.setattr(publisher, "_copy_snapshot", copy)
        patch.setattr(os, "close", release)
        with pytest.raises(BaseException) as caught:
            source.backup_to_new(destination)
    assert caught.value is failure
    assert len(fired) == 1
    for fd, expected in targets:
        assert_closed(fd, expected, native_fstat)
    assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
    assert list(destination.parent.iterdir()) == [destination.with_name("previous.sqlite")]
    assert_authority(source, destination, secret)


@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_final_verification_failure_retains_completed_backup(
    owned_backup, monkeypatch, kind
):
    source, destination, secret = owned_backup
    backend = publisher.WindowsDirectory if os.name == "nt" else publisher.PosixDirectory
    verify = backend.verify_file
    failure = kind("final verification interrupted")

    def inspect(directory, name, expected):
        if name == destination.name:
            raise failure
        return verify(directory, name, expected)

    monkeypatch.setattr(backend, "verify_file", inspect)
    with pytest.raises(BaseException) as caught:
        source.backup_to_new(destination)
    if kind is OSError:
        assert caught.value.__cause__ is failure
        assert "was published" in str(caught.value)
    else:
        assert caught.value is failure
    with closing(sqlite3.connect(destination)) as observer:
        assert observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
    assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
    assert_authority(source, destination, secret)


@pytest.mark.skipif(os.name != "posix", reason="actual POSIX cleanup action draining")
@pytest.mark.parametrize("site", ["snapshot", "stage"])
@pytest.mark.parametrize("secondary_kind", [OSError, KeyboardInterrupt])
def test_public_known_name_cleanup_lookup_fault_preserves_body_and_closes_ancestors(
    owned_backup, monkeypatch, site, secondary_kind
):
    source, destination, secret = owned_backup
    failure = OSError("validation refused known acquired file")
    secondary = secondary_kind("identity comparison failed during removal")
    directory = publisher._directory
    validate = posix.BackupDirectory.verify_file
    remove = posix.BackupDirectory.remove_file
    native_stat, native_fstat, native_close = os.stat, os.fstat, os.close
    handles = []
    refused = []
    removing = False
    lookups = []

    def acquire(path):
        value = directory(path)
        handles.extend(
            (fd, (native_fstat(fd).st_dev, native_fstat(fd).st_ino)) for fd, _ in value._chain
        )
        return value

    def verify(parent, name, expected):
        target = name == "registry.sqlite" if site == "snapshot" else name.endswith(".partial")
        if target and not refused:
            refused.append(parent.path / name)
            raise failure
        return validate(parent, name, expected)

    def remove_name(parent, name, expected):
        nonlocal removing
        removing = True
        try:
            return remove(parent, name, expected)
        finally:
            removing = False

    def inspect(name, *args, **kwargs):
        if removing and refused and str(name) == refused[0].name:
            lookups.append(str(name))
            raise secondary
        return native_stat(name, *args, **kwargs)

    try:
        with monkeypatch.context() as patch:
            patch.setattr(publisher, "_directory", acquire)
            patch.setattr(posix.BackupDirectory, "verify_file", verify)
            patch.setattr(posix.BackupDirectory, "remove_file", remove_name)
            patch.setattr(os, "stat", inspect)
            with pytest.raises(BaseException) as caught:
                source.backup_to_new(destination)
        assert caught.value is failure
        assert len(lookups) == 1
        for fd, expected in handles:
            assert_closed(fd, expected, native_fstat)
        assert refused[0].exists(), "identity comparison failure cannot authorize deletion"
        if site == "stage":
            assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
        assert not destination.exists()
        assert_authority(source, destination, secret)
    finally:
        for fd, expected in handles:
            with suppress(OSError):
                info = native_fstat(fd)
                if (info.st_dev, info.st_ino) == expected:
                    native_close(fd)
