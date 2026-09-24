"""Atomic JSON/text sidecar and file load/write (unique tmp + fsync + replace)."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any


def load_json_object(path: Path) -> dict[str, Any] | None:
    """Return a JSON object, or None if the file is missing.

    Present but undecodable or non-object payloads raise ValueError so callers
    do not treat a truncated sidecar as absent.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ValueError(f"unreadable JSON sidecar: {path}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"corrupt JSON sidecar: {path}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"sidecar must be a JSON object: {path}")
    return data


def write_json_atomic(
    path: Path,
    payload: dict[str, Any],
    *,
    mode: int | None = None,
    compact: bool = False,
) -> Path:
    text = json.dumps(payload, separators=(",", ":")) if compact else json.dumps(payload, indent=2)
    return write_text_atomic(path, text + "\n", mode=mode)


def write_text_atomic(path: Path, text: str, *, mode: int | None = None) -> Path:
    def fill(handle: Any) -> None:
        handle.write(text)

    return _replace_from_temp(path, fill, mode=mode, binary=False)


def copy_file_atomic(src: Path, dest: Path) -> Path:
    """Copy *src* to *dest* atomically, preserving mode and mtime like ``copy2``.

    Writes into a unique temp file next to *dest*, fsyncs it, then swaps it
    into place with ``os.replace`` so concurrent readers never see a partial
    copy. Mode and mtime are applied to the temp file before the swap, so
    the publish is atomic in bytes, mode, and mtime together. On failure the
    previous *dest* (if any) is left untouched and no temp file remains.
    """

    def fill(handle: Any) -> None:
        with open(src, "rb") as source:
            shutil.copyfileobj(source, handle)

    def copy_metadata(tmp: Path) -> None:
        shutil.copystat(src, tmp)

    return _replace_from_temp(dest, fill, mode=None, binary=True, before_replace=copy_metadata)


def _replace_from_temp(
    path: Path,
    fill: Callable[[Any], None],
    *,
    mode: int | None,
    binary: bool,
    before_replace: Callable[[Path], None] | None = None,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    replaced = False
    try:
        open_mode = "wb" if binary else "w"
        open_kwargs: dict[str, Any] = {} if binary else {"encoding": "utf-8"}
        with os.fdopen(fd, open_mode, **open_kwargs) as handle:
            fill(handle)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        if before_replace is not None:
            before_replace(tmp)
        os.replace(tmp, path)
        replaced = True
        if mode is not None:
            os.chmod(path, mode)
        _fsync_directory(path.parent)
    finally:
        if not replaced:
            tmp.unlink(missing_ok=True)
    return path


def _fsync_directory(directory: Path) -> None:
    """Persist a completed rename on POSIX; Windows cannot open directories."""
    if os.name != "posix":
        return
    with contextlib.suppress(OSError):
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
