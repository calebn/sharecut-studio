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
"""

from __future__ import annotations

import logging
import tempfile
import threading
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
from podcast_mcp.engines.audio_eval import common_rate, evaluate_resampled, single_layout
from podcast_mcp.engines.decoded_source import decoded_sources
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.level_profile import PROFILE_SAMPLE_RATE, LevelProfile, track_profile
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.batch_scope import scoped, unscoped
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hardware import cpu_budget
from podcast_mcp.util.parallel import run_parallel
from podcast_mcp.util.project_state import (
    FileRevision,
    file_revision,
    project_state_lock,
    snapshot_project,
)

_LOG = logging.getLogger(__name__)

EVIDENCE_CACHE_BYTES = 1 << 30
MAX_EVALUATORS = 4
VERIFY_ENV = "PODCAST_EVIDENCE_VERIFY"
RENDER_PREFIX = "sharecut-evidence-render-"
_STORE_KEY = "track_evidence_store"
JUMP_SAMPLE_RATE = 8000
WAVEFORM_SAMPLE_RATE = PROFILE_SAMPLE_RATE
_RATES = (JUMP_SAMPLE_RATE, WAVEFORM_SAMPLE_RATE)
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
    revisions: tuple[FileRevision, ...]


Evidence = dict[int, np.ndarray]


@dataclass
class _Entry:
    samples: Evidence
    _profiles: dict[int, LevelProfile] = field(default_factory=dict)

    @property
    def nbytes(self) -> int:
        return sum(array.nbytes for array in self.samples.values())

    def cache(self, rate: int) -> TrackRmsCache:
        if rate not in self._profiles:
            self._profiles[rate] = track_profile(self.samples[rate], rate)
        return TrackRmsCache(
            samples=self.samples[rate], sample_rate=rate, recording_profile=self._profiles[rate]
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
            entry = store.get_or_build(plan[0], lambda: _evaluate(plan[1], plan[0].curve))
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


def _build_or_error(store: _Store, key: EvidenceKey, tree: Audio) -> _Entry | Declined | Exception:
    try:
        return store.get_or_build(key, lambda: _evaluate(tree, key.curve))
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
    paths = {
        path for leaf in sources(tree) for path in (leaf.path, leaf.fill_path) if path is not None
    }
    try:
        revisions = tuple(file_revision(path) for path in sorted(paths))
    except OSError:
        return Declined.UNREADABLE
    return EvidenceKey(tree, curve, revisions), tree


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
    return _store().get_or_build(key, lambda: _evaluate(tree, key.curve))


class _Store:
    """Evidence for one batch. When the stored size passes ``EVIDENCE_CACHE_BYTES``, the store drops the least recently used entries first."""

    def __init__(self) -> None:
        self._entries: OrderedDict[EvidenceKey, _Entry] = OrderedDict()
        self._declined: dict[EvidenceKey, Declined] = {}
        self._bytes = 0
        self._lock = threading.Lock()
        self._building: dict[EvidenceKey, threading.Lock] = {}

    def get_or_build(
        self, key: EvidenceKey, build: Callable[[], Evidence | Declined]
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
        return scoped(_STORE_KEY, _Store)


def _verify(stored: _Entry, rebuilt: Evidence | Declined) -> None:
    """Raise AssertionError unless a rebuild of the key equals the stored evidence.

    The store calls this when ``PODCAST_EVIDENCE_VERIFY=1``.
    """
    if isinstance(rebuilt, Declined) or any(
        not np.array_equal(stored.samples[rate], array) for rate, array in rebuilt.items()
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
