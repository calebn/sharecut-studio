"""Whether a pin-matching model file loads on this machine, remembered per file state (#1998).

Status reads ``failure`` and never loads; loaders and ``install_model`` ``record`` the outcome.
A file is keyed by its resolved path, size, mtime and the installed onnxruntime version, so a
new download or a reinstalled onnxruntime is a miss.
"""

from __future__ import annotations

import threading
from importlib import metadata
from pathlib import Path

from podcast_mcp.util.fingerprint import file_stamp

_MAX_ERROR_CHARS = 200
_LOCK = threading.Lock()
_CACHE: dict[tuple[str, int, int, str], str | None] = {}


def _key(path: Path) -> tuple[str, int, int, str] | None:
    try:
        resolved = path.resolve()
        stamp = file_stamp(resolved)
    except OSError:
        return None
    try:
        runtime = metadata.version("onnxruntime")
    except metadata.PackageNotFoundError:
        runtime = "none"
    return str(resolved), stamp.size, stamp.mtime_ns, runtime


def error_text(exc: BaseException, path: Path) -> str:
    """``exc`` as one line of text with ``path`` shown by its file name only."""
    text = f"{type(exc).__name__}: {exc}"
    for spelling in {str(path), str(path.resolve())}:
        text = text.replace(spelling, path.name)
    return text[:_MAX_ERROR_CHARS]


def record(path: Path, error: str | None) -> None:
    """Remember that ``path`` loaded (``error`` None) or failed with ``error``."""
    if (key := _key(path)) is not None:
        with _LOCK:
            _CACHE[key] = error


def forget(path: Path) -> None:
    try:
        resolved = str(path.resolve())
    except OSError:
        return
    with _LOCK:
        for key in [k for k in _CACHE if k[0] == resolved]:
            del _CACHE[key]


def failure(path: Path) -> str | None:
    """The remembered load error for this file state; one stat, never a load."""
    if (key := _key(path)) is None:
        return None
    with _LOCK:
        return _CACHE.get(key)
