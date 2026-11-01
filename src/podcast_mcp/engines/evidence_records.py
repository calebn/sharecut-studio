"""Track evidence recorded under a project's ``artifacts``, so a fresh process reads it instead of rebuilding it (#2359).

Evaluating a track's tree decodes its source files whole and resamples them, and a command
that starts a new process (``podcast edit cut-range``) paid that for every track on every
run. A record holds the evaluated samples at the rates asked for: one file of a JSON header
line (the record's key, the length of each rate's samples and a checksum of them) followed by the float32 bytes of
each rate in order. The file name and the header both carry a digest of everything the
evidence depends on, built by :func:`record_key`; a record read under another key, damaged,
truncated or of another shape is not a record, and the caller evaluates the tree again.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import shutil
import time
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import IO

import numpy as np

from podcast_mcp.engines.decoded_source import SPILL_HEADROOM_BYTES
from podcast_mcp.util.atomic_file import atomic_write
from podcast_mcp.util.fingerprint import file_stamp
from podcast_mcp.util.hashing import short_digest

log = logging.getLogger(__name__)

RECORD_DIR = "track_evidence"
SUFFIX = ".evd"
# Bump when ``audio_eval`` or the resampling changes the samples a key evaluates to.
RECORD_REV = 2
# Every edit to a track's tree leaves a record behind; the newest are kept, by write time.
RECORDS_KEPT = 24
RECORDS_KEPT_BYTES = 1 << 30
_MAGIC = b"SCEVD1 "
_MAX_HEADER = 4096
# A temporary file an interrupted write left behind is removed once it is this old.
_STALE_TEMP_NS = 600 * 10**9
_DTYPE = np.dtype("<f4")


def record_key(parts: Sequence[object]) -> str | None:
    """The digest of ``parts`` and the code revision, or ``None`` when they do not name the evidence the same way in every process.

    ``parts`` are printed with ``repr``; an object whose print holds a memory address would give
    each process its own key, so no record is made for it.
    """
    text = repr((RECORD_REV, *parts))
    if " at 0x" in text:
        return None
    return short_digest(text, 64)


def record_path(directory: Path, key: str) -> Path:
    return directory / f"{key[:32]}{SUFFIX}"


def read_record(directory: Path, key: str, rates: Sequence[int]) -> dict[int, np.ndarray] | None:
    """The evidence recorded under ``key`` at ``rates``, or ``None`` when there is none that is whole."""
    path = record_path(directory, key)
    try:
        with open(path, "rb") as handle:
            if handle.read(len(_MAGIC)) != _MAGIC:
                return None
            line = handle.readline(_MAX_HEADER)
            header = json.loads(line)
            if (
                not isinstance(header, dict)
                or header.get("key") != key
                or header.get("rates") != list(rates)
            ):
                return None
            sizes = header.get("sizes")
            if (
                not isinstance(sizes, list)
                or len(sizes) != len(rates)
                or not all(type(n) is int and n > 0 for n in sizes)
            ):
                return None
            if os.fstat(handle.fileno()).st_size != handle.tell() + sum(sizes) * _DTYPE.itemsize:
                return None
            arrays = {}
            for rate, size in zip(rates, sizes, strict=True):
                array = np.fromfile(handle, dtype=_DTYPE, count=size)
                if array.size != size:
                    return None
                arrays[rate] = array.astype(np.float32, copy=False)
            if header.get("sum") != _checksum(arrays, arrays.values()):
                return None
    except (OSError, ValueError, TypeError):
        return None
    with contextlib.suppress(OSError):
        # A record that is read stays among the newest, so pruning by write time keeps a hot one.
        os.utime(path)
    return arrays


def _checksum(rates: Iterable[int], arrays: Iterable[np.ndarray]) -> str:
    """The checksum of the rates, the length of each rate's samples and the samples, so a header re-split over the same bytes does not read."""
    arrays = list(arrays)
    digest = hashlib.blake2b(digest_size=16)
    digest.update(json.dumps([list(rates), [a.size for a in arrays]]).encode())
    for array in arrays:
        digest.update(np.ascontiguousarray(array, dtype=_DTYPE).data)
    return digest.hexdigest()


def write_record(directory: Path, key: str, evidence: dict[int, np.ndarray]) -> bool:
    """Record ``evidence`` under ``key`` atomically and drop the oldest records past the caps; ``False`` when nothing was written."""
    if (
        not isinstance(evidence, dict)
        or not evidence
        or any(a.dtype != np.float32 or a.ndim != 1 or a.size == 0 for a in evidence.values())
    ):
        return False
    rates = list(evidence)
    header = json.dumps(
        {
            "key": key,
            "rates": rates,
            "sizes": [evidence[rate].size for rate in rates],
            "sum": _checksum(rates, evidence.values()),
        }
    )
    path = record_path(directory, key)
    if not _room_for(directory, sum(a.nbytes for a in evidence.values())):
        log.debug("track evidence record not written: too little free space near %s", directory)
        return False

    def fill(handle: IO[bytes]) -> None:
        handle.write(_MAGIC + header.encode() + b"\n")
        for rate in rates:
            handle.write(np.ascontiguousarray(evidence[rate], dtype=_DTYPE).data)

    try:
        atomic_write(path, fill)
    except OSError:
        log.debug("track evidence record not written to %s", path, exc_info=True)
        return False
    _prune(directory, keep=path)
    return True


def _room_for(directory: Path, size: int) -> bool:
    """Whether ``size`` bytes can be written and still leave the headroom the decode spool keeps free."""
    try:
        directory.mkdir(parents=True, exist_ok=True)
        return shutil.disk_usage(directory).free >= size + SPILL_HEADROOM_BYTES
    except OSError:
        return False


def _prune(directory: Path, *, keep: Path) -> None:
    """Drop the oldest records past the caps (never ``keep``) and temporary files an interrupted write left."""
    found: list[tuple[int, int, Path]] = []
    now = time.time_ns()
    try:
        entries = list(directory.iterdir())
    except OSError:
        log.debug("track evidence records not pruned in %s", directory, exc_info=True)
        return
    for entry in entries:
        try:
            stamp = file_stamp(entry)
            if entry.suffix == SUFFIX and not entry.name.startswith("."):
                found.append((stamp.mtime_ns, stamp.size, entry))
            elif (
                entry.name.startswith(".")
                and entry.suffix == ".tmp"
                and now - stamp.mtime_ns > _STALE_TEMP_NS
            ):
                entry.unlink(missing_ok=True)
        except FileNotFoundError:
            continue
        except OSError:
            log.debug("track evidence record %s not pruned", entry, exc_info=True)
    found.sort(key=lambda item: item[0], reverse=True)
    total = 0
    for index, (_, size, entry) in enumerate(found):
        total += size
        if entry != keep and (index >= RECORDS_KEPT or total > RECORDS_KEPT_BYTES):
            try:
                entry.unlink(missing_ok=True)
            except OSError:
                log.debug("track evidence record %s not removed", entry, exc_info=True)
