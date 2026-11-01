"""Room tone for pads and mute fills, chosen from the track's own audio (#1054).

A ripple pad or an approved mute (``tighten.filler_pad_mode: room_tone``) on a track is
filled with its recorded bed (``track.room_tone``) when it has one. Otherwise the fill is
a stretch of the track's own source audio that the audio shows is room tone. Word times
are not consulted: a transcript gap can hold speech the transcript missed, and a word
can be timed over silence (#979). Sampling from word gaps tiled speech and bleed as room
tone on the lab tape, one sample as loud as the speaker's own speech.

The track is read once as 10 ms frame levels (:class:`TrackFloor`). Its noise floor is
the 10th percentile of its live frames (digital silence excluded), as the breath detector
reads one cut's context. A *quiet run* is a stretch where every frame is live and within
``FLOOR_BAND_DB`` of the floor: room tone is steady, so a click, a breath or a syllable
ends the run, and ``SPEECH_GUARD_SEC`` is trimmed from each end that meets louder audio
or digital silence, where a word's attack or tail, or a gate's, still sits at the floor.
The speech level is the 90th percentile of the frames above that band, so a track with
little speech still measures its voice rather than its floor.

A track with more digital silence than quiet live frames is gated: its bed is the
silence, and its live frames are speech whose quiet onsets and tails would pass for a
floor. It has no quiet runs, so no room tone, and the result does not hang on the voice
detector. Its floor and speech level are still measured: the gate fill reads its speech
level for the same credibility rule (``engines/gate_fill.py``).

A request ranks the quiet runs by distance from the cut (all of them sit at the floor,
so the nearest matches the room at the cut best), takes the window of its length nearest
the cut from each, and returns the first window that passes every row of ``CHECKS`` and leaves every other speaker at their floor;
with no such window among the first few that pass, the one under the quietest other speaker.
Picking is done once per recording: :func:`record_room_tone_pool` runs that pick at evenly
spaced points along the track, keeps the samples that passed, and records them under the
project's ``artifacts``, keyed on the recording's identity. A request on a track with a pool
takes the nearest pooled sample with a piece of at least ``MIN_SAMPLE_SEC`` clear of
``avoid``, reading no audio; a track without one picks as above. A pick, the pool's
included, also rejects a window whose level envelope follows another track's voice: that
voice reaches this microphone as bleed under the level checks.
Spectral flatness is not a check: on the lab tape the room floor's flatness (median
0.019, 10th percentile 0.005) overlaps voice and bleed (median 0.005), so no threshold
separates them; the floor band does.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.alignment_key import (
    ingest_alignment_entry,
    speaker_key_unique,
    speaker_label,
)
from podcast_mcp.engines.media_probe import has_several_audio_streams
from podcast_mcp.engines.session_timeline import clip_source_to_timeline_shift
from podcast_mcp.engines.ungated_audio import held_mono_full
from podcast_mcp.models import Clip, EpisodeProject, Track, TrackRole
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.batch_scope import scoped, unscoped
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB, bool_runs, frame_rms_db_stream, rms_db
from podcast_mcp.util.intervals import subtract_intervals
from podcast_mcp.util.project_state import FileRevision, file_revision, project_state_lock
from podcast_mcp.util.tracks import track_audio_path

log = logging.getLogger(__name__)

FRAME_SEC = 0.01
# Silero's rate. Levels see up to 8 kHz, where hiss and sibilance sit.
SAMPLE_RATE = 16000
# The held decode is the stream's samples; slices keep the RMS squares as small as the stream's.
_HELD_CHUNK = SAMPLE_RATE * 60
FLOOR_PERCENTILE = 10.0
SPEECH_PERCENTILE = 90.0
# Every frame of a quiet run sits within this of the floor.
FLOOR_BAND_DB = 10.0
# A sample's RMS sits within this of the floor ...
MAX_ABOVE_FLOOR_DB = 6.0
# ... and at least this far under the speech level. The owner heard bleed turned down
# 20 dB as an echo of the voice (#945), so a sample must sit 10 dB under that.
MIN_BELOW_SPEECH_DB = 30.0
MAX_SPEECH_PROB = 0.5
# A shorter run is a scrap between sounds; tiling it reads as a flutter, not a room.
MIN_SAMPLE_SEC = 0.25
# Trimmed from each end of a quiet run that meets speech or digital silence: there a
# word's attack or reverb tail, or a gate opening or closing, sits at the floor's level
# while it is still voice, which no level check or absent voice detector can catch.
SPEECH_GUARD_SEC = 0.15
MAX_CANDIDATES = 16
# A candidate whose every peer sits within this of its own floor carries no one's voice: the
# nearest such candidate is taken at once. Otherwise the candidates are ranked by how far the
# loudest peer rises above its floor, quietest first.
PEER_QUIET_DB = 3.0
# Ranking stops once this many samples pass: each one costs a read of every peer's file, and
# the nearest few already hold the quietest peer a nearby window offers.
MAX_RANKED = 4
# A bed is checked in windows this long, hopping by half: a burst of speech in a long
# bed must not be averaged away by the steady room around it. A usable run shorter than
# ``BED_MIN_USABLE_SEC`` would be tiled into a stutter.
BED_WINDOW_SEC = 0.5
BED_MIN_USABLE_SEC = 3.0
MAX_BED_VERDICTS = 16

Span = tuple[float, float]
"""Half-open ``(start, end)`` in source seconds."""


@dataclass(frozen=True)
class TrackFloor:
    """One track's source audio as room-tone candidates.

    ``runs`` are the quiet runs, in source seconds; none on a gated track. ``speech_db`` is
    None when no frame rises above the floor band.
    """

    path: Path
    floor_db: float
    speech_db: float | None
    runs: tuple[Span, ...]


@dataclass(frozen=True)
class Sample:
    """A window of track audio measured as a room-tone candidate."""

    start: float
    end: float
    rms_db: float
    speech_prob: float | None


@dataclass(frozen=True)
class LiveFloor:
    floor: TrackFloor
    gated: bool


@dataclass(frozen=True)
class DigitalSilence:
    path: Path


@dataclass(frozen=True)
class Unmeasured:
    cause: Literal["missing_file", "unreadable_file"]
    path: Path


FloorRead = LiveFloor | DigitalSilence | Unmeasured


@dataclass(frozen=True)
class RecordedBedSample:
    start: float
    end: float
    source_id: str
    path: Path
    revision: FileRevision = field(default=(0, 0, 0, 0), compare=False, kw_only=True)


@dataclass(frozen=True)
class OwnQuietSample:
    sample: Sample
    bed_failure: str | None = None
    bed_rejected_checks: tuple[str, ...] = ()


@dataclass(frozen=True)
class SampleAbsent:
    cause: Literal[
        "missing_track",
        "missing_media",
        "missing_file",
        "unreadable_file",
        "digital_silence",
        "gated_live",
        "no_quiet_run",
        "too_short",
        "excluded",
        "rejected",
        "window_unreadable",
        "candidate_limit",
        "no_fill_requested",
        "voice_detector_missing",
    ]
    rejected_checks: tuple[str, ...] = ()
    unreadable_windows: int = 0
    bed_failure: str | None = None
    bed_rejected_checks: tuple[str, ...] = ()


RoomToneSelection = RecordedBedSample | OwnQuietSample | SampleAbsent


@dataclass(frozen=True)
class BedUnavailable:
    cause: str
    rejected_checks: tuple[str, ...] = ()


Check = Callable[[Sample, TrackFloor], bool]

# A sample is room tone only when every row holds; the name is the reason it is not.
CHECKS: tuple[tuple[str, Check], ...] = (
    ("above_floor", lambda s, t: s.rms_db <= t.floor_db + MAX_ABOVE_FLOOR_DB),
    (
        "near_speech",
        lambda s, t: t.speech_db is None or s.rms_db <= t.speech_db - MIN_BELOW_SPEECH_DB,
    ),
    ("voiced", lambda s, t: s.speech_prob is None or s.speech_prob < MAX_SPEECH_PROB),
)


def rejection(sample: Sample, track: TrackFloor) -> str | None:
    """The first ``CHECKS`` row ``sample`` fails, or None when it is room tone."""
    return next((name for name, holds in CHECKS if not holds(sample, track)), None)


def room_tone_source_id(track_id: str) -> str:
    """Stable ``sources[]`` id for a track's recorded room-tone bed."""
    return f"room-tone-{track_id}"


def _after_bed(bed: BedUnavailable, selected: OwnQuietSample | SampleAbsent) -> RoomToneSelection:
    return replace(selected, bed_failure=bed.cause, bed_rejected_checks=bed.rejected_checks)


def room_tone_span(
    project: EpisodeProject,
    track_id: str,
    *,
    near_sec: float,
    near_source_id: str | None,
    timeline_sec: float | None = None,
    duration_sec: float,
    avoid: Sequence[Span] = (),
    also_taken: Sequence[Span] = (),
) -> RoomToneSelection:
    """Measured room tone or an actual absence cause for this request.

    ``near_sec`` is source seconds in ``near_source_id``. ``timeline_sec`` is the timeline
    position of a pad, which binds its sample at propose time: it ranks the pool's samples
    the project already plays nearby after the unused ones. A mute fill passes None and is
    a function of its source position alone, so a preview on a scratch copy and the real
    approve pick alike. ``avoid`` is source time a sample of the track's own audio may not
    come from: a pad that replays the source of a cut that has not been applied yet makes
    that cut play in two places, and approving it then removes everything between them. ``also_taken`` is source time the
    caller has already filled in this pass but not yet applied: it ranks like a fill that
    the project plays. The track's recorded bed wins (its ``source_id``); otherwise a
    sample of the track's own audio that may be shorter than ``duration_sec``, for the
    caller to tile.
    """
    if duration_sec <= 0:
        return SampleAbsent("no_fill_requested")
    bed = room_tone_bed(project, track_id)
    if isinstance(bed, RecordedBedSample):
        return replace(bed, end=min(bed.end, bed.start + duration_sec))
    track = project.track_by_id(track_id)
    if track is None:
        return _after_bed(bed, SampleAbsent("missing_track"))
    if track.media is None:
        return _after_bed(bed, SampleAbsent("missing_media"))

    on_primary = None in project.equivalent_source_ids(track_id, near_source_id)
    pool = read_room_tone_pool(project, track_id) or ()
    in_use = (
        [] if timeline_sec is None else _pool_spans_in_use(project, track_id, pool, timeline_sec)
    )
    taken = [*in_use, *also_taken]
    pooled = _from_pool(
        pool,
        near_sec=near_sec if on_primary else None,
        rotate_sec=near_sec if timeline_sec is None else timeline_sec,
        duration_sec=duration_sec,
        avoid=avoid,
        taken=taken,
    )
    if pooled is not None:
        return _after_bed(bed, pooled)
    read = track_floor(track_audio_path(project, track_id))
    if isinstance(read, Unmeasured):
        return _after_bed(bed, SampleAbsent(read.cause))
    if isinstance(read, DigitalSilence):
        return _after_bed(bed, SampleAbsent("digital_silence"))
    if read.gated:
        return _after_bed(bed, SampleAbsent("gated_live"))
    clear = _no_foreign_voice(project, track_id)
    # Off the pool's clock the cut's position means nothing here: start from the first run.
    near = near_sec if on_primary or not read.floor.runs else read.floor.runs[0][0]

    def pick(avoiding: Sequence[Span]) -> OwnQuietSample | SampleAbsent:
        return _pick_sample(
            read.floor,
            near_sec=near,
            duration_sec=duration_sec,
            avoid=avoiding,
            clear=clear,
        )

    selected = pick([*avoid, *taken])
    if isinstance(selected, SampleAbsent) and taken:
        selected = pick(avoid)
    return _after_bed(bed, selected)


# Pool: one pick per recording, at evenly spaced points along the track: one a minute of
# quiet-run span, within these bounds, so a long recording's fill is never far from its cut.
POOL_ANCHORS_MIN = 12
POOL_ANCHORS_MAX = 64
POOL_ANCHOR_SPACING_SEC = 60.0
# Each pooled sample is up to this long; a request takes the piece it needs.
POOL_SAMPLE_SEC = 2.0
# A pooled sample shorter than this is a scrap that a pad tiles into a stutter.
POOL_MIN_SAMPLE_SEC = 1.0
_POOL_REV = 6
_SHIFT_EPS_SEC = 1e-3
# A pooled sample that a clip or mute fill this close to a pad (timeline seconds, either
# side) already plays ranks after the unused ones: the listener hears both fills together.
TAKEN_WINDOW_SEC = 120.0
_POOLS_KEPT = 64
_POOL_RECORDS_KEPT = 64
# The track's file, then every other track's with the seconds its clock runs ahead of this
# track's: a peer that appears, changes or realigns can bleed.
PoolKey = tuple[str, FileRevision, tuple[tuple[str, FileRevision, float], ...]]

_POOLS: dict[PoolKey, tuple[Sample, ...]] = {}
_POOLS_LOCK = threading.Lock()


def _file_key(project: EpisodeProject, track_id: str) -> tuple[str, FileRevision] | None:
    try:
        resolved = track_audio_path(project, track_id).resolve(strict=True)
        return str(resolved), file_revision(resolved)
    except (OSError, ValueError):
        return None


def _peer_tracks(project: EpisodeProject, track_id: str) -> list[Track]:
    return [
        other
        for other in project.tracks
        if other.id != track_id and other.media is not None and other.role == TrackRole.DIALOGUE
    ]


def _ingest_shift(project: EpisodeProject, track_id: str) -> float:
    """Timeline minus source seconds that ingest placed the track's primary recording at.

    The entries relate the files to each other, so where the clips sit now is not compared.
    """
    track = project.track_by_id(track_id)
    entries = project.meta.ingest_alignment
    if track is None or not entries:
        return 0.0
    on_primary: dict[str | None, bool] = {}
    primary: list[Clip] = []
    for clip in project.clips:
        if clip.track_id != track_id:
            continue
        if clip.source_id not in on_primary:
            on_primary[clip.source_id] = None in project.equivalent_source_ids(
                track_id, clip.source_id
            )
        if on_primary[clip.source_id]:
            primary.append(clip)
    if not primary:
        return 0.0
    first = min(primary, key=lambda c: c.timeline_start)
    entry = ingest_alignment_entry(project, track, first)
    if entry is not None:
        shifts = [entry.source_to_timeline_shift_sec]
    else:
        # A split mints new clip ids, so the entries written for the original clips remain.
        shifts = [
            e.source_to_timeline_shift_sec
            for key, e in entries.items()
            if key.startswith(f"{track_id}:")
        ]
        if speaker_key_unique(project, track) and speaker_label(track) in entries:
            shifts.append(entries[speaker_label(track)].source_to_timeline_shift_sec)
    if not shifts or max(shifts) - min(shifts) > _SHIFT_EPS_SEC:
        return 0.0
    return shifts[0]


def _pool_key(project: EpisodeProject, track_id: str) -> PoolKey | None:
    own = _file_key(project, track_id)
    if own is None:
        return None
    shift = _ingest_shift(project, track_id)
    peers = (
        (key, shift - _ingest_shift(project, other.id))
        for other in _peer_tracks(project, track_id)
        if (key := _file_key(project, other.id)) is not None
    )
    return (*own, tuple(sorted((*key, offset) for key, offset in peers)))


def _remember_pool(key: PoolKey, pool: tuple[Sample, ...]) -> None:
    with _POOLS_LOCK:
        _POOLS.pop(key, None)
        _POOLS[key] = pool
        while len(_POOLS) > _POOLS_KEPT:
            del _POOLS[next(iter(_POOLS))]


def _pool_record_path(project: EpisodeProject, key: PoolKey) -> Path:
    from podcast_mcp.util.hashing import short_digest

    parts = [_POOL_REV, *map(str, key)]
    if has_several_audio_streams(Path(key[0])):
        parts.append("a0")
    return project.artifacts_dir() / "room_tone_pools" / f"{short_digest(json.dumps(parts))}.json"


def _stored_pool(project: EpisodeProject, key: PoolKey) -> tuple[Sample, ...] | None:
    """The pool recorded under ``key``: this process's memory, else the record on disk."""
    with _POOLS_LOCK:
        known = _POOLS.get(key)
    if known is not None:
        return known
    try:
        values = json.loads(_pool_record_path(project, key).read_text(encoding="utf-8"))
        pool = tuple(
            Sample(float(a), float(b), float(c), None if d is None else float(d))
            for a, b, c, d in values["samples"]
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if not all(math.isfinite(x.rms_db) and x.end > x.start >= 0 for x in pool):
        return None
    _remember_pool(key, pool)
    return pool


def read_room_tone_pool(project: EpisodeProject, track_id: str) -> tuple[Sample, ...] | None:
    """The track's pooled samples; ``()`` when none passed, None when it was never picked.

    Read from the process's memory, else from the record an earlier process made. Never
    writes, never decodes: a planning or preview request costs a file read. Inside a batch
    scope the answer, None included, is the batch's first: a pool recorded while the batch
    runs is first read by the next batch, so one batch picks all its cuts the same way.
    """
    track = project.track_by_id(track_id)
    if track is None or track.media is None:
        return None
    key = _pool_key(project, track_id)
    if key is None:
        return None
    return scoped(("room_tone_pool", key), lambda: _stored_pool(project, key))


def record_room_tone_pool(project: EpisodeProject, track_id: str) -> tuple[Sample, ...] | None:
    """Pick the track's room tone once and record it with the project.

    A no-op returning the recorded pool when there is one; while a background recording of
    the same pool runs it waits for that and returns its pool. Runs the pick at
    ``POOL_ANCHORS`` points along the track (a pass over its quiet runs each, measuring
    audio), so it belongs in ingest or a background warm, never in a request. None when the
    recording cannot be read; ``()`` (also recorded) when it is gated or no sample passes,
    so it is not picked again.
    """
    key = _pool_key(project, track_id)
    if key is not None:
        with _POOLS_LOCK:
            _POOLS_DONE.wait_for(lambda: key not in _PENDING_POOLS, timeout=POOL_WAIT_SEC)
    return _record_room_tone_pool(project, track_id)


def _record_room_tone_pool(project: EpisodeProject, track_id: str) -> tuple[Sample, ...] | None:
    track = project.track_by_id(track_id)
    key = _pool_key(project, track_id)
    if track is None or track.media is None or key is None:
        return None
    known = _stored_pool(project, key)
    if known is not None:
        return known
    if _voice_detector_missing():
        # A pool picked now would skip the ``voiced`` check for good: leave it for a run
        # that has the detector, and do not decode the recording to find that out.
        return None
    read = track_floor(track_audio_path(project, track_id))
    if isinstance(read, Unmeasured):
        return None
    pool: list[Sample] = []
    if isinstance(read, LiveFloor) and not read.gated and read.floor.runs:
        low, high = read.floor.runs[0][0], read.floor.runs[-1][1]
        anchors = min(
            POOL_ANCHORS_MAX,
            max(POOL_ANCHORS_MIN, round((high - low) / POOL_ANCHOR_SPACING_SEC)),
        )
        clear = _no_foreign_voice(project, track_id)
        for index in range(anchors):
            anchor = low + (high - low) * (index + 0.5) / anchors
            picked = _pick_sample(
                read.floor,
                near_sec=anchor,
                duration_sec=POOL_SAMPLE_SEC,
                min_sec=POOL_MIN_SAMPLE_SEC,
                clear=clear,
            )
            if isinstance(picked, OwnQuietSample) and all(
                picked.sample.start != kept.start for kept in pool
            ):
                pool.append(picked.sample)
    if any(x.speech_prob is None for x in pool):
        return None  # the detector went away mid-pick
    result = tuple(pool)
    record = _pool_record_path(project, key)
    try:
        if not Path(project.workspace_dir).is_dir():
            raise OSError("the project's workspace is gone")
        record.parent.mkdir(parents=True, exist_ok=True)
        write_text_atomic(
            record,
            json.dumps({"samples": [[x.start, x.end, x.rms_db, x.speech_prob] for x in result]}),
        )
        for old in sorted(record.parent.glob("*.json"), key=lambda p: p.stat().st_mtime)[
            :-_POOL_RECORDS_KEPT
        ]:
            old.unlink(missing_ok=True)
    except OSError:
        log.debug("room tone pool not recorded to %s", record, exc_info=True)
    _remember_pool(key, result)
    return result


_PENDING_POOLS: set[PoolKey] = set()
_POOLS_DONE = threading.Condition(_POOLS_LOCK)
# Pools that could not be recorded (no voice detector, unreadable recording), with when:
# a request does not start a thread for one of them again until this many seconds passed.
_UNRECORDED: dict[PoolKey, float] = {}
UNRECORDED_RETRY_SEC = 300.0
_UNRECORDED_KEPT = 256
POOL_SNAPSHOT_LOCK_SEC = 2.0
POOL_WAIT_SEC = 900.0


def ensure_room_tone_pools(project: EpisodeProject, track_ids: Sequence[str]) -> None:
    """Record the pool of each track that has none, now, on the caller's thread.

    Ingest and background warming record pools. Cut requests only read existing pools
    or select live room tone without recording it. Unreadable tracks are skipped. A pool
    being recorded in the background is waited for, not recorded twice.
    """
    for track_id in dict.fromkeys(track_ids):
        try:
            record_room_tone_pool(project, track_id)
        except Exception:
            log.debug("room tone pool not recorded for %s", track_id, exc_info=True)


def _release_pool(key: PoolKey) -> None:
    with _POOLS_DONE:
        _PENDING_POOLS.discard(key)
        _POOLS_DONE.notify_all()


def _note_unrecorded(key: PoolKey) -> None:
    with _POOLS_LOCK:
        _UNRECORDED.pop(key, None)
        _UNRECORDED[key] = time.monotonic()
        while len(_UNRECORDED) > _UNRECORDED_KEPT:
            del _UNRECORDED[next(iter(_UNRECORDED))]


def _claim_pool(project: EpisodeProject, key: PoolKey) -> bool:
    """Mark ``key`` as being recorded, unless it is known, pending or failed a moment ago."""
    if _stored_pool(project, key) is not None:
        return False
    with _POOLS_LOCK:
        failed = _UNRECORDED.get(key)
        if key in _PENDING_POOLS or (
            failed is not None and time.monotonic() - failed < UNRECORDED_RETRY_SEC
        ):
            return False
        _PENDING_POOLS.add(key)
    return True


def schedule_room_tone_pools(
    project: EpisodeProject, track_ids: Sequence[str] | None = None, *, owned: bool = False
) -> int:
    """Record the missing pools of these tracks (None: every dialogue track) in the background.

    One low-priority thread records the tracks that have media and no pool, one after the
    other, from its own copy of the project taken under ``project_state_lock``: the live
    project is never read by that thread. ``owned`` says no other thread can reach
    ``project`` (a freshly opened one), so the lock is not taken. Once per recording: a pool
    that is known, being recorded or recently unrecordable is skipped. Returns at once with
    how many tracks were queued; 0 when the project's state lock stays busy past
    ``POOL_SNAPSHOT_LOCK_SEC`` or the thread cannot start, and the next call tries again.
    Nothing is queued for a project whose workspace directory is not absolute.
    """
    claimed: list[tuple[str, PoolKey]] = []
    own: EpisodeProject | None = None
    lock = None if owned else project_state_lock(project)
    if lock is not None and not lock.acquire(timeout=POOL_SNAPSHOT_LOCK_SEC):
        return 0
    try:
        wanted = (
            [t.id for t in project.tracks if t.role == TrackRole.DIALOGUE]
            if track_ids is None
            else list(dict.fromkeys(track_ids))
        )
        if not Path(project.meta.workspace_dir).is_absolute():
            wanted = []  # a save in progress shows its portable "." and would resolve to the cwd
        for track_id in wanted:
            track = project.track_by_id(track_id)
            key = _pool_key(project, track_id) if track and track.media else None
            if key is not None and _claim_pool(project, key):
                claimed.append((track_id, key))
        own = project.model_copy(deep=True) if claimed else None
    except Exception:
        log.debug("room tone pools not scheduled", exc_info=True)
    finally:
        if lock is not None:
            lock.release()
    if own is None:
        for _, key in claimed:
            _release_pool(key)
        return 0

    def run() -> None:
        from podcast_mcp.util.process import low_priority

        released: set[PoolKey] = set()
        try:
            with unscoped(), low_priority():
                for track_id, key in claimed:
                    try:
                        if _record_room_tone_pool(own, track_id) is None:
                            _note_unrecorded(key)
                    except Exception:
                        log.debug("room tone pool not recorded for %s", track_id, exc_info=True)
                        _note_unrecorded(key)
                    finally:
                        _release_pool(key)
                        released.add(key)
        finally:
            for _, key in claimed:
                if key not in released:
                    _release_pool(key)

    name = "+".join(track_id for track_id, _ in claimed)
    try:
        threading.Thread(target=run, name=f"room-tone-pool-{name}", daemon=True).start()
    except Exception:
        log.debug("room tone pool thread did not start", exc_info=True)
        for _, key in claimed:
            _release_pool(key)
        return 0
    return len(claimed)


def schedule_room_tone_pool(project: EpisodeProject, track_id: str) -> bool:
    """Record the track's pool in a background thread at low priority, once per recording.

    For ingest (a track just added or its media replaced): the pick happens while the user
    is still reviewing, not at their first Approve or Play around. True when queued.
    """
    return schedule_room_tone_pools(project, [track_id]) == 1


def room_tone_pool_digest(project: EpisodeProject) -> str:
    """Identity of every track's pool, so a render that depends on it changes when it does.

    A preview made before the pool existed picked live; once the pool is recorded the same
    edit approves with a pooled sample, so the cached preview must not be reused.
    """
    parts = []
    for track in project.tracks:
        pool = read_room_tone_pool(project, track.id)
        if pool is not None:
            parts.append([track.id, [[x.start, x.end] for x in pool]])
    return json.dumps(parts) if parts else ""


def room_tone_bed_digest(project: EpisodeProject) -> str:
    """Which registered beds render, and why not: part of a preview's cache key."""
    parts: list[list[object]] = []
    for track in project.tracks:
        if track.room_tone is None:
            continue
        bed = room_tone_bed(project, track.id)
        if isinstance(bed, BedUnavailable):
            parts.append([track.id, bed.cause, list(bed.rejected_checks)])
        else:
            parts.append([track.id, bed.source_id, bed.start, bed.end, list(bed.revision)])
    return json.dumps(parts) if parts else ""


def _pool_spans_in_use(
    project: EpisodeProject, track_id: str, pool: Sequence[Sample], timeline_sec: float
) -> list[Span]:
    """Source spans this track's fills play within ``TAKEN_WINDOW_SEC`` of the cut.

    A pad clip is a primary-recording clip that mostly plays one pooled sample; a speech
    clip that only grazes a sample is not a fill.
    """
    window = (timeline_sec - TAKEN_WINDOW_SEC, timeline_sec + TAKEN_WINDOW_SEC)
    spans: list[Span] = []
    for clip in project.clips:
        if clip.track_id != track_id:
            continue
        for region in clip.mute_regions:
            at = region.start_s + clip_source_to_timeline_shift(clip)
            if (
                region.fill is not None
                and region.fill.source_id is None
                and at < window[1]
                and window[0] < at + (region.end_s - region.start_s)
            ):
                spans.append((region.fill.start_s, region.fill.end_s))
        if clip.timeline_end < window[0] or clip.timeline_start > window[1]:
            continue
        played = max(
            (min(clip.source_end, x.end) - max(clip.source_start, x.start) for x in pool),
            default=0.0,
        )
        if (
            played > 0
            and 2 * played >= clip.source_end - clip.source_start - 1e-6
            and None in project.equivalent_source_ids(track_id, clip.source_id)
        ):
            spans.append((clip.source_start, clip.source_end))
    return spans


def _from_pool(
    pool: Sequence[Sample],
    *,
    near_sec: float | None,
    rotate_sec: float,
    duration_sec: float,
    avoid: Sequence[Span],
    taken: Sequence[Span],
) -> OwnQuietSample | None:
    """The unused pooled sample nearest ``near_sec`` (first in recording order when None)
    with a clear piece of ``MIN_SAMPLE_SEC``, else None.

    With no ``near_sec`` (the cut is not on the pool's recording) the samples are taken in
    recording order, rotated by the ``TAKEN_WINDOW_SEC`` slot of ``rotate_sec`` so distant
    cuts spread over the pool.
    """
    need = min(duration_sec, MIN_SAMPLE_SEC)
    ordered = sorted(pool, key=lambda x: x.start)
    if near_sec is None and ordered:
        turn = int(rotate_sec // TAKEN_WINDOW_SEC) % len(ordered)
        ordered = ordered[turn:] + ordered[:turn]

    def rank(x: Sample) -> tuple[bool, float]:
        used = any(a < x.end and x.start < b for a, b in taken)
        if near_sec is None:
            return used, 0.0
        return used, max(x.start - near_sec, near_sec - x.end, 0.0)

    for sample in sorted(ordered, key=rank):
        for piece in subtract_intervals([(sample.start, sample.end)], avoid):
            if piece[1] - piece[0] >= need - 1e-9:
                centre = (piece[0] + piece[1]) / 2.0 if near_sec is None else near_sec
                start, end = _window_nearest(piece, centre, duration_sec)
                return OwnQuietSample(Sample(start, end, sample.rms_db, sample.speech_prob))
    return None


# A sample whose 10 ms level envelope follows another track's voice this closely is that
# voice reaching this microphone, whatever level it sits at.
BLEED_ENVELOPE_CORRELATION = 0.5
MIN_ENVELOPE_FRAMES = 8


def _envelope_db(audio: np.ndarray) -> np.ndarray:
    frame = int(FRAME_SEC * SAMPLE_RATE)
    count = audio.shape[0] // frame
    shaped = audio[: count * frame].reshape(count, frame)
    return 10.0 * np.log10(np.mean(shaped**2, axis=1) + 1e-12)


def _follows(own: np.ndarray, other: np.ndarray) -> bool:
    count = min(own.shape[0], other.shape[0])
    if count < MIN_ENVELOPE_FRAMES:
        return False
    a, b = own[:count], other[:count]
    if np.ptp(a) == 0.0 or np.ptp(b) == 0.0:
        return False
    return float(np.corrcoef(a, b)[0, 1]) >= BLEED_ENVELOPE_CORRELATION


def _no_foreign_voice(project: EpisodeProject, track_id: str) -> Callable[[Span], float | None]:
    """While another track speaks, its voice reaches this microphone as bleed that sits near
    the room's floor, below any level check: a pad tiles such a sample and repeats the word.
    Each track's primary file sits on its own session clock, so the window is read from a
    peer's file shifted by the difference of their ingest alignments.

    The answer is None for a window a peer's voice follows, else how many dB the loudest peer
    rises above its floor there (0 with no peers; infinite when a peer's file does not cover
    the window, which is no evidence either way and so ranks last).
    """
    own_path = track_audio_path(project, track_id)
    own_shift = _ingest_shift(project, track_id)
    others: list[tuple[Path, float, float]] = []
    for other in _peer_tracks(project, track_id):
        read = track_floor(track_audio_path(project, other.id))
        if isinstance(read, LiveFloor):
            # A gated peer's live frames are all speech: any live frame is its voice.
            floor_db = DIGITAL_SILENCE_DB if read.gated else read.floor.floor_db
            others.append((read.floor.path, floor_db, own_shift - _ingest_shift(project, other.id)))

    def envelope(path: Path, span: Span) -> np.ndarray:
        audio = load_mono_window(
            path,
            start_sec=span[0],
            duration_sec=span[1] - span[0],
            sample_rate=SAMPLE_RATE,
        )
        return _envelope_db(audio)

    def clear(span: Span) -> float | None:
        try:
            own = envelope(own_path, span)
        except Exception as exc:
            log.warning("room tone window %.2f-%.2f unreadable: %s", span[0], span[1], exc)
            return None
        excess = 0.0
        for path, floor_db, offset in others:
            if span[0] + offset < 0:
                excess = math.inf
                continue
            try:
                theirs = envelope(path, (span[0] + offset, span[1] + offset))
            except Exception as exc:
                # A recording that ends before the window has no voice there to bleed in.
                log.debug("room tone window %.2f-%.2f not on %s: %s", span[0], span[1], path, exc)
                excess = math.inf
                continue
            if not theirs.size:
                excess = math.inf
                continue
            peak = float(np.max(theirs)) - floor_db
            if peak > FLOOR_BAND_DB and _follows(own, theirs):
                return None
            excess = max(excess, peak)
        return excess

    return clear


def _pick_sample(
    track: TrackFloor,
    *,
    near_sec: float,
    duration_sec: float,
    avoid: Sequence[Span] = (),
    min_sec: float = MIN_SAMPLE_SEC,
    clear: Callable[[Span], float | None] | None = None,
) -> OwnQuietSample | SampleAbsent:
    """The room-tone sample least likely to carry another voice, nearest ``near_sec`` among equals.

    Quiet runs are tried nearest first. The first passing sample whose peers all sit at their
    floor (``PEER_QUIET_DB``) is taken at once; with none, the passing sample under the quietest
    peer wins, the nearer run breaking ties.
    """
    need = min(duration_sec, min_sec)
    if not track.runs:
        return SampleAbsent("no_quiet_run")
    eligible = [run for run in track.runs if run[1] - run[0] >= need - 1e-9]
    if not eligible:
        return SampleAbsent("too_short")
    runs = [r for r in subtract_intervals(eligible, avoid) if r[1] - r[0] >= need - 1e-9]
    runs.sort(key=lambda r: max(r[0] - near_sec, near_sec - r[1], 0.0))
    if not runs:
        return SampleAbsent("excluded")
    rejected: list[str] = []
    unreadable = 0
    passed: list[tuple[float, int, Sample]] = []
    for order, run in enumerate(runs[:MAX_CANDIDATES]):
        sample = _measure(track, _window_nearest(run, near_sec, duration_sec))
        if sample is None:
            unreadable += 1
            continue
        failed = rejection(sample, track)
        excess = 0.0
        if failed is None and clear is not None:
            heard = clear((sample.start, sample.end))
            if heard is None:
                failed = "other_voice"
            else:
                excess = heard
        if failed is None:
            if excess <= PEER_QUIET_DB:
                return OwnQuietSample(sample)
            passed.append((excess, order, sample))
            if len(passed) >= MAX_RANKED:
                break
        elif failed not in rejected:
            rejected.append(failed)
    if passed:
        return OwnQuietSample(min(passed, key=lambda x: x[:2])[2])
    if len(runs) > MAX_CANDIDATES:
        return SampleAbsent("candidate_limit", tuple(rejected), unreadable)
    if rejected:
        return SampleAbsent("rejected", tuple(rejected), unreadable)
    return SampleAbsent("window_unreadable", unreadable_windows=unreadable)


def _window_nearest(run: Span, near_sec: float, duration_sec: float) -> Span:
    length = min(duration_sec, run[1] - run[0])
    start = min(max(near_sec - length / 2.0, run[0]), run[1] - length)
    return start, start + length


def _measure(track: TrackFloor, span: Span) -> Sample | None:
    start, end = span
    try:
        audio = load_mono_window(
            track.path,
            start_sec=start,
            duration_sec=end - start,
            sample_rate=SAMPLE_RATE,
        )
        if audio.size == 0 or not np.all(np.isfinite(audio)):
            return None
        speech_prob = _speech_prob(audio)
    except Exception as exc:
        log.warning("room tone window %.2f-%.2f unmeasurable: %s", start, end, exc)
        return None
    return Sample(
        start=start,
        end=end,
        rms_db=rms_db(audio, floor_db=DIGITAL_SILENCE_DB),
        speech_prob=speech_prob,
    )


def _voice_detector_missing() -> bool:
    from podcast_mcp.engines.vad_silero import get_shared_vad

    return get_shared_vad() is None


def _speech_prob(audio: np.ndarray) -> float | None:
    from podcast_mcp.engines.vad_silero import get_shared_vad

    vad = get_shared_vad()
    if vad is None or audio.size == 0:
        return None
    return float(np.max(vad.speech_probs(audio)))


def track_floor(path: Path) -> FloorRead:
    """Live, digital or unreadable source facts cached per file revision."""
    try:
        resolved = path.resolve(strict=True)
        return _track_floor(resolved, file_revision(resolved))
    except FileNotFoundError:
        return Unmeasured("missing_file", path)
    except Exception as exc:
        log.warning("room tone levels unavailable for %s: %s", path, exc)
        return Unmeasured("unreadable_file", path)


@lru_cache(maxsize=8)
def _track_floor(path: Path, revision: FileRevision) -> FloorRead:
    """Decode ``path`` once per file revision into its floor, speech level and quiet runs.

    A track whose bed is digital silence (more of it is digital silence than live audio
    at its floor) is gated and has no quiet runs: its holes already match its bed.
    """
    del revision  # part of the cache key: a replaced file is measured again
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    frame = round(SAMPLE_RATE * FRAME_SEC)
    try:
        held = held_mono_full(path, sample_rate=SAMPLE_RATE)
        if held is not None:
            chunks = (held[i : i + _HELD_CHUNK] for i in range(0, held.size, _HELD_CHUNK))
            frames = frame_rms_db_stream(chunks, frame, frame, floor_db=DIGITAL_SILENCE_DB)
        else:
            chunks = FFmpegEngine().stream_mono_f32(path, sample_rate=SAMPLE_RATE)
            frames = frame_rms_db_stream(chunks, frame, frame, floor_db=DIGITAL_SILENCE_DB)
    except FileNotFoundError:
        return Unmeasured("missing_file", path)
    except Exception as exc:
        log.warning("room tone levels unavailable for %s: %s", path, exc)
        return Unmeasured("unreadable_file", path)
    if frames.size == 0 or not np.all(np.isfinite(frames)):
        return Unmeasured("unreadable_file", path)
    live = frames > DIGITAL_SILENCE_DB
    if not live.any():
        return DigitalSilence(path)
    floor_db = float(np.percentile(frames[live], FLOOR_PERCENTILE))
    quiet = live & (frames <= floor_db + FLOOR_BAND_DB)
    gated = np.count_nonzero(~live) > np.count_nonzero(quiet)
    guard = round(SPEECH_GUARD_SEC / FRAME_SEC)
    runs = [
        (i + guard if i > 0 else i, j - guard if j < frames.size else j)
        for i, j in ([] if gated else bool_runs(quiet))
    ]
    loud = frames[frames > floor_db + FLOOR_BAND_DB]
    floor = TrackFloor(
        path=path,
        floor_db=floor_db,
        speech_db=float(np.percentile(loud, SPEECH_PERCENTILE)) if loud.size else None,
        runs=tuple((i * FRAME_SEC, j * FRAME_SEC) for i, j in runs if j > i),
    )
    return LiveFloor(floor, bool(gated))


def room_tone_bed(project: EpisodeProject, track_id: str) -> RecordedBedSample | BedUnavailable:
    """Read the registered source that a bed clip actually renders."""
    track = project.track_by_id(track_id)
    if track is None or track.room_tone is None:
        return BedUnavailable("missing_bed")
    bed_sec = float(track.room_tone.duration_sec or 0.0)
    source_id = room_tone_source_id(track_id)
    source = project.source_by_id(source_id)
    if bed_sec <= 0 or source is None:
        return BedUnavailable("unregistered_bed")
    from podcast_mcp.util.workspace_paths import resolve_under_workspace

    try:
        path = resolve_under_workspace(project, source.path)
        revision = file_revision(path)
        audio = load_mono_window(path, start_sec=0.0, duration_sec=bed_sec, sample_rate=SAMPLE_RATE)
        if file_revision(path) != revision:
            return BedUnavailable("unreadable_file")
    except FileNotFoundError:
        return BedUnavailable("missing_file")
    except Exception as exc:
        log.warning("room tone bed %s unreadable: %s", source_id, exc)
        return BedUnavailable("unreadable_file")
    if audio.size == 0 or not np.all(np.isfinite(audio)):
        return BedUnavailable("unreadable_file")
    if rms_db(audio, floor_db=DIGITAL_SILENCE_DB) <= DIGITAL_SILENCE_DB:
        return BedUnavailable("digital_silence")
    try:
        verdict = _bed_verdict(path, revision, audio)
    except Exception as exc:
        log.warning("room tone bed %s could not be measured: %s", source_id, exc)
        return BedUnavailable("unreadable_file")
    if isinstance(verdict, BedUsable):
        return RecordedBedSample(verdict.start, verdict.end, source_id, path, revision=revision)
    return BedUnavailable("contaminated_bed", verdict)


@dataclass(frozen=True)
class BedUsable:
    start: float
    end: float


BedVerdict = BedUsable | tuple[str, ...]
"""The usable stretch of a bed, or why none is: the ``CHECKS`` row its loudest window
failed, or ``no_usable_run`` when that window passes but no run is long enough."""

_BED_VERDICTS: dict[tuple[Path, FileRevision, int, bool], BedVerdict] = {}


def _bed_verdict(path: Path, revision: FileRevision, audio: np.ndarray) -> BedVerdict:
    """The bed's usable stretch, measured once per file revision.

    The bed has no transcript and its own gain, so it is held to its own floor and speech
    level, window by window; the usable stretch is the longest run of windows that pass
    every row. The detector is in the key because ``voiced`` passes without one.
    """
    key = (path, revision, audio.size, not _voice_detector_missing())
    verdict = _BED_VERDICTS.get(key)
    if verdict is None:
        verdict = _measure_bed(path, audio)
        if len(_BED_VERDICTS) >= MAX_BED_VERDICTS:
            _BED_VERDICTS.clear()
        _BED_VERDICTS[key] = verdict
    return verdict


def _measure_bed(path: Path, audio: np.ndarray) -> BedVerdict:
    window = max(1, round(SAMPLE_RATE * BED_WINDOW_SEC))
    hop = max(1, window // 2)
    starts = [*range(0, max(audio.size - window, 0) + 1, hop)]
    if starts[-1] + window < audio.size:
        starts.append(audio.size - window)
    levels_all = np.array(
        [rms_db(audio[i : i + window], floor_db=DIGITAL_SILENCE_DB) for i in starts]
    )
    # A gated bed is live room noise between stretches of digital silence; those windows
    # would pull the floor below the room itself.
    frame = round(SAMPLE_RATE * FRAME_SEC)
    silent = np.array(
        [
            rms_db(audio[i : i + frame], floor_db=DIGITAL_SILENCE_DB) <= DIGITAL_SILENCE_DB
            for i in range(0, audio.size, frame)
        ]
    )
    live = np.array([not silent[i // frame : -(-(i + window) // frame)].any() for i in starts])
    if not live.any():
        live = np.ones(len(starts), dtype=bool)
    levels = levels_all[live]
    floor_db = float(np.percentile(levels, FLOOR_PERCENTILE))
    track = TrackFloor(path=path, floor_db=floor_db, speech_db=None, runs=())
    samples = [
        Sample(
            i / SAMPLE_RATE,
            min(i + window, audio.size) / SAMPLE_RATE,
            float(level),
            _speech_prob(audio[i : i + window]),
        )
        for i, level, is_live in zip(starts, levels_all, live, strict=True)
        if is_live
    ]
    usable = _longest_passing_run(
        samples, track, minimum_sec=min(BED_MIN_USABLE_SEC, _longest_live_stretch_sec(samples))
    )
    if usable is not None:
        return BedUsable(*usable)
    loudest = Sample(0.0, audio.size / SAMPLE_RATE, float(levels.max()), _speech_prob(audio))
    failed = rejection(loudest, track) or "no_usable_run"
    log.warning(
        "room tone bed %s rejected as contaminated by %s (loudest window %.1f dB, "
        "floor %.1f dB); using track audio",
        path.name,
        failed,
        loudest.rms_db,
        floor_db,
    )
    return (failed,)


def _longest_live_stretch_sec(samples: Sequence[Sample]) -> float:
    """Seconds in the longest chain of overlapping windows, which no run can exceed."""
    longest = 0.0
    start = reached = None
    for sample in samples:
        if start is None or reached is None or sample.start >= reached:
            start = sample.start
        reached = sample.end
        longest = max(longest, reached - start)
    return longest


def _longest_passing_run(
    samples: Sequence[Sample], track: TrackFloor, *, minimum_sec: float
) -> Span | None:
    """The longest stretch of overlapping windows that all pass, at least ``minimum_sec``.

    A run stops ``SPEECH_GUARD_SEC`` short of every failed window that overlaps its ends:
    a word's attack or tail, or a cough's, sits at the floor's level while it is not
    room tone.
    """
    passed = [rejection(sample, track) is None for sample in samples]
    failed = [sample for sample, ok in zip(samples, passed, strict=True) if not ok]
    best: Span | None = None
    first = 0
    for index, sample in enumerate(samples):
        if not passed[index]:
            continue
        if not (index > 0 and passed[index - 1] and sample.start < samples[index - 1].end):
            first = index
        if index + 1 < len(samples) and passed[index + 1] and samples[index + 1].start < sample.end:
            continue
        start, end = samples[first].start, sample.end
        for bad in failed:
            if bad.start <= start < bad.end:
                start = bad.end + SPEECH_GUARD_SEC
            if bad.start < end <= bad.end:
                end = bad.start - SPEECH_GUARD_SEC
        if end - start >= minimum_sec - 1e-9 and (best is None or end - start > best[1] - best[0]):
            best = (start, end)
    return best
