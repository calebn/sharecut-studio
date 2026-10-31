"""Evidence for how a track sounds with the transcript gate off and the effects chain left out, evaluated from its tree and shared across a batch (#1958).

Cut approval reads a track as the listener would hear it with the transcript gate off and the
effects chain left out. Rendering that with ffmpeg and decoding the wav costs a minute for a
long episode, and every cut that leaves the track unchanged needs the same audio again.
:func:`heard` and :func:`rms` return that audio from the track's ``Audio`` tree
(:mod:`~podcast_mcp.engines.audio_eval`). They store it for the length of a batch under a key
that names everything the evaluator reads. A repeat call hits the store and a changed track
misses.

A track whose render adds a step after its tree (a volume envelope, bleed restore), or whose
tree the evaluator cannot take, still uses the render. The module logs the reason.

A batch ends and its store goes with it, yet the evidence propose built is the evidence the
check pass and Approve ask for. :class:`RetainedEvidence` keeps it for the life of the process
(#2359, see its docstring), as read-only maps of unlinked temp files, so what stays between
batches is disk that the kernel's page cache holds, not anonymous memory.
"""

from __future__ import annotations

import logging
import math
import os
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Collection, Iterator
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from enum import Enum
from functools import partial
from pathlib import Path

import numpy as np

from podcast_mcp import settings
from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines import timeline_render
from podcast_mcp.engines.audio import Audio, sources
from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.engines.audio_eval import (
    common_rate,
    evaluate_resampled,
    plan_audio,
    single_layout,
)
from podcast_mcp.engines.decode_memo import RACY_SECONDS
from podcast_mcp.engines.decoded_source import decoded_sources, spill, spill_allowed
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.level_profile import PROFILE_SAMPLE_RATE, LevelProfile, track_profile
from podcast_mcp.engines.ungated_audio import ffmpeg_build_id
from podcast_mcp.engines.windowed_rms import WindowedTrackRmsCache, resampled_window
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.batch_scope import shared_while_batching, unscoped
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.fingerprint import FileStamp, file_stamp
from podcast_mcp.util.hardware import cpu_budget
from podcast_mcp.util.parallel import run_parallel
from podcast_mcp.util.project_state import project_state_lock, snapshot_project

_LOG = logging.getLogger(__name__)

EVIDENCE_CACHE_BYTES = 1 << 30
MAX_EVALUATORS = 4
VERIFY_ENV = "PODCAST_EVIDENCE_VERIFY"
KEEP_ENV = "PODCAST_EVIDENCE_KEEP_MB"
DEFAULT_KEEP_MB = 3072
IDLE_ENV = "PODCAST_EVIDENCE_KEEP_IDLE_S"
DEFAULT_IDLE_S = 2700.0
MAX_IDLE_S = 86400.0
MAX_DECLINED = 256
RENDER_PREFIX = "sharecut-evidence-render-"
_STORE_KEY = "track_evidence_store"
JUMP_SAMPLE_RATE = 8000
WAVEFORM_SAMPLE_RATE = PROFILE_SAMPLE_RATE
_RATES = (JUMP_SAMPLE_RATE, WAVEFORM_SAMPLE_RATE)
# 8 kHz samples a window holds beyond the seconds asked: the readers round each end to a sample.
_WINDOW_SLACK = 4
_store_creation = threading.Lock()


class Declined(Enum):
    """Why a track's evidence comes from the render.

    ``empty``, ``envelope`` and ``bleed_restore`` are what ``timeline_render`` reports.
    """

    EMPTY = "empty"
    ENVELOPE = "envelope"
    BLEED_RESTORE = "bleed_restore"
    MIXED_LAYOUT = "mixed_layout"
    MIXED_RATE = "mixed_rate"
    EVALUATOR = "evaluator"
    UNREADABLE = "unreadable"


@dataclass(frozen=True)
class EvidenceKey:
    """Everything the evaluator reads: two equal keys evaluate to the same samples."""

    tree: Audio
    curve: str
    revisions: tuple[FileStamp, ...]


Evidence = dict[int, np.ndarray]


@dataclass
class _Entry:
    samples: Evidence
    _profiles: dict[int, LevelProfile] = field(default_factory=dict)
    _profiles_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def nbytes(self) -> int:
        return sum(array.nbytes for array in self.samples.values())

    def cache(self, rate: int) -> TrackRmsCache:
        with self._profiles_lock:
            if rate not in self._profiles:
                self._profiles[rate] = track_profile(self.samples[rate], rate)
            profile = self._profiles[rate]
        return TrackRmsCache(
            samples=self.samples[rate], sample_rate=rate, recording_profile=profile
        )


@dataclass(frozen=True)
class HeardAudio:
    """A track as heard at both evidence resolutions: ``edits.audio_cache.TrackAudioCache``'s fields."""

    jump: TrackRmsCache
    waveform: TrackRmsCache


def heard(project: EpisodeProject, track_id: str, defaults: EffectiveConfig) -> HeardAudio:
    """Return the track as heard, with the transcript gate off and the effects chain left out, at both evidence resolutions."""
    entry = _entry(project, track_id, defaults, locked=False)
    if isinstance(entry, Declined):
        with _rendered(project, track_id, defaults, entry, locked=False) as path, unscoped():
            return HeardAudio(
                jump=TrackRmsCache.from_timeline_stem(path, sample_rate=JUMP_SAMPLE_RATE),
                waveform=TrackRmsCache.from_timeline_stem(path, sample_rate=WAVEFORM_SAMPLE_RATE),
            )
    return HeardAudio(
        jump=entry.cache(JUMP_SAMPLE_RATE), waveform=entry.cache(WAVEFORM_SAMPLE_RATE)
    )


def rms(
    project: EpisodeProject, track_id: str, defaults: EffectiveConfig, *, private: bool = False
) -> TrackRmsCache:
    """Return the track as heard, with the transcript gate off and the effects chain left out, for window reads at 8 kHz.

    Pass ``private=True`` when ``project`` is a copy that only the caller holds. Reading it
    then takes no project lock, because a pool worker inside a mutation does not own that
    lock (#1471).
    """
    entry = _entry(project, track_id, defaults, locked=not private)
    if isinstance(entry, Declined):
        with _rendered(project, track_id, defaults, entry, locked=not private) as path, unscoped():
            return TrackRmsCache.from_timeline_stem(path)
    return entry.cache(JUMP_SAMPLE_RATE)


def rms_readers(
    project: EpisodeProject,
    track_ids: Collection[str],
    defaults: EffectiveConfig,
    *,
    private: bool = False,
) -> dict[str, Callable[[], TrackRmsCache]]:
    """Return a reader per track that gives what :func:`rms` gives, with the missing trees already evaluated together.

    A reader raises what :func:`rms` would raise for its track, so the caller keeps its per-track fallback.
    """
    store = _store()
    planned: dict[str, tuple[EvidenceKey, Audio] | Declined | Exception] = {}
    for track_id in dict.fromkeys(track_ids):
        try:
            with project_state_lock(project) if not private else nullcontext():
                planned[track_id] = _plan(project, track_id, defaults)
        except Exception as exc:
            planned[track_id] = exc
    missing: dict[EvidenceKey, Audio] = {}
    for plan in planned.values():
        if isinstance(plan, tuple) and plan[0] not in missing and not store.holds(plan[0]):
            missing[plan[0]] = plan[1]
    evaluated: dict[EvidenceKey, _Entry | Declined | Exception] = {}
    if len(missing) > 1:
        keys = list(missing)
        results = run_parallel(
            keys,
            lambda key: _build_or_error(store, key, missing[key]),
            max_workers=min(len(keys), MAX_EVALUATORS, cpu_budget()),
        )
        evaluated = dict(zip(keys, results, strict=True))

    def read(track_id: str) -> TrackRmsCache:
        plan = planned[track_id]
        if isinstance(plan, Exception):
            raise plan
        entry: _Entry | Declined | Exception
        if isinstance(plan, Declined):
            entry = plan
        elif plan[0] in evaluated:
            entry = evaluated[plan[0]]
        else:
            entry = store.get_or_build(plan[0], partial(_produce, plan[0], plan[1]))
        if isinstance(entry, Exception):
            raise entry
        if isinstance(entry, Declined):
            with (
                _rendered(project, track_id, defaults, entry, locked=not private) as path,
                unscoped(),
            ):
                return TrackRmsCache.from_timeline_stem(path)
        return entry.cache(JUMP_SAMPLE_RATE)

    return {track_id: partial(read, track_id) for track_id in planned}


@dataclass(frozen=True)
class WindowPlan:
    """What :func:`plan_window` settled on the calling thread for :func:`build_window` to read."""

    project: EpisodeProject
    track_id: str
    defaults: EffectiveConfig
    private: bool
    key: EvidenceKey
    tree: Audio
    rate: int

    def verify(self, window: WindowedTrackRmsCache) -> None:
        """With ``PODCAST_EVIDENCE_VERIFY=1``, raise ``AssertionError`` unless the window is the
        whole track's evidence over its range."""
        if settings.flag(VERIFY_ENV):
            whole = _entry(self.project, self.track_id, self.defaults, locked=not self.private)
            _verify_window(window, whole)


def plan_window(
    project: EpisodeProject,
    track_id: str,
    defaults: EffectiveConfig,
    *,
    private: bool = False,
) -> WindowPlan | None:
    """What the project says about the track's window; ``None`` when the whole track serves.

    ``None`` when the evaluator declines its tree, its sources are not at one rate and layout,
    the resampler is not local at that rate (``resampler_locality``), or the store already holds
    the whole track. Takes ``project_state_lock``, so it runs on the thread that may already
    hold it, never in a pool worker. :func:`build_window` reads only the plan.
    """
    with project_state_lock(project) if not private else nullcontext():
        planned = _plan(project, track_id, defaults)
    if isinstance(planned, Declined):
        return None
    key, tree = planned
    if _store().holds(key) or not single_layout(tree):
        return None
    rate = common_rate(tree)
    if rate is None:
        return None
    return WindowPlan(project, track_id, defaults, private, key, tree, rate)


def build_window(
    plan: WindowPlan, start_sec: float, end_sec: float, *, profile: LevelProfile
) -> WindowedTrackRmsCache | None:
    """The track as :func:`rms` gives it, held only over timeline ``[start_sec, end_sec]`` (#2357).

    A read inside the window returns the samples :func:`rms` returns, bit for bit; a read outside
    raises ``WindowMiss``. The cache reports ``profile`` (the batch's base profile) because the
    profile of the whole track cannot be had from a window. The window is built from the
    planned tree and is not stored: the store's keys name whole tracks. ``None`` when the tree
    evaluates to nothing. Reads only ``plan``, so it is safe in a pool worker: it takes no
    project lock and calls neither ``scoped`` nor ``frozen``. :meth:`WindowPlan.verify` makes the
    ``PODCAST_EVIDENCE_VERIFY=1`` comparison, on the calling thread.
    """
    rate = plan.rate
    with decoded_sources(rate) as reader:
        piece = plan_audio(
            plan.tree, crossfade_curve=plan.key.curve, reader=reader, sample_rate=rate
        )
        if piece is None or piece.size == 0:
            return None
        first = max(0, math.floor(start_sec * JUMP_SAMPLE_RATE) - _WINDOW_SLACK)
        last = math.ceil(end_sec * JUMP_SAMPLE_RATE) + _WINDOW_SLACK
        found = resampled_window(piece, rate, JUMP_SAMPLE_RATE, first, last)
    if found is None or found[2] == 0:
        return None
    window, first, total = found
    return WindowedTrackRmsCache(
        window,
        first_index=first,
        total_size=total,
        sample_rate=JUMP_SAMPLE_RATE,
        profile=profile,
    )


def _verify_window(window: WindowedTrackRmsCache, whole: _Entry | Declined) -> None:
    """Raise AssertionError unless the window is the whole-track evidence over its range."""
    if isinstance(whole, Declined):
        raise AssertionError("a window was built for a track whose evidence is the render")
    samples = whole.samples[JUMP_SAMPLE_RATE]
    first, last = window.coverage
    if samples.size != window.total_size or not np.array_equal(
        samples[first:last].view(np.uint32), window.held.view(np.uint32)
    ):
        raise AssertionError("a window differs from the whole-track evidence over its range")


def _build_or_error(store: _Store, key: EvidenceKey, tree: Audio) -> _Entry | Declined | Exception:
    try:
        return store.get_or_build(key, partial(_produce, key, tree))
    except Exception as exc:
        return exc


def _plan(
    project: EpisodeProject, track_id: str, defaults: EffectiveConfig
) -> tuple[EvidenceKey, Audio] | Declined:
    """Return the track's tree and its key, or the reason its evidence needs the render."""
    track = project.track_by_id(track_id)
    if track is None:
        raise CodedValueError(
            f"track {track_id!r} is unavailable. Add media to that track first.",
            code="track_has_no_media",
        )
    plain = timeline_render.unfiltered_track_audio(project, track, defaults)
    if plain is None:
        reason = timeline_render.unfiltered_audio_decline(project, track)
        assert reason is not None
        return Declined(reason)
    tree, curve = plain
    try:
        revisions = _stamps(tree)
    except OSError:
        return Declined.UNREADABLE
    return EvidenceKey(tree, curve, revisions), tree


def _stamps(tree: Audio) -> tuple[FileStamp, ...]:
    """The stamp of every file the tree reads, in path order: the key's ``revisions``."""
    paths = {
        path for leaf in sources(tree) for path in (leaf.path, leaf.fill_path) if path is not None
    }
    return tuple(file_stamp(path) for path in sorted(paths))


def _evaluate(tree: Audio, curve: str) -> Evidence | Declined:
    """Evaluate ``tree`` in one pass and return its samples at both evidence rates, or the reason the evaluator cannot take it.

    The evaluator works in chunks at the sources' own rate and converts once per rate, as
    decoding the render's wav does. Slices start between samples, so slicing a decode at the
    target rate would shift every cut by a fraction of a sample.
    """
    if not single_layout(tree):
        return Declined.MIXED_LAYOUT
    rate = common_rate(tree)
    if rate is None:
        return Declined.MIXED_RATE
    with decoded_sources(rate) as reader:
        samples = evaluate_resampled(
            tree,
            crossfade_curve=curve,
            reader=reader,
            sample_rate=rate,
            target_rates=_RATES,
            resample=FFmpegEngine.resample_streams,
        )
    if samples is None or not all(array.size for array in samples.values()):
        return Declined.EVALUATOR
    return samples


def _entry(
    project: EpisodeProject, track_id: str, defaults: EffectiveConfig, *, locked: bool
) -> _Entry | Declined:
    with project_state_lock(project) if locked else nullcontext():
        planned = _plan(project, track_id, defaults)
    if isinstance(planned, Declined):
        return planned
    key, tree = planned
    return _store().get_or_build(key, partial(_produce, key, tree))


class _Store:
    """Evidence for the batches running now, shared between them. When the stored size passes ``EVIDENCE_CACHE_BYTES``, the store drops the least recently used entries first."""

    def __init__(self) -> None:
        self._entries: OrderedDict[EvidenceKey, _Entry] = OrderedDict()
        self._declined: dict[EvidenceKey, Declined] = {}
        self._bytes = 0
        self._lock = threading.Lock()
        self._building: dict[EvidenceKey, threading.Lock] = {}

    def get_or_build(
        self, key: EvidenceKey, build: Callable[[], Evidence | Declined | _Entry]
    ) -> _Entry | Declined:
        with self._lock:
            known = self._find(key)
            builder = (
                None if known is not None else self._building.setdefault(key, threading.Lock())
            )
        if known is not None:
            if isinstance(known, _Entry) and settings.flag(VERIFY_ENV):
                _verify(known, build())
            return known
        assert builder is not None
        with builder:
            try:
                with self._lock:
                    known = self._find(key)
                if known is not None:
                    return known
                built = build()
                if isinstance(built, Declined):
                    with self._lock:
                        self._declined[key] = built
                    return built
                if isinstance(built, _Entry):
                    entry = built
                else:
                    for array in built.values():
                        array.flags.writeable = False
                    entry = _Entry(built)
                self._put(key, entry)
                return entry
            finally:
                with self._lock:
                    self._building.pop(key, None)

    def holds(self, key: EvidenceKey) -> bool:
        with self._lock:
            return key in self._entries or key in self._declined

    def _find(self, key: EvidenceKey) -> _Entry | Declined | None:
        entry = self._entries.get(key)
        if entry is not None:
            self._entries.move_to_end(key)
            return entry
        return self._declined.get(key)

    def _put(self, key: EvidenceKey, entry: _Entry) -> None:
        with self._lock:
            if entry.nbytes > EVIDENCE_CACHE_BYTES:
                return
            self._entries[key] = entry
            self._bytes += entry.nbytes
            while self._bytes > EVIDENCE_CACHE_BYTES:
                _, oldest = self._entries.popitem(last=False)
                self._bytes -= oldest.nbytes


def _store() -> _Store:
    with _store_creation:
        return shared_while_batching(_STORE_KEY, _Store)


def keep_bytes() -> int:
    """The disk cap on retained evidence now in force; read live. ``0`` (or less) keeps nothing.

    A value that is not finite is the default, as an unparsable one is.
    """
    megabytes = settings.number(KEEP_ENV, DEFAULT_KEEP_MB)
    if not math.isfinite(megabytes):
        megabytes = DEFAULT_KEEP_MB
    return max(0, int(megabytes * (1 << 20)))


def idle_seconds() -> float:
    """The idle time after which retained evidence is released; read live. ``0`` or less never releases.

    A value that is not finite is the default; one above ``MAX_IDLE_S`` is ``MAX_IDLE_S``, since a longer wait would overflow the timer.
    """
    seconds = settings.number(IDLE_ENV, DEFAULT_IDLE_S)
    return min(seconds, MAX_IDLE_S) if math.isfinite(seconds) else DEFAULT_IDLE_S


def _now_ns() -> int:
    return time.time_ns()


def _monotonic() -> float:
    return time.monotonic()


def _produce(key: EvidenceKey, tree: Audio) -> Evidence | Declined | _Entry:
    """What a batch store builds a missing key from: the retained evidence, or a fresh evaluation."""
    return _RETAINED.get_or_build(key, tree, lambda: _evaluate(tree, key.curve))


class RetainedEvidence:
    """Evidence kept between batches, as read-only maps of unlinked temp files (#2359).

    Propose builds the whole-track evidence that the check pass and Approve ask for again
    minutes later, in batches of their own. A batch store is the front of every read, as it
    always was; on a miss it asks this one before evaluating. So what a batch holds, and which
    reads take a window, are what they were without retention.

    * **Spill, not RAM**: a built entry is written to the spool directory
      (:func:`~podcast_mcp.engines.decoded_source.spill`) and served as read-only arrays over a
      map of it. Nothing anonymous stays resident while idle; the kernel reclaims the mapped
      pages under pressure and reads them back. The bits are the evaluator's float32, verbatim.
    * **Key**: the tree, the curve and the full stamp of every source (``ctime`` included),
      plus a guard on the ffmpeg build: the entries are dropped when a build resolves a
      different binary. A hit resolves nothing.
    * **No stale keep**: an entry is kept only if every source still has the stamp the key
      names after the build, and none was modified within ``RACY_SECONDS``. Otherwise the
      caller gets the build and the store keeps nothing.
    * **Cap**: ``PODCAST_EVIDENCE_KEEP_MB`` (default 3072) of disk, least recently used out
      first; ``0`` keeps nothing and every read is the batch store's alone. The cap is soft
      while views are held: eviction and release drop the store's references, and a map is
      freed with the last array over it, so a reader that still holds one stays valid.
    * **Fallbacks**: no retention on Windows, on a RAM-backed temp directory or with less than
      2 GiB to spare; a failed spill (a full disk) hands the caller the RAM arrays and keeps
      nothing. A dropped entry is evaluated again, to the same bits.
    * **Idle release**: ``PODCAST_EVIDENCE_KEEP_IDLE_S`` (default 2700) seconds with no
      hit or store and no build in flight, and the store drops everything, as
      ``DecodeMemo`` does. A daemon timer, armed only while the store holds an entry or a decline.
    * **Declined** trees are remembered too, up to ``MAX_DECLINED``, first in first out.
    * **Verify**: with ``PODCAST_EVIDENCE_VERIFY=1`` each hit evaluates the tree again and
      fails unless it equals the mapped arrays bit for bit.
    """

    def __init__(self) -> None:
        self._entries: OrderedDict[EvidenceKey, _Entry] = OrderedDict()
        self._declined: OrderedDict[EvidenceKey, Declined] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()
        self._building: dict[EvidenceKey, threading.Lock] = {}
        self._timer: threading.Timer | None = None
        self._active = 0.0
        self._ffmpeg: tuple[object, ...] | None = None

    def get_or_build(
        self, key: EvidenceKey, tree: Audio, build: Callable[[], Evidence | Declined]
    ) -> Evidence | Declined | _Entry:
        """The kept evidence of ``key``, else ``build()``, kept when that is exact and fits."""
        cap = keep_bytes()
        if cap == 0 or os.name == "nt":
            self.clear()
            return build()
        with self._lock:
            known = self._find(key)
            builder = (
                None if known is not None else self._building.setdefault(key, threading.Lock())
            )
        if known is not None:
            return self._hit(known, build)
        assert builder is not None
        with builder:
            try:
                with self._lock:
                    known = self._find(key)
                if known is not None:
                    return self._hit(known, build)
                return self._keep(key, tree, build, cap)
            finally:
                with self._lock:
                    self._building.pop(key, None)

    def _hit(
        self, known: _Entry | Declined, build: Callable[[], Evidence | Declined]
    ) -> _Entry | Declined:
        if isinstance(known, _Entry) and settings.flag(VERIFY_ENV):
            _verify(known, build())
        return known

    def _keep(
        self, key: EvidenceKey, tree: Audio, build: Callable[[], Evidence | Declined], cap: int
    ) -> Evidence | Declined | _Entry:
        try:
            build_id: tuple[object, ...] | None = ffmpeg_build_id()
        except Exception:
            build_id = None
        with self._lock:
            if build_id is not None and self._ffmpeg not in (None, build_id):
                self._drop_all()
            self._ffmpeg = build_id or self._ffmpeg
        built = build()
        if build_id is None or not self._unchanged(key, tree):
            return built
        if isinstance(built, Declined):
            with self._lock:
                self._declined[key] = built
                while len(self._declined) > MAX_DECLINED:
                    self._declined.popitem(last=False)
            return built
        size = sum(array.nbytes for array in built.values())
        if size > cap or not spill_allowed(size):
            return built
        try:
            entry = _Entry({rate: spill(array) for rate, array in built.items()})
        except Exception as exc:
            _LOG.info("evidence not retained: the spill failed (%s)", exc)
            return built
        with self._lock:
            self._entries[key] = entry
            self._bytes += entry.nbytes
            while self._bytes > cap and len(self._entries) > 1:
                _, oldest = self._entries.popitem(last=False)
                self._bytes -= oldest.nbytes
            self._touch()
        return entry

    @staticmethod
    def _unchanged(key: EvidenceKey, tree: Audio) -> bool:
        """Whether every source has the stamp the key names and none is recent enough to share it with a rewrite."""
        try:
            now = _now_ns()
            stamps = _stamps(tree)
        except OSError:
            return False
        return stamps == key.revisions and all(
            now - max(stamp.mtime_ns, stamp.ctime_ns) >= RACY_SECONDS * 1e9 for stamp in stamps
        )

    def _find(self, key: EvidenceKey) -> _Entry | Declined | None:
        found: _Entry | Declined | None = self._entries.get(key)
        if found is not None:
            self._entries.move_to_end(key)
        else:
            found = self._declined.get(key)
        if found is not None:
            self._touch()
        return found

    def _touch(self) -> None:
        """Note activity and arm the idle timer if none is pending; the lock is held."""
        self._active = _monotonic()
        idle = idle_seconds()
        if self._timer is None and (self._entries or self._declined) and idle > 0:
            self._arm(idle)

    def _arm(self, delay: float) -> None:
        timer = threading.Timer(delay, self._fire)
        timer.daemon = True
        self._timer = timer
        try:
            timer.start()
        except RuntimeError:
            self._timer = None

    def _fire(self) -> None:
        """The timer's callback; a timer that ``clear`` or a newer arm replaced does nothing."""
        with self._lock:
            if self._timer is threading.current_thread():
                self._release_locked()

    def _release_if_idle(self) -> None:
        with self._lock:
            self._release_locked()

    def _release_locked(self) -> None:
        """Drop everything if idle long enough and nothing is building, else look again; the lock is held."""
        self._timer = None
        idle = idle_seconds()
        if not (self._entries or self._declined) or idle <= 0:
            return
        remaining = idle - (_monotonic() - self._active)
        if self._building or remaining > 0:
            self._arm(max(remaining, 0.0) or idle)
            return
        self._drop_all()

    def _drop_all(self) -> None:
        self._entries.clear()
        self._declined.clear()
        self._bytes = 0

    def clear(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._drop_all()

    def held_bytes(self) -> int:
        with self._lock:
            return self._bytes

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


_RETAINED = RetainedEvidence()


def _verify(stored: _Entry, rebuilt: Evidence | Declined | _Entry) -> None:
    """Raise AssertionError unless a rebuild of the key equals the stored evidence, bit for bit.

    The store calls this when ``PODCAST_EVIDENCE_VERIFY=1``.
    """
    if isinstance(rebuilt, _Entry):
        rebuilt = rebuilt.samples
    if isinstance(rebuilt, Declined) or any(
        stored.samples[rate].shape != array.shape
        or not np.array_equal(stored.samples[rate].view(np.uint32), array.view(np.uint32))
        for rate, array in rebuilt.items()
    ):
        raise AssertionError("stored evidence differs from a rebuild of its key")


@contextmanager
def _rendered(
    project: EpisodeProject,
    track_id: str,
    defaults: EffectiveConfig,
    why: Declined,
    *,
    locked: bool,
) -> Iterator[Path]:
    """Yield the path of the track's render, made with the gate off and the chain left out.

    The file exists only while the block runs.
    """
    _LOG.info("track %s evidence: ffmpeg render (%s)", track_id, why.value)
    snapshot = snapshot_project(project) if locked else project.model_copy(deep=True)
    track = snapshot.track_by_id(track_id)
    if track is None:
        raise CodedValueError(
            f"track {track_id!r} is unavailable. Add media to that track first.",
            code="track_has_no_media",
        )
    track.transcript_gate = False
    snapshot.processing_chains = [c for c in snapshot.processing_chains if c.track_id != track_id]
    with tempfile.TemporaryDirectory(prefix=RENDER_PREFIX) as directory:
        path = Path(directory) / "evidence.wav"
        timeline_render.render_track_from_timeline(snapshot, track, path, defaults)
        yield path
