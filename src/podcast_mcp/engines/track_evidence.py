"""The audio a track is heard as, evaluated from its tree and shared across a batch (#1958).

Cut approval reads a track as the listener would hear it with the transcript gate off and the
effects chain left out. Rendering that with ffmpeg and decoding the wav costs a minute for a
long episode, and the same audio is wanted again for every cut that leaves the track as it
was. :func:`heard` and :func:`rms` return that audio from the track's ``Audio`` tree
(:mod:`~podcast_mcp.engines.audio_eval`), and keep it while a batch runs under a key that
names everything the evaluator reads, so a repeat is a hit and a changed track is a miss.

A track whose render adds a step after its tree (a volume envelope, bleed restore) or whose
tree the evaluator does not take keeps the render, and the reason is logged.
"""

from __future__ import annotations

import logging
import tempfile
import threading
from collections import OrderedDict
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

import numpy as np

from podcast_mcp import settings
from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines import timeline_render
from podcast_mcp.engines.audio import Audio, MaskAudio, postorder, sources
from podcast_mcp.engines.audio_audit import TrackRmsCache, TrackRmsCacheSet
from podcast_mcp.engines.audio_eval import common_rate, evaluate_resampled, single_layout
from podcast_mcp.engines.decoded_source import decoded_sources
from podcast_mcp.engines.level_profile import PROFILE_SAMPLE_RATE, LevelProfile, track_profile
from podcast_mcp.engines.ungated_audio import resample_streams
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.batch_scope import scoped, unscoped
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.project_state import (
    FileRevision,
    file_revision,
    project_state_lock,
    snapshot_project,
)

_LOG = logging.getLogger(__name__)

# What the store keeps while a batch runs, as a hard bound (one hour of one track is 115 MB at
# 8 kHz and 230 MB at 16 kHz). Settable.
EVIDENCE_CACHE_BYTES = 1 << 30
VERIFY_ENV = "SHARECUT_EVIDENCE_VERIFY"
RENDER_PREFIX = "sharecut-evidence-render-"
_STORE_KEY = "track_evidence_store"
# The rates of edits.audio_cache.TrackAudioCache: window RMS reads, and waveform scoring.
JUMP_SAMPLE_RATE = 8000
WAVEFORM_SAMPLE_RATE = PROFILE_SAMPLE_RATE
_HEARD_RATES = (JUMP_SAMPLE_RATE, WAVEFORM_SAMPLE_RATE)
_RMS_RATES = (JUMP_SAMPLE_RATE,)


class Declined(Enum):
    """Why a track's evidence comes from the render. The value is what the log says."""

    EMPTY = "empty"
    ENVELOPE = "envelope"
    BLEED_RESTORE = "bleed_restore"
    MASK = "mask"
    MIXED_LAYOUT = "mixed_layout"
    MIXED_RATE = "mixed_rate"
    EVALUATOR = "evaluator"
    UNREADABLE = "unreadable"


@dataclass(frozen=True)
class EvidenceKey:
    """Everything the evaluator reads: two equal keys evaluate to the same samples.

    ``tree`` is the whole of the evaluator's input except the audio files, which
    ``revisions`` names; ``curve`` is the one ``defaults`` value the tree is read with.
    """

    tree: Audio
    curve: str
    rates: tuple[int, ...]
    revisions: tuple[FileRevision, ...]


Evidence = dict[int, np.ndarray]


@dataclass
class _Entry:
    samples: Evidence
    tree: Audio  # what the samples are of, for a later diff against a changed tree
    _profiles: dict[int, LevelProfile] = field(default_factory=dict)

    @property
    def nbytes(self) -> int:
        return sum(array.nbytes for array in self.samples.values())

    def profile(self, rate: int) -> LevelProfile:
        if rate not in self._profiles:
            self._profiles[rate] = track_profile(self.samples[rate], rate)
        return self._profiles[rate]


@dataclass(frozen=True)
class HeardAudio:
    """A track as heard at both evidence resolutions: ``edits.audio_cache.TrackAudioCache``'s fields.

    ``engines`` sits below ``edits``, so the caller builds its ``TrackAudioCache`` from these.
    """

    jump: TrackRmsCache
    waveform: TrackRmsCache


def heard(project: EpisodeProject, track_id: str, defaults: EffectiveConfig) -> HeardAudio:
    """The track as heard (gate off, effects chain left out) at both evidence resolutions."""
    entry = _entry(project, track_id, defaults, _HEARD_RATES, locked=False)
    if isinstance(entry, Declined):
        with _rendered(project, track_id, defaults, entry, locked=False) as path:
            return HeardAudio(
                jump=TrackRmsCache.from_timeline_stem(path, sample_rate=JUMP_SAMPLE_RATE),
                waveform=TrackRmsCache.from_timeline_stem(path, sample_rate=WAVEFORM_SAMPLE_RATE),
            )
    return HeardAudio(
        jump=TrackRmsCache(samples=entry.samples[JUMP_SAMPLE_RATE], sample_rate=JUMP_SAMPLE_RATE),
        waveform=TrackRmsCache(
            samples=entry.samples[WAVEFORM_SAMPLE_RATE], sample_rate=WAVEFORM_SAMPLE_RATE
        ),
    )


def rms(
    project: EpisodeProject, track_id: str, defaults: EffectiveConfig, *, private: bool = False
) -> TrackRmsCache:
    """The track as heard (gate off, effects chain left out) for window reads at 8 kHz.

    ``private`` says ``project`` is a copy only the caller holds, so reading it takes no
    project lock: a pool worker inside a mutation does not own the lock (#1471).
    """
    entry = _entry(project, track_id, defaults, _RMS_RATES, locked=not private)
    if isinstance(entry, Declined):
        with _rendered(project, track_id, defaults, entry, locked=not private) as path:
            return TrackRmsCache.from_timeline_stem(path)
    return TrackRmsCache(
        samples=entry.samples[JUMP_SAMPLE_RATE],
        recording_profile=entry.profile(JUMP_SAMPLE_RATE),
    )


def _plan(
    project: EpisodeProject, track_id: str, defaults: EffectiveConfig, rates: tuple[int, ...]
) -> tuple[EvidenceKey, Audio] | Declined:
    """The track's tree with its key, or why its evidence needs the render."""
    track = project.track_by_id(track_id)
    if track is None:
        raise CodedValueError(
            f"track {track_id!r} is unavailable. Add media to that track first.",
            code="track_has_no_media",
        )
    reason = timeline_render.unfiltered_audio_decline(project, track, bare=True)
    if reason is not None:
        return Declined(reason)
    plain = timeline_render.unfiltered_track_audio(project, track, defaults, bare=True)
    assert plain is not None
    tree, curve = plain
    paths = {
        path for leaf in sources(tree) for path in (leaf.path, leaf.fill_path) if path is not None
    }
    try:
        revisions = tuple(file_revision(path) for path in sorted(paths))
    except OSError:
        return Declined.UNREADABLE
    return EvidenceKey(tree, curve, rates, revisions), tree


def _evaluate(tree: Audio, curve: str, rates: tuple[int, ...]) -> Evidence | Declined:
    """``tree`` at each of ``rates`` from one pass over it, or why the evaluator takes it not.

    The tree is evaluated at the sources' own rate, in chunks, and converted once per rate as
    decoding the render's wav is: slices start between samples, and slicing a decode at the
    target rate instead would shift every cut by a fraction of a sample.
    """
    if any(isinstance(node, MaskAudio) for node in postorder(tree)):
        return Declined.MASK
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
            target_rates=rates,
            resample=resample_streams,
        )
    if samples is None or not all(array.size for array in samples.values()):
        return Declined.EVALUATOR
    return samples


def _entry(
    project: EpisodeProject,
    track_id: str,
    defaults: EffectiveConfig,
    rates: tuple[int, ...],
    *,
    locked: bool,
) -> _Entry | Declined:
    with project_state_lock(project) if locked else nullcontext():
        planned = _plan(project, track_id, defaults, rates)
    if isinstance(planned, Declined):
        return planned
    key, tree = planned
    # Evidence at both rates holds the 8 kHz array any caller asks for.
    wider = [_with_rates(key, _HEARD_RATES)] if rates == _RMS_RATES else []
    return _store().get_or_build(key, lambda: _evaluate(tree, key.curve, key.rates), also=wider)


def _evidence(
    project: EpisodeProject, track_id: str, defaults: EffectiveConfig, rates: tuple[int, ...]
) -> Evidence | Declined:
    entry = _entry(project, track_id, defaults, rates, locked=False)
    return entry if isinstance(entry, Declined) else entry.samples


def _with_rates(key: EvidenceKey, rates: tuple[int, ...]) -> EvidenceKey:
    return EvidenceKey(key.tree, key.curve, rates, key.revisions)


class _Store:
    """The batch's evidence, least recently used out first once past ``EVIDENCE_CACHE_BYTES``."""

    def __init__(self) -> None:
        self._entries: OrderedDict[EvidenceKey, _Entry] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()
        self._building: dict[EvidenceKey, threading.Lock] = {}

    def get_or_build(
        self,
        key: EvidenceKey,
        build: Callable[[], Evidence | Declined],
        *,
        also: Iterable[EvidenceKey] = (),
    ) -> _Entry | Declined:
        with self._lock:
            hit = self._find(key, also)
            builder = None if hit is not None else self._building.setdefault(key, threading.Lock())
        if hit is not None:
            if settings.flag(VERIFY_ENV):
                _verify(key, hit, build())
            return hit
        assert builder is not None
        with builder:
            with self._lock:
                hit = self._find(key, also)
            if hit is not None:
                return hit
            built = build()
            if isinstance(built, Declined):
                return built
            for array in built.values():
                array.flags.writeable = False
            entry = _Entry(built, key.tree)
            self._put(key, entry)
            return entry

    def _find(self, key: EvidenceKey, also: Iterable[EvidenceKey]) -> _Entry | None:
        for candidate in (key, *also):
            entry = self._entries.get(candidate)
            if entry is not None:
                self._entries.move_to_end(candidate)
                return entry
        return None

    def _put(self, key: EvidenceKey, entry: _Entry) -> None:
        with self._lock:
            self._building.pop(key, None)
            if entry.nbytes > EVIDENCE_CACHE_BYTES:
                return
            self._entries[key] = entry
            self._bytes += entry.nbytes
            while self._bytes > EVIDENCE_CACHE_BYTES:
                _, oldest = self._entries.popitem(last=False)
                self._bytes -= oldest.nbytes


def _store() -> _Store:
    return scoped(_STORE_KEY, _Store)


def _verify(key: EvidenceKey, stored: _Entry, rebuilt: Evidence | Declined) -> None:
    """Fail unless a rebuild is the stored evidence (``SHARECUT_EVIDENCE_VERIFY=1``)."""
    if isinstance(rebuilt, Declined) or any(
        rate not in stored.samples or not np.array_equal(stored.samples[rate], array)
        for rate, array in rebuilt.items()
    ):
        raise AssertionError(f"evidence for {key.rates} differs from a rebuild of its key")


@contextmanager
def _rendered(
    project: EpisodeProject,
    track_id: str,
    defaults: EffectiveConfig,
    why: Declined,
    *,
    locked: bool,
) -> Iterator[Path]:
    """The track's render, gate off and chain left out, for as long as the block runs.

    Nothing the block makes is kept in the batch scope: an entry keyed by the render's path
    would outlive the file.
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
    with unscoped(), tempfile.TemporaryDirectory(prefix=RENDER_PREFIX) as directory:
        path = Path(directory) / "evidence.wav"
        timeline_render.render_track_from_timeline(snapshot, track, path, defaults)
        yield path


class _LazyCaches(Mapping[str, TrackRmsCache]):
    """Each track's cache, built when it is first read; a track that builds none is absent."""

    def __init__(
        self, build: Callable[[str], TrackRmsCache | None], track_ids: Iterable[str]
    ) -> None:
        self._build = build
        self._ids = tuple(dict.fromkeys(track_ids))
        self._built: dict[str, TrackRmsCache | None] = {}
        self._lock = threading.RLock()

    def _get(self, track_id: str) -> TrackRmsCache | None:
        with self._lock:
            if track_id not in self._built:
                self._built[track_id] = self._build(track_id)
            return self._built[track_id]

    def __getitem__(self, track_id: str) -> TrackRmsCache:
        cache = self._get(track_id) if track_id in self._ids else None
        if cache is None:
            raise KeyError(track_id)
        return cache

    def __iter__(self) -> Iterator[str]:
        return (tid for tid in self._ids if self._get(tid) is not None)

    def __len__(self) -> int:
        return sum(1 for _ in self)


class LazyRmsSet(TrackRmsCacheSet):
    """A :class:`TrackRmsCacheSet` whose tracks are built when a proof first reads them."""

    def __init__(
        self, build: Callable[[str], TrackRmsCache | None], track_ids: Iterable[str]
    ) -> None:
        super().__init__(caches=_LazyCaches(build, track_ids))  # type: ignore[arg-type]
