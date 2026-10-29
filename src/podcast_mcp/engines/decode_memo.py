"""A process-wide, byte-capped memo of decoded raw recordings (#2359).

A recording's decode at one rate is the same array until the file changes, yet propose and
approve (and each later call in a session) decoded it again. ``TrackRmsCache.from_recording``
keeps one decode per file stamp and rate for the life of the process, under a byte cap.

Only raw workspace recordings go through it. A temp render, a processed stem or any file the
caller is about to delete stays on ``from_timeline_stem``, which keeps nothing.

* **Key**: resolved path, device, inode, size, mtime, ctime, sample rate and the ffmpeg build.
  ``ctime`` moves on every write and cannot be set from userspace, so a copy that keeps size
  and mtime is still a miss.
* **No stale store**: the file is stat'd before and after the decode and stored only if both
  stamps are equal, and a file whose mtime or ctime is within the last ``RACY_SECONDS`` is never
  stored or served (a coarse clock can give a rewrite the same stamp, and ``cp -p`` keeps an old
  mtime but not the ctime). Whenever a file is read and its stamp is not the stored one, the
  earlier decode of that path and rate is dropped, even if the new decode is not stored.
* **Single flight**: one lock per key, held across the decode, never one lock across keys, so
  the 8 kHz and 16 kHz decodes of a track still run side by side. The lock lives while any
  caller is queued on it, so after a failed decode the waiters retry one at a time.
* **Cap**: ``PODCAST_DECODE_MEMO_MB`` (default 768); least recently used out first, by array
  bytes. ``0`` (or a negative number) turns the memo off and every call is the uncached build;
  a value that is not a finite number falls back to the default.
* **Read-only**: with the memo on, every call returns samples that are read-only, whether the
  decode was stored, served, too big, racy or changed under the decode. Only the cap-0 path
  returns the build untouched.
* **Hits** return a fresh wrapper around a read-only view of the stored samples.
  ``PODCAST_VERDICT_VERIFY`` or ``PODCAST_EVIDENCE_VERIFY`` re-decodes on every hit, outside
  any batch scope, and raises ``AssertionError`` unless the bits are equal.
"""

from __future__ import annotations

import dataclasses
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol, TypeVar, cast

import numpy as np

from podcast_mcp import settings
from podcast_mcp.engines.ungated_audio import ffmpeg_build_id
from podcast_mcp.util.batch_scope import unscoped
from podcast_mcp.util.fingerprint import FileStamp, file_stamp

CAP_ENV = "PODCAST_DECODE_MEMO_MB"
DEFAULT_CAP_MB = 768
VERIFY_ENVS = ("PODCAST_VERDICT_VERIFY", "PODCAST_EVIDENCE_VERIFY")
RACY_SECONDS = 2.0


class _Decoded(Protocol):
    samples: np.ndarray


T = TypeVar("T", bound=_Decoded)

_Key = tuple[str, FileStamp, int, tuple[object, ...]]


def cap_bytes() -> int:
    """The byte cap now in force; read live so a setting takes effect on the next call.

    A value that is not finite (``inf``, ``nan``, ``1e400``) is the default, as an unparsable one is.
    """
    megabytes = settings.number(CAP_ENV, DEFAULT_CAP_MB)
    if not math.isfinite(megabytes):
        megabytes = DEFAULT_CAP_MB
    return max(0, int(megabytes * (1 << 20)))


def _now_ns() -> int:
    return time.time_ns()


def _same_bits(got: np.ndarray, want: np.ndarray) -> bool:
    if got.shape != want.shape or got.dtype != want.dtype:
        return False
    if got.dtype == np.float32:
        return bool(np.array_equal(got.view(np.uint32), want.view(np.uint32)))
    return bool(np.array_equal(got, want))


class _Flight:
    """The lock of one key and how many callers hold or wait on it."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.users = 0


class DecodeMemo:
    """See the module docstring. One instance per process: ``_MEMO``."""

    def __init__(self) -> None:
        self._entries: OrderedDict[_Key, _Decoded] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()
        self._building: dict[_Key, _Flight] = {}

    def get_or_decode(self, path: Path, sample_rate: int, build: Callable[[], T]) -> T:
        """``build()``, or a wrapper of the stored result for this file stamp and rate.

        Except with the memo off, the samples returned are read-only on every path.
        """
        try:
            cap = cap_bytes()
        except Exception:
            cap = DEFAULT_CAP_MB << 20
        if cap == 0:
            return build()
        try:
            resolved = path.resolve()
            stamp = file_stamp(resolved)
            key: _Key = (str(resolved), stamp, sample_rate, ffmpeg_build_id())
        except Exception:
            return _frozen(build())
        if _now_ns() - max(stamp.mtime_ns, stamp.ctime_ns) < RACY_SECONDS * 1e9:
            self._forget(key, keep=None)
            return _frozen(build())
        with self._lock:
            held = self._find(key)
            flight = None
            if held is None:
                flight = self._building.setdefault(key, _Flight())
                flight.users += 1
        if held is not None:
            return self._hit(held, build)
        assert flight is not None
        try:
            with flight.lock:
                with self._lock:
                    held = self._find(key)
                if held is not None:
                    return self._hit(held, build)
                return self._store(key, resolved, build(), cap)
        finally:
            with self._lock:
                flight.users -= 1
                if flight.users == 0:
                    self._building.pop(key, None)

    def _hit(self, held: Any, build: Callable[[], T]) -> T:
        if any(settings.flag(env) for env in VERIFY_ENVS):
            with unscoped():
                fresh = build()
            if not _same_bits(held.samples, fresh.samples):
                raise AssertionError("decode memo hit differs from a fresh decode of the file")
        return dataclasses.replace(held)

    def _store(self, key: _Key, resolved: Path, built: T, cap: int) -> T:
        try:
            unchanged = file_stamp(resolved) == key[1]
        except OSError:
            unchanged = False
        nbytes = int(built.samples.nbytes)
        if not unchanged or nbytes > cap:
            self._forget(key, keep=None)
            return _frozen(built)
        entry = _frozen(built)
        with self._lock:
            self._drop_older(key, keep=key)
            self._entries[key] = entry
            self._bytes += nbytes
            while self._bytes > cap:
                self._drop(next(iter(self._entries)))
        return dataclasses.replace(cast(Any, entry))

    def _forget(self, key: _Key, keep: _Key | None) -> None:
        with self._lock:
            self._drop_older(key, keep)

    def _drop_older(self, key: _Key, keep: _Key | None) -> None:
        for old in [k for k in self._entries if k[0] == key[0] and k[2] == key[2] and k != keep]:
            self._drop(old)

    def _find(self, key: _Key) -> Any | None:
        entry = self._entries.get(key)
        if entry is not None:
            self._entries.move_to_end(key)
        return entry

    def _drop(self, key: _Key) -> None:
        self._bytes -= int(self._entries.pop(key).samples.nbytes)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0

    def held_bytes(self) -> int:
        with self._lock:
            return self._bytes

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


def _frozen(built: T) -> T:
    """``built`` with its samples a read-only view; the array itself is the caller's alone."""
    view = built.samples.view()
    view.flags.writeable = False
    return dataclasses.replace(cast(Any, built), samples=view)


_MEMO = DecodeMemo()


def decode_once(path: Path, sample_rate: int, build: Callable[[], T]) -> T:
    """``build()`` through the process memo; the one entry point for ``from_recording``."""
    return _MEMO.get_or_decode(path, sample_rate, build)
