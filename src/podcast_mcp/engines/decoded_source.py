"""Mono decodes of source files kept on disk, read back a range at a time.

Evaluating a track's audio tree reads each source at its own rate. A whole 48 kHz decode of
a long episode is hundreds of megabytes, and a cut batch builds many tracks, so decodes are
spooled to a temp file once per (file revision, rate) and each read pulls only the samples it
needs. Memory stays at one chunk; the page cache does the rest.
"""

from __future__ import annotations

import atexit
import shutil
import tempfile
import threading
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from podcast_mcp.engines.mono_downmix import ffmpeg_mono_mean_layout
from podcast_mcp.util.binaries import resolve_ffmpeg_pair
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.util.process import run

SPOOL_LIMIT_BYTES = 6 << 30
_BYTES_PER_SAMPLE = 4

_lock = threading.RLock()
_entries: OrderedDict[tuple[object, ...], _Spool] = OrderedDict()
_directory: Path | None = None


@dataclass
class _Spool:
    path: Path
    size: int
    users: int = 0

    def read(self, start: int, stop: int) -> np.ndarray:
        return np.fromfile(
            self.path, dtype="<f4", count=stop - start, offset=start * _BYTES_PER_SAMPLE
        )


def _spool_directory() -> Path:
    global _directory
    if _directory is None:
        _directory = Path(tempfile.mkdtemp(prefix="sharecut-decoded-"))
        atexit.register(shutil.rmtree, _directory, ignore_errors=True)
    return _directory


def _identity(path: Path, sample_rate: int) -> tuple[object, ...]:
    stat = path.stat()
    return (
        str(path.resolve()),
        stat.st_dev,
        stat.st_ino,
        stat.st_size,
        stat.st_mtime_ns,
        sample_rate,
    )


def _decode(path: Path, sample_rate: int, target: Path) -> int:
    run(
        [
            resolve_ffmpeg_pair().ffmpeg,
            "-v",
            "error",
            "-y",
            "-i",
            str(path),
            *ffmpeg_mono_mean_layout(path),
            "-ar",
            str(sample_rate),
            "-f",
            "f32le",
            str(target),
        ],
        capture_output=True,
        check=True,
    )
    samples = target.stat().st_size // _BYTES_PER_SAMPLE
    if samples == 0:
        raise NoAudioDecodedError(path)
    return samples


def _evict() -> None:
    total = sum(entry.size * _BYTES_PER_SAMPLE for entry in _entries.values())
    for key in list(_entries):
        if total <= SPOOL_LIMIT_BYTES:
            break
        entry = _entries[key]
        if entry.users:
            continue
        total -= entry.size * _BYTES_PER_SAMPLE
        del _entries[key]
        entry.path.unlink(missing_ok=True)


@contextmanager
def decoded_sources(sample_rate: int) -> Iterator[DecodedSources]:
    """Readers for source files at ``sample_rate``, kept on disk until the block ends."""
    held = DecodedSources(sample_rate)
    try:
        yield held
    finally:
        with _lock:
            for entry in held.entries:
                entry.users -= 1
            _evict()


class DecodedSources:
    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        self.entries: list[_Spool] = []
        self._by_path: dict[Path, _Spool] = {}

    def __call__(self, path: Path) -> _Spool:
        if path in self._by_path:
            return self._by_path[path]
        key = _identity(path, self.sample_rate)
        with _lock:
            entry = _entries.get(key)
            if entry is None:
                target = _spool_directory() / f"{len(_entries)}-{abs(hash(key))}.f32"
                entry = _Spool(target, _decode(path, self.sample_rate, target))
                _entries[key] = entry
            _entries.move_to_end(key)
            entry.users += 1
        self.entries.append(entry)
        self._by_path[path] = entry
        return entry
