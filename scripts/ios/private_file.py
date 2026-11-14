"""One way to create a file that holds release data: new, mode 0600, never through a link."""

from __future__ import annotations

import os
from pathlib import Path


def write_private(path: Path, text: str, *, durable: bool = False) -> None:
    """A fresh mode 0600 file. A stale file or planted link at *path* is removed first, never
    followed, and the create refuses to reuse anything that appears in between. ``durable``
    flushes the bytes to disk before returning."""
    path.unlink(missing_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
        if durable:
            handle.flush()
            os.fsync(handle.fileno())
