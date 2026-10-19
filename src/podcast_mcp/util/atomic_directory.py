from __future__ import annotations

import ctypes
import errno
import os
import sys


def rename_noreplace(src: str, dst: str, root_fd: int) -> None:
    """Atomically promote or restore a directory without replacing its destination."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux"):
        operation = getattr(libc, "renameat2", None)
        if operation is None:
            raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
        result = operation(root_fd, os.fsencode(src), root_fd, os.fsencode(dst), 1)
    elif sys.platform == "darwin":
        operation = getattr(libc, "renameatx_np", None)
        if operation is None:
            raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
        result = operation(root_fd, os.fsencode(src), root_fd, os.fsencode(dst), 4)
    else:
        raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), dst)
