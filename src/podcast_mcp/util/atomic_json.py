"""Atomic JSON/text/bytes sidecar and file load/write (unique tmp + fsync + replace)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from podcast_mcp.util.atomic_file import atomic_write


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


def write_text_atomic(
    path: Path, text: str, *, mode: int | None = None, creation_mode: int = 0o600
) -> Path:
    return atomic_write(
        path,
        lambda handle: handle.write(text.encode("utf-8")),
        mode=mode,
        creation_mode=creation_mode,
    )


def write_bytes_atomic(path: Path, data: bytes, *, mode: int | None = None) -> Path:
    return atomic_write(path, lambda handle: handle.write(data), mode=mode)


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

    return atomic_write(dest, fill, prepare_temp=copy_metadata)
