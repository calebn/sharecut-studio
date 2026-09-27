"""Open resolved local media without following a later symlink replacement."""

from __future__ import annotations

import errno
import os
import stat
from pathlib import Path
from typing import BinaryIO


def open_pinned_media(path: Path) -> BinaryIO:
    """Return a regular file pinned by its descriptor, walking every component no-follow.

    Callers must first authorize and resolve the path within their own workspace root.
    This prevents a replacement between that check and the actual read from redirecting
    the read. Systems without descriptor-relative, no-follow opens fail closed.
    """
    if os.open not in os.supports_dir_fd or not all(
        hasattr(os, flag) for flag in ("O_DIRECTORY", "O_NOFOLLOW")
    ):
        raise OSError(errno.ENOTSUP, "pinned media reads require no-follow directory descriptors")
    absolute = Path(path)
    if not absolute.is_absolute() or ".." in absolute.parts:
        raise ValueError("media path must be absolute and normalized")
    parts = absolute.parts[1:]
    if not parts:
        raise ValueError("media path must name a file")
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
