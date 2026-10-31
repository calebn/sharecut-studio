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
  The build decodes the resolved path the key names, so a link retargeted during the decode
  cannot supply another file's samples.
* **Single flight**: one lock per key, held across the decode, never one lock across keys, so
  the 8 kHz and 16 kHz decodes of a track still run side by side. The lock lives while any
  caller is queued on it, so after a failed decode the waiters retry one at a time.
* **Cap**: ``PODCAST_DECODE_MEMO_MB`` (default 768); least recently used out first, by array
  bytes. ``0`` (or a negative number) turns the memo off and every call is the uncached build;
  a value that is not a finite number falls back to the default.
* **Idle release**: ``PODCAST_DECODE_MEMO_IDLE_S`` (default 90) seconds with no hit or store and no
  decode in flight, and the memo clears itself, so a finished session does not keep the cap's worth
  of RSS. A decode that overlaps the deadline can push the release to about two idle periods after
  the last use. ``0`` (or a negative number) never releases; a value that is not a finite number
  falls back to the default; one above a day counts as a day. A daemon timer, armed only while the
  memo holds an entry, does the check; if it cannot start, the memo simply keeps its entries.
* **Spill**: the release and an eviction past the cap copy an entry to an unlinked file of the decode
  spool and serve it from a read-only map (``decoded_source.spill``), under the same key and checks and
  never promoted back to RAM. ``PODCAST_DECODE_MEMO_SPILL_MB`` (default 1536; ``0`` is the memo without
  the tier) caps it, least recently used out first, and ``PODCAST_DECODE_MEMO_SPILL_IDLE_S`` (default
  2700) drops it after that long without a hit. Where the spill is not allowed or fails, the entry is dropped.
* **Read-only**: with the memo on, every call returns samples that are read-only, whether the
  decode was stored, served, too big, racy or changed under the decode. Only the cap-0 path
  returns the build untouched.
* **Hits** return a fresh wrapper around a read-only view of the stored samples.
  ``PODCAST_VERDICT_VERIFY`` or ``PODCAST_EVIDENCE_VERIFY`` re-decodes the resolved path on every
  hit, outside any batch scope, and raises ``AssertionError`` unless the bits are equal.
"""

from __future__ import annotations

import dataclasses
import logging
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol, TypeVar, cast

import numpy as np

from podcast_mcp import settings
from podcast_mcp.engines.decoded_source import spill, spill_allowed
from podcast_mcp.engines.ungated_audio import ffmpeg_build_id
from podcast_mcp.util.batch_scope import unscoped
from podcast_mcp.util.fingerprint import FileStamp, file_stamp

CAP_ENV = "PODCAST_DECODE_MEMO_MB"
DEFAULT_CAP_MB = 768
VERIFY_ENVS = ("PODCAST_VERDICT_VERIFY", "PODCAST_EVIDENCE_VERIFY")
IDLE_ENV = "PODCAST_DECODE_MEMO_IDLE_S"
DEFAULT_IDLE_S = 90.0
MAX_IDLE_S = 86400.0
SPILL_ENV = "PODCAST_DECODE_MEMO_SPILL_MB"
DEFAULT_SPILL_MB = 1536
SPILL_IDLE_ENV = "PODCAST_DECODE_MEMO_SPILL_IDLE_S"
DEFAULT_SPILL_IDLE_S = 2700.0
MAX_SPILLED_ENTRIES = 64  # one descriptor each; bounds the fds the tier can hold
RACY_SECONDS = 2.0

_LOG = logging.getLogger(__name__)


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


def idle_seconds() -> float:
    """The idle time after which the memo releases; read live. ``0`` or less never releases.

    A value that is not finite is the default, as an unparsable one is; one above ``MAX_IDLE_S``
    is ``MAX_IDLE_S``, since a longer wait would overflow the timer.
    """
    seconds = settings.number(IDLE_ENV, DEFAULT_IDLE_S)
    return min(seconds, MAX_IDLE_S) if math.isfinite(seconds) else DEFAULT_IDLE_S


def spill_cap_bytes() -> int:
    """The disk cap of the spilled tier now in force; ``0`` keeps nothing. Not finite is the default."""
    megabytes = settings.number(SPILL_ENV, DEFAULT_SPILL_MB)
    if not math.isfinite(megabytes):
        megabytes = DEFAULT_SPILL_MB
    return max(0, int(megabytes * (1 << 20)))


def spill_idle_seconds() -> float:
    """The idle time after which the spilled tier is dropped; read live. ``0`` or less never drops.

    Clamped like :func:`idle_seconds`.
    """
    seconds = settings.number(SPILL_IDLE_ENV, DEFAULT_SPILL_IDLE_S)
    return min(seconds, MAX_IDLE_S) if math.isfinite(seconds) else DEFAULT_SPILL_IDLE_S


def _now_ns() -> int:
    return time.time_ns()


def _monotonic() -> float:
    return time.monotonic()


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
        # RAM-evicted entries awaiting a spill; mapped entries read from the spool.
        self._pending: OrderedDict[_Key, _Decoded] = OrderedDict()
        self._pending_bytes = 0
        self._spilling: set[_Key] = set()
        self._spilled: OrderedDict[_Key, _Decoded] = OrderedDict()
        self._spilled_bytes = 0
        self._worker_running = False
        self._timer_due = 0.0
        self._lock = threading.Lock()
        self._building: dict[_Key, _Flight] = {}
        self._timer: threading.Timer | None = None
        self._active = 0.0

    def get_or_decode(self, path: Path, sample_rate: int, build: Callable[[Path], T]) -> T:
        """``build(path)``, or a wrapper of the stored result for this file stamp and rate.

        On a memo path ``build`` receives the resolved path the key names. Except with the memo
        off, the samples returned are read-only on every path.
        """
        try:
            cap = cap_bytes()
        except Exception:
            cap = DEFAULT_CAP_MB << 20
        if cap == 0:
            return build(path)
        try:
            spill_cap = spill_cap_bytes()
        except Exception:
            spill_cap = 0
        try:
            resolved = path.resolve()
            stamp = file_stamp(resolved)
            key: _Key = (str(resolved), stamp, sample_rate, ffmpeg_build_id())
        except Exception:
            return _frozen(build(path))
        if _now_ns() - max(stamp.mtime_ns, stamp.ctime_ns) < RACY_SECONDS * 1e9:
            self._forget(key, keep=None)
            return _frozen(build(resolved))
        with self._lock:
            self._drop_other_builds(key[3])
            if spill_cap == 0 and self._spilled:
                for old in list(self._spilled):
                    self._remove(self._spilled, old)
            held = self._find(key)
            flight = None
            if held is None:
                flight = self._building.setdefault(key, _Flight())
                flight.users += 1
        if held is not None:
            return self._hit(held, resolved, build)
        assert flight is not None
        try:
            with flight.lock:
                with self._lock:
                    held = self._find(key)
                if held is not None:
                    return self._hit(held, resolved, build)
                return self._store(key, path, resolved, build(resolved), cap, spill_cap)
        finally:
            with self._lock:
                flight.users -= 1
                if flight.users == 0:
                    self._building.pop(key, None)

    def _hit(self, held: Any, resolved: Path, build: Callable[[Path], T]) -> T:
        if any(settings.flag(env) for env in VERIFY_ENVS):
            with unscoped():
                fresh = build(resolved)
            if not _same_bits(held.samples, fresh.samples):
                raise AssertionError("decode memo hit differs from a fresh decode of the file")
        return dataclasses.replace(held)

    def _store(
        self, key: _Key, path: Path, resolved: Path, built: T, cap: int, spill_cap: int
    ) -> T:
        try:
            unchanged = file_stamp(resolved) == key[1]
        except OSError:
            unchanged = False
        nbytes = int(built.samples.nbytes)
        if not unchanged or nbytes > cap:
            self._forget(key, keep=None)
            return _frozen(built)
        entry = _frozen(built)
        queued = False
        with self._lock:
            self._drop_older(key, keep=key)
            self._entries[key] = entry
            self._bytes += nbytes
            while self._bytes > cap:
                queued |= self._evict(next(iter(self._entries)), cap, spill_cap)
            self._touch()
            start = queued and not self._worker_running
        if start:
            self._start_worker()
        return dataclasses.replace(cast(Any, entry))

    def _forget(self, key: _Key, keep: _Key | None) -> None:
        with self._lock:
            self._drop_older(key, keep)

    def _drop_older(self, key: _Key, keep: _Key | None) -> None:
        for tier in (self._entries, self._pending, self._spilled):
            for old in [k for k in tier if k[0] == key[0] and k[2] == key[2] and k != keep]:
                self._remove(tier, old)

    def _drop_other_builds(self, build: tuple[object, ...]) -> None:
        """Drop what the tiers behind RAM hold for another ffmpeg build; the lock is held."""
        for tier in (self._pending, self._spilled):
            for old in [k for k in tier if k[3] != build]:
                self._remove(tier, old)

    def _remove(self, tier: OrderedDict[_Key, _Decoded], key: _Key) -> None:
        """Take ``key`` out of ``tier`` and its bytes off that tier's count; the lock is held."""
        nbytes = int(tier.pop(key).samples.nbytes)
        if tier is self._entries:
            self._bytes -= nbytes
        elif tier is self._pending:
            self._pending_bytes -= nbytes
        else:
            self._spilled_bytes -= nbytes

    def _find(self, key: _Key) -> Any | None:
        for tier in (self._entries, self._pending, self._spilled):
            entry = tier.get(key)
            if entry is not None:
                tier.move_to_end(key)
                self._touch()
                return entry
        return None

    def _evict(self, key: _Key, cap: int, spill_cap: int) -> bool:
        """Take ``key`` out of RAM, queued for a spill if one is worth it; the lock is held."""
        nbytes = int(self._entries[key].samples.nbytes)
        waiting = self._pending_bytes + nbytes
        if nbytes > spill_cap or waiting > min(spill_cap, cap // 2):
            self._remove(self._entries, key)
            return False
        entry = self._entries.pop(key)
        self._bytes -= nbytes
        self._pending[key] = entry
        self._pending_bytes = waiting
        return True

    def _touch(self) -> None:
        """Note activity and arm the idle timer if none is pending; the lock is held."""
        self._active = _monotonic()
        self._arm_for_remaining()

    def _deadlines(self) -> list[float]:
        """Seconds until each held tier is due; the lock is held. RAM waits ``idle``, the map longer."""
        elapsed = _monotonic() - self._active
        idle, spill_idle = idle_seconds(), spill_idle_seconds()
        due = []
        if self._entries and idle > 0:
            due.append(idle - elapsed)
        if self._spilled and spill_idle > 0:
            due.append(spill_idle - elapsed)
        return due

    def _period(self) -> float:
        """The shortest idle that is set at all, which is a positive delay to look again after."""
        return min((s for s in (idle_seconds(), spill_idle_seconds()) if s > 0), default=1.0)

    def _arm_for_remaining(self) -> None:
        """Make the timer fire at the earliest deadline; a later one is replaced, an earlier kept."""
        due = self._deadlines()
        if not due:
            return
        delay = max(min(due), 0.0) or self._period()
        if self._timer is not None:
            if _monotonic() + delay >= self._timer_due:
                return
            self._timer.cancel()
        self._arm(delay)

    def _arm(self, delay: float) -> None:
        timer = threading.Timer(delay, self._fire)
        timer.daemon = True
        self._timer = timer
        self._timer_due = _monotonic() + delay
        try:
            timer.start()
        except RuntimeError:
            self._timer = None

    def _fire(self) -> None:
        """The timer's callback; a timer that ``clear`` or a newer arm replaced does nothing."""
        with self._lock:
            if self._timer is not threading.current_thread():
                return
            demote = self._release_locked()
        if demote:
            self._demote_pending()

    def _release_if_idle(self) -> None:
        with self._lock:
            demote = self._release_locked()
        if demote:
            self._demote_pending()

    def _release_locked(self) -> bool:
        """Release what is idle long enough and nothing is decoding, else look again; lock held.

        Returns whether entries were queued for a spill, which the caller does outside the lock.
        """
        self._timer = None
        due = self._deadlines()
        if not due:
            return False
        remaining = min(due)
        if self._building or remaining > 0:
            self._arm(max(remaining, 0.0) or self._period())
            return False
        elapsed = _monotonic() - self._active
        spill_idle = spill_idle_seconds()
        if self._spilled and spill_idle > 0 and elapsed >= spill_idle:
            self._spilled.clear()
            self._spilled_bytes = 0
        queued = False
        idle = idle_seconds()
        if self._entries and idle > 0 and elapsed >= idle:
            if spill_cap_bytes() > 0:
                self._pending.update(self._entries)
                self._pending_bytes += self._bytes
                queued = True
            self._entries.clear()
            self._bytes = 0
        if not queued:
            self._arm_for_remaining()
        return queued

    def _start_worker(self) -> None:
        worker = threading.Thread(
            target=self._demote_pending, name="decode-memo-spill", daemon=True
        )
        try:
            worker.start()
        except RuntimeError:
            with self._lock:
                self._worker_running = False
                for key in [k for k in self._pending if k not in self._spilling]:
                    self._remove(self._pending, key)

    def _demote_pending(self) -> None:
        """Spill each queued entry outside the lock and swap it in if nothing dropped it meanwhile.

        One demoter at a time, so one spill is in flight and the free-space check is not raced; a
        caller that finds one running leaves its entries to it, which looks again before it stops.
        """
        with self._lock:
            if self._worker_running:
                return
            self._worker_running = True
        finished = False
        claimed: _Key | None = None
        try:
            while True:
                with self._lock:
                    item = next(
                        ((k, e) for k, e in self._pending.items() if k not in self._spilling), None
                    )
                    if item is None:
                        self._worker_running = False
                        finished = True
                        self._arm_for_remaining()
                        return
                    claimed = item[0]
                    self._spilling.add(claimed)
                key, entry = item
                mapped = self._spill_entry(key, entry)
                with self._lock:
                    self._spilling.discard(key)
                    claimed = None
                    if self._pending.get(key) is not entry:
                        continue  # dropped or replaced meanwhile
                    self._remove(self._pending, key)
                    if mapped is not None:
                        self._spilled[key] = mapped
                        self._spilled_bytes += int(mapped.samples.nbytes)
                        cap = spill_cap_bytes()
                        while self._spilled and (
                            self._spilled_bytes > cap or len(self._spilled) > MAX_SPILLED_ENTRIES
                        ):
                            self._remove(self._spilled, next(iter(self._spilled)))
                        self._arm_for_remaining()  # the demotion is not a use: the clock stays
        finally:
            if not finished:
                with self._lock:
                    self._worker_running = False
                    if claimed is not None:
                        self._spilling.discard(claimed)

    def _spill_entry(self, key: _Key, entry: _Decoded) -> _Decoded | None:
        """``entry`` with its samples mapped from the spool, or None to drop it. Never raises."""
        try:
            nbytes = int(entry.samples.nbytes)
            if (
                key[3] != ffmpeg_build_id()
                or nbytes > spill_cap_bytes()
                or not spill_allowed(nbytes)
            ):
                return None
            return dataclasses.replace(cast(Any, entry), samples=spill(entry.samples))
        except Exception as exc:
            _LOG.info("decode memo entry not kept: the spill failed (%s)", exc)
            return None

    def clear(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            for tier in (self._entries, self._pending, self._spilled):
                tier.clear()
            self._bytes = self._pending_bytes = self._spilled_bytes = 0

    def held_bytes(self) -> int:
        with self._lock:
            return self._bytes

    def spilled_bytes(self) -> int:
        with self._lock:
            return self._spilled_bytes

    def spilled_count(self) -> int:
        with self._lock:
            return len(self._spilled)

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


def _frozen(built: T) -> T:
    """``built`` with its samples a read-only view; the array itself is the caller's alone."""
    view = built.samples.view()
    view.flags.writeable = False
    return dataclasses.replace(cast(Any, built), samples=view)


_MEMO = DecodeMemo()


def decode_once(path: Path, sample_rate: int, build: Callable[[Path], T]) -> T:
    """``build(path)`` through the process memo; the one entry point for ``from_recording``."""
    return _MEMO.get_or_decode(path, sample_rate, build)
