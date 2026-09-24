"""Atomic JSON/text sidecar load/write (unique tmp + fsync + replace)."""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
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
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    replaced = False
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
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
