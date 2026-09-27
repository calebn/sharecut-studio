"""Open resolved local media without following a later symlink replacement."""

from __future__ import annotations

import errno
import os
import stat
from pathlib import Path
from typing import BinaryIO

_NOFOLLOW_FLAGS = ("O_DIRECTORY", "O_NOFOLLOW")

# Only Windows takes the weaker path-based fallback; any other platform without the
# descriptor walk fails closed. Tests set this to exercise the fallback on POSIX.
_PATH_FALLBACK_PLATFORM = os.name == "nt"


def descriptor_walk_supported() -> bool:
    """True where every path component can be opened relative to a no-follow descriptor (not Windows)."""
    return os.open in os.supports_dir_fd and all(hasattr(os, flag) for flag in _NOFOLLOW_FLAGS)


def open_nofollow_dir(path: str | Path, *, dir_fd: int | None = None) -> int:
    """Open *path* as a no-follow directory descriptor.

    Callers check :func:`descriptor_walk_supported` first.
    """
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)


def open_pinned_media(path: Path) -> BinaryIO:
    """Return a regular file pinned by its descriptor.

    Callers must first authorize and resolve the path within their own workspace root.
    On Windows the path must already be fully resolved (``Path.resolve()``, as
    ``project.workspace_path()`` does): an unresolved spelling such as an 8.3 short name,
    a ``subst`` drive or a mapped network drive fails the ``realpath`` comparison and is
    refused.
    This prevents a replacement between that check and the actual read from redirecting
    the read. POSIX walks every component no-follow through directory descriptors. Windows
    has no such walk and uses :func:`_open_verified_by_path`, which is weaker (see there).
    Any other platform without the walk fails closed with ``ENOTSUP``.
    """
    absolute = Path(path)
    if not absolute.is_absolute() or ".." in absolute.parts:
        raise ValueError("media path must be absolute and normalized")
    if len(absolute.parts) < 2:
        raise ValueError("media path must name a file")
    if descriptor_walk_supported():
        return _open_by_descriptor_walk(absolute)
    if _PATH_FALLBACK_PLATFORM:
        return _open_verified_by_path(absolute)
    raise OSError(errno.ENOTSUP, "pinned media reads require no-follow directory descriptors")


def _open_by_descriptor_walk(absolute: Path) -> BinaryIO:
    parts = absolute.parts[1:]
    directory = open_nofollow_dir(absolute.anchor)
    try:
        for component in parts[:-1]:
            next_directory = open_nofollow_dir(component, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError("media must be a regular file")
            return os.fdopen(fd, "rb")
        except BaseException:
            os.close(fd)
            raise
    finally:
        os.close(directory)


def _is_link(path: Path) -> bool:
    """Symlink or Windows junction.

    Junctions only ever name directories, so callers that check a file path
    (``services/play.py``, ``services/ingest.py``) need only ``Path.is_symlink()``.
    """
    return path.is_symlink() or (hasattr(os.path, "isjunction") and os.path.isjunction(path))


def _reject_link_parents(absolute: Path) -> None:
    if any(_is_link(parent) for parent in absolute.parents[:-1]):
        raise ValueError("media path must not traverse links")


def _same_regular_file(opened: os.stat_result, named: os.stat_result) -> bool:
    return (
        stat.S_ISREG(opened.st_mode)
        and stat.S_ISREG(named.st_mode)
        and (opened.st_dev, opened.st_ino) == (named.st_dev, named.st_ino)
    )


def _open_verified_by_path(absolute: Path) -> BinaryIO:
    """Windows fallback: open by path, then prove the descriptor is what the path names.

    Checks, in order: no parent is a symlink or junction; after the open, the descriptor
    has a non-zero file ID (filesystems that report none, such as some FAT volumes and
    network shares, fail closed) and matches the path's ``lstat`` as the same regular
    file; the parents are still link-free and ``realpath`` still equals the path. An open
    file cannot be deleted or renamed on Windows. Remaining window: a parent swapped for
    a junction before the open and restored between the identity check and the link
    re-checks is not detected, so this is weaker than the POSIX descriptor walk.
    """
    _reject_link_parents(absolute)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(absolute, flags)
    try:
        opened = os.fstat(fd)
        if opened.st_ino == 0 or opened.st_dev == 0:
            raise ValueError("media file identity is unverifiable on this filesystem")
        if not _same_regular_file(opened, os.lstat(absolute)):
            raise ValueError("media must be a regular file")
        _reject_link_parents(absolute)
        if os.path.normcase(os.path.realpath(absolute)) != os.path.normcase(str(absolute)):
            raise ValueError("media path must already be resolved and must not traverse links")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise
