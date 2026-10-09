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

Identity = tuple[int, int]


def identity(value: os.stat_result) -> Identity:
    return value.st_dev, value.st_ino


def _check_acl(fd: int) -> None:
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        libc.acl_get_fd_np.argtypes = [ctypes.c_int, ctypes.c_int]
        libc.acl_get_fd_np.restype = ctypes.c_void_p
        libc.acl_get_entry.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        libc.acl_get_tag_type.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        libc.acl_free.argtypes = [ctypes.c_void_p]
        acl = libc.acl_get_fd_np(fd, 0x100)
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
                    raise PermissionError("backup paths must not have extended ACL grants")
                selector = -1
        finally:
            libc.acl_free(acl)
    elif sys.platform.startswith("linux"):
        if any(name.startswith("system.posix_acl_") for name in os.listxattr(fd)):
            raise PermissionError("backup paths must not have extended ACL grants")
    else:
        raise OSError(errno.ENOTSUP, "backup ACL verification is unavailable")


def _check_directory(fd: int, *, private: bool, tighten: bool = False) -> None:
    info = os.fstat(fd)
    if info.st_uid not in (0, os.geteuid()) or not stat.S_ISDIR(info.st_mode):
        raise PermissionError("backup ancestry must be owned by the host user or root")
    _check_acl(fd)
    if private and tighten and info.st_uid == os.geteuid() and info.st_mode & 0o077:
        os.fchmod(fd, 0o700)
        info = os.fstat(fd)
    if private:
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise PermissionError("backup directory must be owned and private (0700)")
    elif info.st_mode & 0o022 and not (info.st_mode & stat.S_ISVTX):
        raise PermissionError("backup ancestry permits another user to replace entries")


def _open_chain(
    path: Path, *, create: bool = False, tighten: bool = False
) -> list[tuple[int, str | None]]:
    if not descriptor_walk_supported():
        raise OSError(errno.ENOTSUP, "registry storage requires directory descriptors")
    chain: list[tuple[int, str | None]] = []
    try:
        chain.append((open_nofollow_dir(path.anchor), None))
        for part in path.parts[1:]:
            parent = chain[-1][0]
            _check_directory(parent, private=False)
            if create:
                with suppress(FileExistsError):
                    os.mkdir(part, 0o700, dir_fd=parent)
            chain.append((open_nofollow_dir(part, dir_fd=parent), part))
        _check_directory(chain[-1][0], private=True, tighten=tighten)
        _verify_chain(chain)
        return chain
    except BaseException:
        cleanup([partial(os.close, fd) for fd, _ in reversed(chain)])
        raise


def _verify_chain(chain: list[tuple[int, str | None]]) -> None:
    for index, (fd, name) in enumerate(chain):
        _check_directory(fd, private=index == len(chain) - 1)
        if name is not None:
            current = os.stat(name, dir_fd=chain[index - 1][0], follow_symlinks=False)
            if identity(current) != identity(os.fstat(fd)):
                raise PermissionError("registry directory changed during access")


def _check_file(fd: int, *, tighten: bool = False) -> None:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
        raise PermissionError("registry file must be regular and owned by the host user")
    _check_acl(fd)
    if tighten and info.st_mode & 0o077:
        os.fchmod(fd, 0o600)
        info = os.fstat(fd)
    if info.st_mode & 0o077:
        raise PermissionError("registry file must be owned and private (0600)")


@contextmanager
def registry_scope(
    path: Path, names: tuple[str, ...], *, create: bool
) -> Iterator[Callable[[], None]]:
    chain = _open_chain(path, create=create, tighten=create)
    parent = chain[-1][0]

    allow_missing_main = create

    def verify() -> None:
        _verify_chain(chain)
        for name in names:
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except FileNotFoundError:
                if name != names[0] or allow_missing_main:
                    continue
                raise
            try:
                _check_file(fd, tighten=create)
                try:
                    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    if name != names[0]:
                        continue
                    raise
                if identity(os.fstat(fd)) != identity(current):
                    raise PermissionError("registry file changed during access")
            finally:
                cleanup([partial(os.close, fd)])

    try:
        verify()
        if create:
            try:
                fd = os.open(
                    names[0],
                    os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=parent,
                )
            except FileExistsError:
                pass
            else:
                try:
                    _check_file(fd)
                finally:
                    cleanup([partial(os.close, fd)])
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
        _verify_chain(self._chain)

    def exists(self, name: str) -> bool:
        try:
            os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False

    def create_workspace(self, name: str) -> Identity:
        self.verify()
        os.mkdir(name, 0o700, dir_fd=self.fd)
        return identity(os.stat(name, dir_fd=self.fd, follow_symlinks=False))

    def create_file(self, name: str) -> int:
        self.verify()
        fd = os.open(
            name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd
        )
        try:
            self.verify_file(name, identity(os.fstat(fd)))
            return fd
        except BaseException:
            info = identity(os.fstat(fd))
            cleanup([partial(os.close, fd), partial(self.remove_file, name, info)])
            raise

    def verify_file(self, name: str, expected: Identity) -> None:
        self.verify()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
        try:
            info = os.fstat(fd)
            if identity(info) != expected or not stat.S_ISREG(info.st_mode):
                raise PermissionError("backup file identity changed")
            _check_file(fd)
        finally:
            cleanup([partial(os.close, fd)])

    def open_snapshot(self, name: str, expected: Identity) -> int:
        self.verify_file(name, expected)
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
        try:
            if identity(os.fstat(fd)) != expected:
                raise PermissionError("backup snapshot changed before streaming")
            return fd
        except BaseException:
            cleanup([partial(os.close, fd)])
            raise

    def publish(self, staged: str, final: str, expected: Identity, fd: int) -> None:
        self.verify_file(staged, expected)
        os.link(staged, final, src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)

    def sync(self) -> None:
        os.fsync(self.fd)

    def remove_file(self, name: str, expected: Identity) -> None:
        try:
            current = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if identity(current) != expected:
            raise PermissionError("refusing to remove a substituted backup file")
        os.unlink(name, dir_fd=self.fd)

    def remove_workspace(self, name: str, expected: Identity) -> None:
        current = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        if identity(current) != expected or not stat.S_ISDIR(current.st_mode):
            raise PermissionError("refusing to remove a substituted backup workspace")
        os.rmdir(name, dir_fd=self.fd)

    def close(self) -> None:
        handles, self._chain = self._chain, []
        cleanup([partial(os.close, fd) for fd, _ in reversed(handles)])
