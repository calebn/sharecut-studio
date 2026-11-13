from __future__ import annotations

import ctypes
import errno
import os

from podcast_mcp.util import host_platform


def rename_noreplace(src: str, dst: str, root_fd: int, *, dst_root_fd: int | None = None) -> None:
    """Atomically promote or restore a directory without replacing its destination."""
    destination_fd = root_fd if dst_root_fd is None else dst_root_fd
    libc = ctypes.CDLL(None, use_errno=True)
    kernel = host_platform.current().kernel
    if kernel == "linux":
        operation = getattr(libc, "renameat2", None)
        if operation is None:
            raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
        result = operation(root_fd, os.fsencode(src), destination_fd, os.fsencode(dst), 1)
    elif kernel == "darwin":
        operation = getattr(libc, "renameatx_np", None)
        if operation is None:
            raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
        result = operation(root_fd, os.fsencode(src), destination_fd, os.fsencode(dst), 4)
    else:
        raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), dst)
