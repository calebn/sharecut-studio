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
the cut from each, and returns the first window that passes every row of ``CHECKS``.
Picking is done once per recording: :func:`record_room_tone_pool` runs that pick at evenly
spaced points along the track, keeps the samples that passed, and records them under the
project's ``artifacts``, keyed on the recording's identity. A request on a track with a pool
takes the nearest pooled sample that is clear of ``avoid``, reading no audio; a track
without one picks as above. Spectral flatness is not a check: on the lab tape the room floor's flatness (median
0.019, 10th percentile 0.005) overlaps voice and bleed (median 0.005), so no threshold
separates them; the floor band does.
"""

from __future__ import annotations

import json
import logging
import math
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB, bool_runs, frame_rms_db_stream, rms_db
from podcast_mcp.util.intervals import subtract_intervals
from podcast_mcp.util.project_state import FileRevision, file_revision
from podcast_mcp.util.tracks import track_audio_path

log = logging.getLogger(__name__)

FRAME_SEC = 0.01
# Silero's rate. Levels see up to 8 kHz, where hiss and sibilance sit.
SAMPLE_RATE = 16000
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


@dataclass(frozen=True)
class OwnQuietSample:
    sample: Sample


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
    ]
    rejected_checks: tuple[str, ...] = ()
    unreadable_windows: int = 0
    bed_failure: str | None = None


RoomToneSelection = RecordedBedSample | OwnQuietSample | SampleAbsent


@dataclass(frozen=True)
class BedUnavailable:
    cause: str


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


def room_tone_span(
    project: EpisodeProject,
    track_id: str,
    *,
    near_sec: float,
    duration_sec: float,
    avoid: Sequence[Span] = (),
) -> RoomToneSelection:
    """Measured room tone or an actual absence cause for this request.

    ``near_sec`` is the cut's position in the track's source seconds. ``avoid`` is source
    time a sample of the track's own audio may not come from: a pad that replays the
    source of a cut that has not been applied yet makes that cut play in two places, and
    approving it then removes everything between them. The track's
    recorded bed wins (its ``source_id``); otherwise a sample of the track's own audio
    that may be shorter than ``duration_sec``, for the caller to tile.
    """
    if duration_sec <= 0:
        return SampleAbsent("no_fill_requested")
    bed = room_tone_bed(project, track_id)
    if isinstance(bed, RecordedBedSample):
        return RecordedBedSample(0.0, min(bed.end, duration_sec), bed.source_id, bed.path)
    track = project.track_by_id(track_id)
    if track is None:
        return SampleAbsent("missing_track", bed_failure=bed.cause)
    if track.media is None:
        return SampleAbsent("missing_media", bed_failure=bed.cause)
    pooled = _from_pool(
        read_room_tone_pool(project, track_id) or (),
        near_sec=near_sec,
        duration_sec=duration_sec,
        avoid=avoid,
    )
    if pooled is not None:
        return pooled
    read = track_floor(track_audio_path(project, track_id))
    if isinstance(read, Unmeasured):
        return SampleAbsent(read.cause, bed_failure=bed.cause)
    if isinstance(read, DigitalSilence):
        return SampleAbsent("digital_silence", bed_failure=bed.cause)
    if read.gated:
        return SampleAbsent("gated_live", bed_failure=bed.cause)
    selected = _pick_sample(read.floor, near_sec=near_sec, duration_sec=duration_sec, avoid=avoid)
    if isinstance(selected, SampleAbsent):
        return SampleAbsent(
            selected.cause, selected.rejected_checks, selected.unreadable_windows, bed.cause
        )
    return selected


# Pool: one pick per recording, at evenly spaced points along the track: one a minute of
# quiet-run span, within these bounds, so a long recording's fill is never far from its cut.
POOL_ANCHORS_MIN = 12
POOL_ANCHORS_MAX = 64
POOL_ANCHOR_SPACING_SEC = 60.0
# Each pooled sample is up to this long; a request takes the piece it needs.
POOL_SAMPLE_SEC = 2.0
_POOL_REV = 2
_POOLS_KEPT = 64
_POOL_RECORDS_KEPT = 64
_POOLS: dict[tuple[str, FileRevision], tuple[Sample, ...]] = {}
_POOLS_LOCK = threading.Lock()


def _pool_key(path: Path) -> tuple[str, FileRevision] | None:
    try:
        resolved = path.resolve(strict=True)
        return str(resolved), file_revision(resolved)
    except OSError:
        return None


def _remember_pool(key: tuple[str, FileRevision], pool: tuple[Sample, ...]) -> None:
    with _POOLS_LOCK:
        _POOLS.pop(key, None)
        _POOLS[key] = pool
        while len(_POOLS) > _POOLS_KEPT:
            del _POOLS[next(iter(_POOLS))]


def _pool_record_path(project: EpisodeProject, key: tuple[str, FileRevision]) -> Path:
    from podcast_mcp.util.hashing import short_digest

    return (
        project.artifacts_dir()
        / "room_tone_pools"
        / f"{short_digest(json.dumps([_POOL_REV, *map(str, key)]))}.json"
    )


def read_room_tone_pool(project: EpisodeProject, track_id: str) -> tuple[Sample, ...] | None:
    """The track's pooled samples; ``()`` when none passed, None when it was never picked.

    Read from the process's memory, else from the record an earlier process made. Never
    writes, never decodes: a planning or preview request costs a file read.
    """
    track = project.track_by_id(track_id)
    if track is None or track.media is None:
        return None
    try:
        key = _pool_key(track_audio_path(project, track_id))
    except (OSError, ValueError):
        return None
    if key is None:
        return None
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


def record_room_tone_pool(project: EpisodeProject, track_id: str) -> tuple[Sample, ...] | None:
    """Pick the track's room tone once and record it with the project.

    A no-op returning the recorded pool when there is one. Runs the pick at ``POOL_ANCHORS``
    points along the track (a pass over its quiet runs each, measuring audio), so it belongs
    in ingest or a background warm, never in a request. None when the recording cannot be
    read; ``()`` (also recorded) when it is gated or no sample passes, so it is not picked again.
    """
    known = read_room_tone_pool(project, track_id)
    if known is not None:
        return known
    track = project.track_by_id(track_id)
    if track is None or track.media is None:
        return None
    if _voice_detector_missing():
        # A pool picked now would skip the ``voiced`` check for good: leave it for a run
        # that has the detector, and do not decode the recording to find that out.
        return None
    path = track_audio_path(project, track_id)
    key = _pool_key(path)
    read = track_floor(path)
    if key is None or isinstance(read, Unmeasured):
        return None
    pool: list[Sample] = []
    if isinstance(read, LiveFloor) and not read.gated and read.floor.runs:
        low, high = read.floor.runs[0][0], read.floor.runs[-1][1]
        anchors = min(
            POOL_ANCHORS_MAX,
            max(POOL_ANCHORS_MIN, round((high - low) / POOL_ANCHOR_SPACING_SEC)),
        )
        for index in range(anchors):
            anchor = low + (high - low) * (index + 0.5) / anchors
            picked = _pick_sample(read.floor, near_sec=anchor, duration_sec=POOL_SAMPLE_SEC)
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


_PENDING_POOLS: set[tuple[str, FileRevision]] = set()


def ensure_room_tone_pools(project: EpisodeProject, track_ids: Sequence[str]) -> None:
    """Record the pool of each track that has none, now, on the caller's thread.

    Ingest and background warming record pools. Cut requests only read existing pools
    or select live room tone without recording it. Unreadable tracks are skipped.
    """
    for track_id in dict.fromkeys(track_ids):
        try:
            key = _pool_key(track_audio_path(project, track_id))
            with _POOLS_LOCK:
                if key is not None and key in _PENDING_POOLS:
                    continue  # the ingest thread is picking it
            record_room_tone_pool(project, track_id)
        except Exception:
            log.debug("room tone pool not recorded for %s", track_id, exc_info=True)


def schedule_room_tone_pool(project: EpisodeProject, track_id: str) -> bool:
    """Record the track's pool in a background thread at low priority, once per recording.

    For ingest (a track just added or its media replaced): the pick happens while the user
    is still reviewing, not at their first Approve or Play around. True when queued.
    """
    track = project.track_by_id(track_id)
    if track is None or track.media is None:
        return False
    try:
        key = _pool_key(track_audio_path(project, track_id))
    except (OSError, ValueError):
        return False
    if key is None:
        return False
    with _POOLS_LOCK:
        if key in _POOLS or key in _PENDING_POOLS:
            return False
        _PENDING_POOLS.add(key)

    def run() -> None:
        from podcast_mcp.util.process import low_priority

        try:
            with low_priority():
                record_room_tone_pool(project, track_id)
        except Exception:
            log.debug("room tone pool not recorded for %s", track_id, exc_info=True)
        finally:
            with _POOLS_LOCK:
                _PENDING_POOLS.discard(key)

    threading.Thread(target=run, name=f"room-tone-pool-{track_id}", daemon=True).start()
    return True


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


def _from_pool(
    pool: Sequence[Sample], *, near_sec: float, duration_sec: float, avoid: Sequence[Span]
) -> OwnQuietSample | None:
    """The pooled sample nearest ``near_sec`` with a clear piece long enough, else None."""
    need = min(duration_sec, MIN_SAMPLE_SEC)
    ranked = sorted(pool, key=lambda x: max(x.start - near_sec, near_sec - x.end, 0.0))
    for sample in ranked:
        for piece in subtract_intervals([(sample.start, sample.end)], avoid):
            if piece[1] - piece[0] >= need - 1e-9:
                start, end = _window_nearest(piece, near_sec, duration_sec)
                return OwnQuietSample(Sample(start, end, sample.rms_db, sample.speech_prob))
    return None


def _pick_sample(
    track: TrackFloor, *, near_sec: float, duration_sec: float, avoid: Sequence[Span] = ()
) -> OwnQuietSample | SampleAbsent:
    """The room-tone sample nearest ``near_sec``: quiet runs nearest first, first to pass."""
    need = min(duration_sec, MIN_SAMPLE_SEC)
    if not track.runs:
        return SampleAbsent("no_quiet_run")
    eligible = [run for run in track.runs if run[1] - run[0] >= need - 1e-9]
    if not eligible:
        return SampleAbsent("too_short")
    runs = [
        r
        for run in eligible
        for r in subtract_intervals([run], avoid)
        if r[1] - r[0] >= need - 1e-9
    ]
    runs.sort(key=lambda r: max(r[0] - near_sec, near_sec - r[1], 0.0))
    if not runs:
        return SampleAbsent("excluded")
    rejected: list[str] = []
    unreadable = 0
    for run in runs[:MAX_CANDIDATES]:
        sample = _measure(track, _window_nearest(run, near_sec, duration_sec))
        if sample is None:
            unreadable += 1
            continue
        failed = rejection(sample, track)
        if failed is None:
            return OwnQuietSample(sample)
        if failed not in rejected:
            rejected.append(failed)
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
        audio = load_mono_window(path, start_sec=0.0, duration_sec=bed_sec)
    except FileNotFoundError:
        return BedUnavailable("missing_file")
    except Exception as exc:
        log.warning("room tone bed %s unreadable: %s", source_id, exc)
        return BedUnavailable("unreadable_file")
    if audio.size == 0 or not np.all(np.isfinite(audio)):
        return BedUnavailable("unreadable_file")
    if rms_db(audio, floor_db=DIGITAL_SILENCE_DB) <= DIGITAL_SILENCE_DB:
        return BedUnavailable("digital_silence")
    return RecordedBedSample(0.0, bed_sec, source_id, path)
