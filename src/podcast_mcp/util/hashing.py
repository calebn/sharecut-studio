"""Shared streamed hashes for files on disk."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path


def sha256_file(path: Path, *, chunk_size: int = 1_048_576) -> str:
    """Return the full SHA-256 hex digest without loading the file into memory."""
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_head_tail(path: Path, *, span: int = 65_536) -> str:
    """SHA-256 of the first and last ``span`` bytes (the whole file when shorter than ``2 * span``).

    A cheap content fingerprint for cache keys: it catches a rewrite that keeps inode,
    size and mtime when the rewrite touches either end, without reading a long media
    file end to end.
    """
    if span <= 0:
        raise ValueError("span must be positive")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        size = os.fstat(handle.fileno()).st_size
        digest.update(handle.read(span))
        if size > span:
            handle.seek(max(span, size - span))
            digest.update(handle.read(span))
    return digest.hexdigest()
