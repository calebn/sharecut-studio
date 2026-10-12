from __future__ import annotations

import ctypes
import errno
import os
import stat
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from functools import partial
from pathlib import Path

from podcast_mcp.util.pinned_media import descriptor_walk_supported, open_nofollow_dir
from podcast_mcp.util.registry_cleanup import cleanup
from podcast_mcp.util.registry_privacy_error import RegistryPrivacyError, RegistryPrivacyReason

Identity = tuple[int, int]


def identity(value: os.stat_result) -> Identity:
    return value.st_dev, value.st_ino


def _check_acl(target: int | str, path: Path) -> None:
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        get_acl = libc.acl_get_fd_np if isinstance(target, int) else libc.acl_get_link_np
        get_acl.argtypes = [
            ctypes.c_int if isinstance(target, int) else ctypes.c_char_p,
            ctypes.c_int,
        ]
        get_acl.restype = ctypes.c_void_p
        libc.acl_get_entry.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        libc.acl_get_tag_type.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        libc.acl_free.argtypes = [ctypes.c_void_p]
        acl = get_acl(target if isinstance(target, int) else os.fsencode(target), 0x100)
        if not acl:
            if ctypes.get_errno() == errno.ENOENT:
                return
            raise OSError(ctypes.get_errno(), "cannot verify backup directory ACL")
        try:
            entry, tag = ctypes.c_void_p(), ctypes.c_int()
            selector = 0
            while True:
                result = libc.acl_get_entry(acl, selector, ctypes.byref(entry))
                if result == -1:
                    if ctypes.get_errno() == errno.EINVAL:
                        break
                    raise OSError(ctypes.get_errno(), "cannot inspect backup ACL")
                if libc.acl_get_tag_type(entry, ctypes.byref(tag)) != 0:
                    raise OSError(ctypes.get_errno(), "cannot inspect backup ACL grant")
                if tag.value == 1:
                    raise RegistryPrivacyError(path, RegistryPrivacyReason.ACL)
                selector = -1
        finally:
            cleanup([partial(libc.acl_free, acl)])
    elif sys.platform.startswith("linux"):
        names = (
            os.listxattr(target)
            if isinstance(target, int)
            else os.listxattr(target, follow_symlinks=False)
        )
        if any(name.startswith("system.posix_acl_") for name in names):
            raise RegistryPrivacyError(path, RegistryPrivacyReason.ACL)
    else:
        raise OSError(errno.ENOTSUP, "backup ACL verification is unavailable")


def _check_directory(fd: int, path: Path, *, private: bool, tighten: bool = False) -> None:
    info = os.fstat(fd)
    if info.st_uid not in (0, os.geteuid()) or not stat.S_ISDIR(info.st_mode):
        owner = (
            RegistryPrivacyReason.DIRECTORY_OWNER if private else RegistryPrivacyReason.PARENT_OWNER
        )
        raise RegistryPrivacyError(path, owner)
    _check_acl(fd, path)
    if private and tighten and info.st_uid == os.geteuid() and info.st_mode & 0o077:
        os.fchmod(fd, 0o700)
        info = os.fstat(fd)
    if private:
        if info.st_uid != os.geteuid():
            raise RegistryPrivacyError(path, RegistryPrivacyReason.DIRECTORY_OWNER)
        if info.st_mode & 0o077:
            raise RegistryPrivacyError(
                path, RegistryPrivacyReason.DIRECTORY_MODE, mode=info.st_mode
            )
    elif info.st_mode & 0o022 and not (info.st_mode & stat.S_ISVTX):
        reason = (
            RegistryPrivacyReason.PARENT_WRITABLE
            if info.st_uid == os.geteuid()
            else RegistryPrivacyReason.PARENT_WRITABLE_NOT_MINE
        )
        raise RegistryPrivacyError(path, reason)


def _open_component(name: str, parent: int, path: Path) -> int:
    try:
        return open_nofollow_dir(name, dir_fd=parent)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR) and stat.S_ISLNK(
            os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode
        ):
            raise RegistryPrivacyError(path, RegistryPrivacyReason.SYMLINK) from exc
        raise


def _open_chain(
    path: Path, *, create: bool = False, tighten: bool = False
) -> list[tuple[int, str | None]]:
    if not descriptor_walk_supported():
        raise OSError(errno.ENOTSUP, "registry storage requires directory descriptors")
    chain: list[tuple[int, str | None]] = []
    try:
        chain.append((open_nofollow_dir(path.anchor), None))
        for depth, part in enumerate(path.parts[1:], start=2):
            parent = chain[-1][0]
            _check_directory(parent, Path(*path.parts[: depth - 1]), private=False)
            if create:
                with suppress(FileExistsError):
                    os.mkdir(part, 0o700, dir_fd=parent)
            chain.append((_open_component(part, parent, Path(*path.parts[:depth])), part))
        _check_directory(chain[-1][0], path, private=True, tighten=tighten)
        _verify_chain(chain, path)
        return chain
    except BaseException:
        cleanup([partial(os.close, fd) for fd, _ in reversed(chain)])
        raise


def _verify_chain(chain: list[tuple[int, str | None]], path: Path) -> None:
    for index, (fd, name) in enumerate(chain):
        _check_directory(fd, Path(*path.parts[: index + 1]), private=index == len(chain) - 1)
        if name is not None:
            current = os.stat(name, dir_fd=chain[index - 1][0], follow_symlinks=False)
            if identity(current) != identity(os.fstat(fd)):
                raise PermissionError("registry directory changed during access")


def _check_file_state(info: os.stat_result, path: Path, acl_target: int | str) -> None:
    if stat.S_ISLNK(info.st_mode):
        raise RegistryPrivacyError(path, RegistryPrivacyReason.SYMLINK)
    if not stat.S_ISREG(info.st_mode):
        raise RegistryPrivacyError(path, RegistryPrivacyReason.FILE_NOT_REGULAR)
    if info.st_uid != os.geteuid():
        raise RegistryPrivacyError(path, RegistryPrivacyReason.FILE_OWNER)
    _check_acl(acl_target, path)
    if info.st_mode & 0o077:
        raise RegistryPrivacyError(path, RegistryPrivacyReason.FILE_MODE, mode=info.st_mode)


def _check_file(fd: int, *, path: Path) -> None:
    _check_file_state(os.fstat(fd), path, fd)


def _check_unopened_file(path: Path, parent: int, name: str) -> None:
    """Check a file SQLite may hold locked without opening it.

    Closing any descriptor on a file drops every POSIX lock this process holds on
    it, which would let a peer reset the WAL shared memory this process still maps.
    """
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    _check_file_state(before, path / name, str(path / name))
    if identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity(before):
        raise PermissionError("registry file changed during access")


def _remove_file(parent: int, name: str, expected: Identity) -> None:
    try:
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if identity(current) != expected:
        raise PermissionError("refusing to remove a substituted backup file")
    os.unlink(name, dir_fd=parent)


class _CreatedFile:
    def __init__(
        self, path: Path, parent: int, name: str, remove: Callable[[str, Identity], None]
    ) -> None:
        self.parent, self.name, self._remove = parent, name, remove
        self.path = path / name
        self._fd: int | None = None
        self._identity: Identity | None = None
        self._created = False

    @property
    def fd(self) -> int:
        if self._fd is None:
            raise RuntimeError("registry file descriptor is closed")
        return self._fd

    @property
    def identity(self) -> Identity:
        if self._identity is None:
            raise RuntimeError("registry file identity is unknown")
        return self._identity

    def acquire(self, *, allow_existing: bool = False) -> bool:
        try:
            self._fd = os.open(
                self.name,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=self.parent,
            )
        except FileExistsError:
            if allow_existing:
                return False
            raise
        self._created = True
        self._identity = identity(os.fstat(self.fd))
        return True

    def close_descriptor(self) -> None:
        fd, self._fd = self._fd, None
        if fd is not None:
            os.close(fd)

    def retain_name(self) -> None:
        self._created = False

    def remove_name(self) -> None:
        if self._created:
            if self._identity is None:
                raise OSError("registry cleanup retained a private entry with unknown identity")
            self._remove(self.name, self._identity)


@contextmanager
def _new_file(
    path: Path, parent: int, name: str, remove: Callable[[str, Identity], None]
) -> Iterator[_CreatedFile]:
    created = _CreatedFile(path, parent, name, remove)
    try:
        yield created
    finally:
        cleanup([created.close_descriptor, created.remove_name])


@contextmanager
def registry_scope(
    path: Path, names: tuple[str, ...], *, create: bool
) -> Iterator[Callable[[], None]]:
    chain = _open_chain(path, create=create, tighten=create)
    parent = chain[-1][0]

    allow_missing_main = create

    def verify() -> None:
        _verify_chain(chain, path)
        for name in names:
            try:
                _check_unopened_file(path, parent, name)
            except FileNotFoundError:
                if name != names[0] or allow_missing_main:
                    continue
                raise

    try:
        verify()
        if create:
            with _new_file(path, parent, names[0], partial(_remove_file, parent)) as created:
                if created.acquire(allow_existing=True):
                    _check_file(created.fd, path=created.path)
                    allow_missing_main = False
                    verify()
                    created.close_descriptor()
                    created.retain_name()
        allow_missing_main = False
        verify()
        yield verify
        verify()
    finally:
        cleanup([partial(os.close, fd) for fd, _ in reversed(chain)])


class BackupDirectory:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._chain = _open_chain(path)

    @property
    def fd(self) -> int:
        return self._chain[-1][0]

    def verify(self) -> None:
        _verify_chain(self._chain, self.path)

    def exists(self, name: str) -> bool:
        try:
            os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False

    @contextmanager
    def workspace(self, name: str) -> Iterator[BackupDirectory]:
        self.verify()
        created = False
        expected = None
        private = None

        def remove() -> None:
            if created:
                if expected is None:
                    raise OSError(
                        "registry cleanup retained a private workspace with unknown identity"
                    )
                self.remove_workspace(name, expected)

        try:
            os.mkdir(name, 0o700, dir_fd=self.fd)
            created = True
            expected = identity(os.stat(name, dir_fd=self.fd, follow_symlinks=False))
            private = BackupDirectory(self.path / name)
            yield private
        finally:
            cleanup(([private.close] if private is not None else []) + [remove])

    @contextmanager
    def created_file(self, name: str) -> Iterator[_CreatedFile]:
        self.verify()
        with _new_file(self.path, self.fd, name, self.remove_file) as created:
            created.acquire()
            self.verify_file(name, created.identity)
            yield created

    def verify_file(self, name: str, expected: Identity) -> None:
        self.verify()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
        try:
            info = os.fstat(fd)
            if identity(info) != expected or not stat.S_ISREG(info.st_mode):
                raise PermissionError("backup file identity changed")
            _check_file(fd, path=self.path / name)
        finally:
            cleanup([partial(os.close, fd)])

    @contextmanager
    def snapshot_reader(self, name: str, expected: Identity) -> Iterator[int]:
        self.verify_file(name, expected)
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
        try:
            if identity(os.fstat(fd)) != expected:
                raise PermissionError("backup snapshot changed before streaming")
            yield fd
        finally:
            cleanup([partial(os.close, fd)])

    def publish(self, staged: str, final: str, expected: Identity, fd: int) -> None:
        self.verify_file(staged, expected)
        os.link(staged, final, src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)

    def check_published_directory(self) -> None:
        os.fsync(self.fd)

    def remove_file(self, name: str, expected: Identity) -> None:
        _remove_file(self.fd, name, expected)

    def remove_workspace(self, name: str, expected: Identity) -> None:
        current = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        if identity(current) != expected or not stat.S_ISDIR(current.st_mode):
            raise PermissionError("refusing to remove a substituted backup workspace")
        os.rmdir(name, dir_fd=self.fd)

    def close(self) -> None:
        handles, self._chain = self._chain, []
        cleanup([partial(os.close, fd) for fd, _ in reversed(handles)])
