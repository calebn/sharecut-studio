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
from collections.abc import Callable, Iterator
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

import numpy as np

from podcast_mcp import settings
from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines import timeline_render
from podcast_mcp.engines.audio import Audio, sources
from podcast_mcp.engines.audio_audit import TrackRmsCache
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

# What the store keeps while a batch runs (one hour of one track is 345 MB at both rates).
# The bound is per batch scope, not per process. Settable.
EVIDENCE_CACHE_BYTES = 1 << 30
VERIFY_ENV = "PODCAST_EVIDENCE_VERIFY"
RENDER_PREFIX = "sharecut-evidence-render-"
_STORE_KEY = "track_evidence_store"
# The rates of edits.audio_cache.TrackAudioCache: window RMS reads, and waveform scoring.
JUMP_SAMPLE_RATE = 8000
WAVEFORM_SAMPLE_RATE = PROFILE_SAMPLE_RATE
# Both rates come from one pass over the tree, so any caller's 8 kHz array is the same one.
_RATES = (JUMP_SAMPLE_RATE, WAVEFORM_SAMPLE_RATE)
_store_creation = threading.Lock()


class Declined(Enum):
    """Why a track's evidence comes from the render. The value is what the log says.

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
    """Everything the evaluator reads: two equal keys evaluate to the same samples.

    ``tree`` is the whole of the evaluator's input except the audio files, which
    ``revisions`` names; ``curve`` is the one ``defaults`` value the tree is read with.
    """

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
        """A cache over the stored array, with the profile measured once per entry."""
        if rate not in self._profiles:
            self._profiles[rate] = track_profile(self.samples[rate], rate)
        return TrackRmsCache(
            samples=self.samples[rate], sample_rate=rate, recording_profile=self._profiles[rate]
        )


@dataclass(frozen=True)
class HeardAudio:
    """A track as heard at both evidence resolutions: ``edits.audio_cache.TrackAudioCache``'s fields.

    ``engines`` sits below ``edits``, so the caller builds its ``TrackAudioCache`` from these.
    """

    jump: TrackRmsCache
    waveform: TrackRmsCache


def heard(project: EpisodeProject, track_id: str, defaults: EffectiveConfig) -> HeardAudio:
    """The track as heard (gate off, effects chain left out) at both evidence resolutions."""
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
    """The track as heard (gate off, effects chain left out) for window reads at 8 kHz.

    ``private`` says ``project`` is a copy only the caller holds, so reading it takes no
    project lock: a pool worker inside a mutation does not own the lock (#1471).
    """
    entry = _entry(project, track_id, defaults, locked=not private)
    if isinstance(entry, Declined):
        with _rendered(project, track_id, defaults, entry, locked=not private) as path, unscoped():
            return TrackRmsCache.from_timeline_stem(path)
    return entry.cache(JUMP_SAMPLE_RATE)


def _plan(
    project: EpisodeProject, track_id: str, defaults: EffectiveConfig
) -> tuple[EvidenceKey, Audio] | Declined:
    """The track's tree with its key, or why its evidence needs the render."""
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
    """``tree`` at both evidence rates from one pass over it, or why the evaluator takes it not.

    The tree is evaluated at the sources' own rate, in chunks, and converted once per rate as
    decoding the render's wav is: slices start between samples, and slicing a decode at the
    target rate instead would shift every cut by a fraction of a sample.
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
            resample=resample_streams,
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
    """The batch's evidence, least recently used out first once past ``EVIDENCE_CACHE_BYTES``.

    A decline is remembered too: the tree is not evaluated again to be declined again.
    """

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
    # Threads carried into a batch share its scope, so two can reach here together.
    with _store_creation:
        return scoped(_STORE_KEY, _Store)


def _verify(stored: _Entry, rebuilt: Evidence | Declined) -> None:
    """Fail unless a rebuild of the key is the stored evidence (``PODCAST_EVIDENCE_VERIFY=1``).

    This checks the store, not the evaluator: equality with the render is the render-equality
    tests' job.
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
    """The track's render, gate off and chain left out, for as long as the block runs.

    The render runs in the batch scope, which shares its inputs. The caller reads the wav
    outside it (``unscoped``): an entry keyed by the wav's path would outlive the file.
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
