"""Track evidence recorded under a project's ``artifacts``, so a fresh process reads it instead of rebuilding it (#2359).

Evaluating a track's tree decodes its source files whole and resamples them, and a command
that starts a new process (``podcast edit cut-range``) paid that for every track on every
run. A record holds the evaluated samples at the rates asked for: one file of a JSON header
line (the record's key and the length of each rate's samples) followed by the float32 bytes of
each rate in order. The file name and the header both carry a digest of everything the
evidence depends on, built by :func:`record_key`; a record read under another key, damaged,
truncated or of another shape is not a record, and the caller evaluates the tree again.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Sequence
from pathlib import Path
from typing import IO

import numpy as np

from podcast_mcp.util.atomic_file import atomic_write
from podcast_mcp.util.fingerprint import file_stamp

log = logging.getLogger(__name__)

RECORD_DIR = "track_evidence"
SUFFIX = ".evd"
# Bump when ``audio_eval`` or the resampling changes the samples a key evaluates to.
RECORD_REV = 1
# Every edit to a track's tree leaves a record behind; the newest are kept, by write time.
RECORDS_KEPT = 24
RECORDS_KEPT_BYTES = 1 << 30
_MAGIC = b"SCEVD1 "
_MAX_HEADER = 4096
_DTYPE = np.dtype("<f4")


def record_key(parts: Sequence[object]) -> str | None:
    """The digest of ``parts`` and the code revision, or ``None`` when they do not name the evidence the same way in every process.

    ``parts`` are printed with ``repr``; an object whose print holds a memory address would give
    each process its own key, so no record is made for it.
    """
    text = repr((RECORD_REV, *parts))
    if " at 0x" in text:
        return None
    return hashlib.sha256(text.encode()).hexdigest()


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
    except (OSError, ValueError, TypeError):
        return None
    return arrays


def write_record(directory: Path, key: str, evidence: dict[int, np.ndarray]) -> bool:
    """Record ``evidence`` under ``key`` atomically and drop the oldest records past the caps; ``False`` when nothing was written."""
    if not evidence or any(
        a.dtype != np.float32 or a.ndim != 1 or a.size == 0 for a in evidence.values()
    ):
        return False
    rates = list(evidence)
    header = json.dumps(
        {"key": key, "rates": rates, "sizes": [evidence[rate].size for rate in rates]}
    )
    path = record_path(directory, key)

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


def _prune(directory: Path, *, keep: Path) -> None:
    try:
        found = sorted(
            ((file_stamp(entry), entry) for entry in directory.glob(f"*{SUFFIX}")),
            key=lambda item: item[0].mtime_ns,
            reverse=True,
        )
        total = 0
        for index, (stat, entry) in enumerate(found):
            total += stat.size
            if entry != keep and (index >= RECORDS_KEPT or total > RECORDS_KEPT_BYTES):
                entry.unlink(missing_ok=True)
    except OSError:
        log.debug("track evidence records not pruned in %s", directory, exc_info=True)
