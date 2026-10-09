from __future__ import annotations

import os
from contextlib import suppress
from types import SimpleNamespace

import pytest

from podcast_mcp.edits.share_registry import SqliteShareRegistry
from podcast_mcp.util import registry_backup as publisher
from podcast_mcp.util import registry_backup_windows as windows


@pytest.mark.parametrize("site", ["snapshot", "stage", "reader"])
@pytest.mark.parametrize("boundary", ["validation", "transfer"])
@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_windows_acquisition_failure_closes_resource_and_known_names(
    tmp_path, monkeypatch, site, boundary, kind
):
    source = SqliteShareRegistry(tmp_path / "host" / "registry.sqlite")
    secret = source.recording_key_secret()
    output = tmp_path / "output"
    output.mkdir(mode=0o700)
    destination = output / "new.sqlite"
    failure = kind("Windows native acquisition interrupted")
    acquired = {}
    released = []
    transferred = set()
    faulted = []
    native_close, native_fstat = os.close, os.fstat

    def role(path, disposition):
        return (
            "stage"
            if str(path).endswith(".partial")
            else "reader"
            if disposition == 3
            else "snapshot"
        )

    def open_file(path, access, sharing, security, disposition, flags, template):
        fd = os.open(
            path, os.O_RDONLY if disposition == 3 else os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600
        )
        info = native_fstat(fd)
        transferred.discard(fd)
        acquired[fd] = (str(path), role(path, disposition), (info.st_dev, info.st_ino))
        return fd

    def verify(handle, **kwargs):
        info = native_fstat(handle)
        record = acquired[handle]
        if record[1] == site and boundary == "validation" and not faulted:
            faulted.append(handle)
            raise failure
        return SimpleNamespace(volume=info.st_dev, index_high=0, index_low=info.st_ino)

    def transfer(handle, flags):
        if acquired[handle][1] == site and boundary == "transfer" and not faulted:
            faulted.append(handle)
            raise failure
        transferred.add(handle)
        return handle

    def close_handle(handle):
        assert handle not in transferred, "native ownership ended at successful CRT conversion"
        released.append(handle)
        native_close(handle)

    api = SimpleNamespace(
        create_directory=lambda path: path.mkdir(mode=0o700),
        create_file=lambda path: open_file(path, 0, 0, None, 1, 0, None),
        verify_handle=verify,
        close=close_handle,
        kernel=SimpleNamespace(CreateFileW=open_file),
        crt=SimpleNamespace(open_osfhandle=transfer),
    )
    try:
        with monkeypatch.context() as patch:
            patch.setattr(windows, "_WindowsAPI", lambda: api)
            patch.setattr(windows, "_open_chain", lambda *args, **kwargs: [])
            patch.setattr(windows, "_verify_chain", lambda *args, **kwargs: None)
            patch.setattr(publisher, "_directory", windows.BackupDirectory)
            with pytest.raises(BaseException) as caught:
                source.backup_to_new(destination)
        assert faulted
        assert caught.value is failure
        for fd in faulted:
            with pytest.raises(OSError):
                native_fstat(fd)
        assert not destination.exists()
        assert list(output.iterdir()) == []
        assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
        assert source.recording_key_secret() == secret
    finally:
        for fd, (_, _, expected) in acquired.items():
            with suppress(OSError):
                info = native_fstat(fd)
                if (info.st_dev, info.st_ino) == expected:
                    native_close(fd)
        source.close()


@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_windows_reader_metadata_failure_after_crt_transfer_closes_only_descriptor(
    tmp_path, monkeypatch, kind
):
    source = SqliteShareRegistry(tmp_path / "host" / "registry.sqlite")
    source.recording_key_secret()
    output = tmp_path / "output"
    output.mkdir(mode=0o700)
    destination = output / "new.sqlite"
    failure = kind("reader identity unavailable after transfer")
    read_fd = []
    native_close, native_fstat = os.close, os.fstat
    acquired = []

    def open_file(path, access, sharing, security, disposition, flags, template):
        fd = os.open(
            path, os.O_RDONLY if disposition == 3 else os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600
        )
        info = native_fstat(fd)
        acquired.append((fd, (info.st_dev, info.st_ino)))
        if disposition == 3 and access == 0x80020000:
            read_fd.append(fd)
        return fd

    def inspect(fd):
        if read_fd and fd == read_fd[0]:
            raise failure
        return native_fstat(fd)

    api = SimpleNamespace(
        create_directory=lambda path: path.mkdir(mode=0o700),
        create_file=lambda path: open_file(path, 0, 0, None, 1, 0, None),
        verify_handle=lambda handle, **kwargs: SimpleNamespace(volume=1, index_high=0, index_low=1),
        close=native_close,
        kernel=SimpleNamespace(CreateFileW=open_file),
        crt=SimpleNamespace(open_osfhandle=lambda handle, flags: handle),
    )
    try:
        with monkeypatch.context() as patch:
            patch.setattr(windows, "_WindowsAPI", lambda: api)
            patch.setattr(windows, "_open_chain", lambda *args, **kwargs: [])
            patch.setattr(windows, "_verify_chain", lambda *args, **kwargs: None)
            patch.setattr(publisher, "_directory", windows.BackupDirectory)
            patch.setattr(os, "fstat", inspect)
            with pytest.raises(BaseException) as caught:
                source.backup_to_new(destination)
        assert caught.value is failure
        assert len(read_fd) == 1
        with pytest.raises(OSError):
            native_fstat(read_fd[0])
        assert list(output.iterdir()) == []
        assert not list(source.db_path.parent.glob(".registry-snapshot-*"))
    finally:
        for fd, expected in acquired:
            with suppress(OSError):
                info = native_fstat(fd)
                if (info.st_dev, info.st_ino) == expected:
                    native_close(fd)
        source.close()


@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt])
def test_public_windows_security_descriptor_free_failure_owns_created_handle(
    tmp_path, monkeypatch, kind
):
    import ctypes

    source = SqliteShareRegistry(tmp_path / "host" / "registry.sqlite")
    source.recording_key_secret()
    output = tmp_path / "output"
    output.mkdir(mode=0o700)
    destination = output / "new.sqlite"
    failure = kind("temporary security descriptor release interrupted")
    created = []
    native_close, native_fstat = os.close, os.fstat
    create_file = windows._WindowsAPI.create_file

    def acquire(path, access, sharing, attributes, disposition, flags, template):
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        info = native_fstat(fd)
        created.append((fd, (info.st_dev, info.st_ino)))
        return fd

    def local_free(descriptor):
        raise failure

    api = SimpleNamespace(
        create_directory=lambda path: path.mkdir(mode=0o700),
        private_descriptor=lambda: ctypes.c_void_p(123),
        check=windows._WindowsAPI.check,
        kernel=SimpleNamespace(CreateFileW=acquire, LocalFree=local_free),
        verify_handle=lambda handle, **kwargs: SimpleNamespace(volume=1, index_high=0, index_low=1),
        close=native_close,
        crt=SimpleNamespace(open_osfhandle=lambda handle, flags: handle),
    )
    api.create_file = lambda path: create_file(api, path)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(windows, "_WindowsAPI", lambda: api)
            patch.setattr(windows, "_open_chain", lambda *args, **kwargs: [])
            patch.setattr(windows, "_verify_chain", lambda *args, **kwargs: None)
            patch.setattr(publisher, "_directory", windows.BackupDirectory)
            with pytest.raises(BaseException) as caught:
                source.backup_to_new(destination)
        assert caught.value is failure
        assert len(created) == 1
        with pytest.raises(OSError):
            native_fstat(created[0][0])
        assert not destination.exists()
        residue = list(source.db_path.parent.glob(".registry-snapshot-*/registry.sqlite"))
        assert len(residue) == 1
        assert residue[0].read_bytes() == b""
        assert any(
            "cleanup" in note.lower() or "identity" in note.lower()
            for note in getattr(caught.value, "__notes__", [])
        )
    finally:
        for fd, expected in created:
            with suppress(OSError):
                info = native_fstat(fd)
                if (info.st_dev, info.st_ino) == expected:
                    native_close(fd)
        source.close()


@pytest.mark.parametrize("kind", [OSError, KeyboardInterrupt, FileExistsError])
def test_public_windows_source_validation_failure_releases_known_new_main(
    tmp_path, monkeypatch, kind
):
    from podcast_mcp.edits import share_registry

    path = tmp_path / "registry.sqlite"
    failure = kind("source native validation interrupted")
    native_fstat, native_close = os.fstat, os.close
    acquired = []

    def create(child):
        fd = os.open(child, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        acquired.append(fd)
        return fd

    def verify(handle, **kwargs):
        info = native_fstat(handle)
        assert info.st_ino == path.stat().st_ino
        raise failure

    api = SimpleNamespace(
        open_file=lambda child: os.open(child, os.O_RDONLY),
        create_file=create,
        verify_handle=verify,
        close=native_close,
    )
    with monkeypatch.context() as patch:
        patch.setattr(windows, "_WindowsAPI", lambda: api)
        patch.setattr(windows, "_open_chain", lambda *args, **kwargs: [])
        patch.setattr(windows, "_verify_chain", lambda *args, **kwargs: None)
        patch.setattr(share_registry, "registry_privacy", windows.registry_scope)
        with pytest.raises(BaseException) as caught:
            SqliteShareRegistry(path)
    assert caught.value is failure
    assert len(acquired) == 1
    with pytest.raises(OSError):
        native_fstat(acquired[0])
    assert not path.exists(), "known failed source creation must not become retained authority"
