"""Mono decodes of source files kept on disk, read back a range at a time.

Evaluating a track's audio tree reads each source at its own rate. A whole 48 kHz decode of
a long episode is hundreds of megabytes, and a cut batch builds many tracks, so decodes are
spooled to a temp file once per (file revision, rate) and each read pulls only the samples it
needs. Memory stays at one chunk; the page cache does the rest.

A spool never outlives its process. On POSIX each file is opened and unlinked as soon as it is
decoded, so a SIGTERM or a crash leaves nothing behind; elsewhere the files sit in a
per-process directory that the next process to spool sweeps once its owner is gone.

:func:`spill` puts a finished array in the same directory and reads it back through a read-only
map, for results worth keeping beyond a batch (#2359). The map is the page cache's to reclaim;
nothing is resident that the kernel cannot take back.
"""

from __future__ import annotations

import atexit
import mmap
import os
import re
import shutil
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from podcast_mcp.engines.mono_downmix import ffmpeg_mono_mean_layout
from podcast_mcp.engines.ungated_audio import ffmpeg_build_id
from podcast_mcp.util.binaries import resolve_ffmpeg_pair
from podcast_mcp.util.fingerprint import file_stamp
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.util.process import pid_is_alive, run

SPOOL_LIMIT_BYTES = 6 << 30
# Free space a spill leaves alone, so the next decode to the spool does not run out of disk.
SPILL_HEADROOM_BYTES = 2 << 30
_SPILL_CHUNK_BYTES = 8 << 20
_MEMORY_FILESYSTEMS = {"tmpfs", "ramfs"}
_MOUNTINFO = Path("/proc/self/mountinfo")
_BYTES_PER_SAMPLE = 4

_lock = threading.RLock()
_entries: OrderedDict[tuple[object, ...], _Spool] = OrderedDict()
_directory: Path | None = None


@dataclass
class _Spool:
    path: Path
    size: int
    users: int = 0
    fd: int | None = None

    def read(self, start: int, stop: int) -> np.ndarray:
        offset = start * _BYTES_PER_SAMPLE
        if self.fd is None:
            return np.fromfile(self.path, dtype="<f4", count=stop - start, offset=offset)
        buffer = bytearray((stop - start) * _BYTES_PER_SAMPLE)
        if buffer and os.preadv(self.fd, [buffer], offset) != len(buffer):
            raise OSError(f"short read from the decode spool of {self.path.name}")
        return np.frombuffer(buffer, dtype="<f4")

    def discard(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        self.path.unlink(missing_ok=True)


_OWNER = re.compile(r"sharecut-decoded-(\d+)-")
_ORPHAN_AGE_SEC = 3600


def _sweep_orphans() -> None:
    """Remove spool directories whose process is gone, and unowned ones an hour old."""
    for directory in Path(tempfile.gettempdir()).glob("sharecut-decoded-*"):
        owner = _OWNER.match(directory.name)
        try:
            age = time.time() - directory.stat().st_mtime
        except OSError:
            continue
        if owner:
            pid = int(owner[1])
            orphaned = pid != os.getpid() and not pid_is_alive(pid)
        else:
            orphaned = age > _ORPHAN_AGE_SEC
        if orphaned:
            shutil.rmtree(directory, ignore_errors=True)


def _spool_directory() -> Path:
    global _directory
    if _directory is None:
        _sweep_orphans()
        _directory = Path(tempfile.mkdtemp(prefix=f"sharecut-decoded-{os.getpid()}-"))
        atexit.register(shutil.rmtree, _directory, ignore_errors=True)
    return _directory


def _identity(path: Path, sample_rate: int) -> tuple[object, ...]:
    """The decode's key: the whole file stamp (``ctime`` catches a copy that keeps size and mtime) and the ffmpeg build."""
    return (str(path.resolve()), *file_stamp(path), ffmpeg_build_id(), sample_rate)


def _decode(path: Path, sample_rate: int, target: Path) -> int:
    run(
        [
            resolve_ffmpeg_pair().ffmpeg,
            "-v",
            "error",
            "-y",
            "-i",
            str(path),
            "-map",
            "0:a:0",
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
        entry.discard()


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
                if os.name != "nt":
                    entry.fd = os.open(target, os.O_RDONLY)
                    target.unlink()
                _entries[key] = entry
            _entries.move_to_end(key)
            entry.users += 1
        self.entries.append(entry)
        self._by_path[path] = entry
        return entry


def _in_memory_filesystem(directory: Path) -> bool:
    """Whether ``directory`` sits on tmpfs or ramfs, where a spill is RAM the kernel cannot reclaim without swap."""
    try:
        lines = _MOUNTINFO.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    target = str(directory.resolve())
    best, kind = "", ""
    for line in lines:
        head, _, tail = line.partition(" - ")
        fields = head.split()
        if len(fields) < 5 or not tail:
            continue
        mount = fields[4].replace("\\040", " ")
        if len(mount) > len(best) and (
            target == mount or target.startswith(mount.rstrip("/") + "/")
        ):
            best, kind = mount, tail.split()[0]
    return kind in _MEMORY_FILESYSTEMS


def spill_allowed(size: int) -> bool:
    """Whether :func:`spill` may write ``size`` bytes: POSIX, a spool directory on disk, and ``size`` plus ``SPILL_HEADROOM_BYTES`` free."""
    if os.name == "nt":
        return False
    try:
        with _lock:
            directory = _spool_directory()
        return (
            not _in_memory_filesystem(directory)
            and shutil.disk_usage(directory).free >= size + SPILL_HEADROOM_BYTES
        )
    except OSError:
        return False


def spill(array: np.ndarray) -> np.ndarray:
    """``array``'s bytes in an unlinked file of the spool directory, read back through a read-only map.

    The file is unlinked before the first write and written with ``os.write``, so a full disk
    raises ``OSError`` here rather than a signal on a later page flush, and a failed spill leaves
    nothing behind. The result is a plain read-only array; its map is freed when the last view
    of it is gone. POSIX only (:func:`spill_allowed`).
    """
    data = np.ascontiguousarray(array)
    with _lock:
        directory = _spool_directory()
    fd, name = tempfile.mkstemp(dir=directory, suffix=".f32")
    try:
        os.unlink(name)
        view = memoryview(data).cast("B")
        for start in range(0, len(view), _SPILL_CHUNK_BYTES):
            chunk = view[start : start + _SPILL_CHUNK_BYTES]
            while chunk:
                chunk = chunk[os.write(fd, chunk) :]
        if os.fstat(fd).st_size != data.nbytes:
            raise OSError(f"short write to the evidence spill {name}")
        mapped = mmap.mmap(fd, data.nbytes, access=mmap.ACCESS_READ)
    finally:
        os.close(fd)
    return np.frombuffer(mapped, dtype=data.dtype).reshape(data.shape)
