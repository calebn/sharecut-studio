"""Open resolved local media without following a later symlink replacement."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import BinaryIO

_NOFOLLOW_FLAGS = ("O_DIRECTORY", "O_NOFOLLOW")


def _descriptor_walk_supported() -> bool:
    """True where every path component can be opened relative to a no-follow descriptor."""
    return os.open in os.supports_dir_fd and all(hasattr(os, flag) for flag in _NOFOLLOW_FLAGS)


def open_pinned_media(path: Path) -> BinaryIO:
    """Return a regular file pinned by its descriptor.

    Callers must first authorize and resolve the path within their own workspace root.
    This prevents a replacement between that check and the actual read from redirecting
    the read. POSIX walks every component no-follow through directory descriptors. Where
    those are unavailable (Windows) the fallback opens by path, rejects link components, and
    checks that the descriptor and the path still name the same regular file; an open file
    cannot be deleted or renamed there, so the descriptor stays the file that was checked.
    """
    absolute = Path(path)
    if not absolute.is_absolute() or ".." in absolute.parts:
        raise ValueError("media path must be absolute and normalized")
    if len(absolute.parts) < 2:
        raise ValueError("media path must name a file")
    if _descriptor_walk_supported():
        return _open_by_descriptor_walk(absolute)
    return _open_verified_by_path(absolute)


def _open_by_descriptor_walk(absolute: Path) -> BinaryIO:
    parts = absolute.parts[1:]
    directory = os.open(absolute.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in parts[:-1]:
            next_directory = os.open(
                component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
            )
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
    return path.is_symlink() or (hasattr(os.path, "isjunction") and os.path.isjunction(path))


def _same_regular_file(opened: os.stat_result, named: os.stat_result) -> bool:
    return (
        stat.S_ISREG(opened.st_mode)
        and stat.S_ISREG(named.st_mode)
        and (opened.st_dev, opened.st_ino) == (named.st_dev, named.st_ino)
    )


def _open_verified_by_path(absolute: Path) -> BinaryIO:
    """Portable fallback: open by path, then prove the descriptor is what the path names."""
    if any(_is_link(parent) for parent in absolute.parents[:-1]):
        raise ValueError("media path must not traverse links")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(absolute, flags)
    try:
        if not _same_regular_file(os.fstat(fd), os.lstat(absolute)):
            raise ValueError("media must be a regular file")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise
