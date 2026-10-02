from __future__ import annotations

import contextlib
import os
import secrets
from collections.abc import Callable
from pathlib import Path
from typing import IO


def atomic_write(
    dest: Path,
    write: Callable[[IO[bytes]], object],
    *,
    mode: int | None = None,
    creation_mode: int = 0o600,
    prepare_temp: Callable[[Path], object] | None = None,
) -> Path:
    """Write bytes to a unique sibling, then publish them durably."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp: Path | None = None

    def prepare(path: Path) -> None:
        if mode is not None:
            os.chmod(path, mode)
        if prepare_temp is not None:
            prepare_temp(path)

    try:
        for _ in range(10):
            candidate = dest.with_name(f".{dest.name}.{secrets.token_hex(8)}.tmp")
            try:
                with open(
                    candidate, "xb", opener=lambda path, flags: os.open(path, flags, creation_mode)
                ) as handle:
                    temp = candidate
                    write(handle)
                    handle.flush()
            except FileExistsError:
                if temp is not None:
                    raise
                continue
            break
        else:
            raise FileExistsError(f"could not create temporary file for {dest}")
        assert temp is not None
        return publish_completed_file(temp, dest, prepare_temp=prepare)
    finally:
        if temp is not None:
            with contextlib.suppress(OSError):
                temp.unlink(missing_ok=True)


def publish_completed_file(
    temp: Path,
    dest: Path,
    *,
    prepare_temp: Callable[[Path], object] | None = None,
    before_replace: Callable[[], object] | None = None,
) -> Path:
    """Fsync a complete temp file, then replace its destination and fsync the directory."""
    try:
        with temp.open("r+b" if os.name == "nt" else "rb") as handle:
            if prepare_temp is not None:
                prepare_temp(temp)
            os.fsync(handle.fileno())
        if before_replace is not None:
            before_replace()
        os.replace(temp, dest)
        _fsync_directory(dest.parent)
        return dest
    finally:
        with contextlib.suppress(OSError):
            temp.unlink(missing_ok=True)


def _fsync_directory(directory: Path) -> None:
    if os.name != "posix":
        return
    with contextlib.suppress(OSError):
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
