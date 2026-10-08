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
level for the same credibility rule (``edits/gate_fill.py``).

A request ranks the quiet runs by distance from the cut (all of them sit at the floor,
so the nearest matches the room at the cut best), takes the window of its length nearest
the cut from each, and returns the first window that passes every row of ``CHECKS``.
Spectral flatness is not a check: on the lab tape the room floor's flatness (median
0.019, 10th percentile 0.005) overlaps voice and bleed (median 0.005), so no threshold
separates them; the floor band does.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.dsp import bool_runs, frame_rms_db_stream, rms_db
from podcast_mcp.util.intervals import subtract_intervals
from podcast_mcp.util.project_state import FileRevision, file_revision
from podcast_mcp.util.tracks import track_audio_path

log = logging.getLogger(__name__)

FRAME_SEC = 0.01
# Silero's rate. Levels see up to 8 kHz, where hiss and sibilance sit.
SAMPLE_RATE = 16000
DIGITAL_SILENCE_DB = -200.0
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
# Quiet runs tried per request, nearest first. A track whose nearest runs all fail
# has no usable room tone near this cut; the fill stays silent.
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
) -> tuple[float, float, str | None] | None:
    """``(start, end, source_id)`` of room tone to fill ``duration_sec`` near ``near_sec``.

    ``near_sec`` is the cut's position in the track's source seconds. ``avoid`` is source
    time a sample of the track's own audio may not come from: a pad that replays the
    source of a cut that has not been applied yet makes that cut play in two places, and
    approving it then removes everything between them. The track's
    recorded bed wins (its ``source_id``); otherwise a sample of the track's own audio
    (``source_id`` None) that may be shorter than ``duration_sec``, for the caller to
    tile. None when the track has neither, e.g. a track gated to digital silence.
    """
    if duration_sec <= 0:
        return None
    bed = _bed_span(project, track_id, duration_sec)
    if bed is not None:
        return bed
    track = project.track_by_id(track_id)
    if track is None or track.media is None:
        return None
    floor = track_floor(track_audio_path(project, track_id))
    if floor is None:
        return None
    sample = _pick_sample(floor, near_sec=near_sec, duration_sec=duration_sec, avoid=avoid)
    return None if sample is None else (sample.start, sample.end, None)


def _pick_sample(
    track: TrackFloor, *, near_sec: float, duration_sec: float, avoid: Sequence[Span] = ()
) -> Sample | None:
    """The room-tone sample nearest ``near_sec``: quiet runs nearest first, first to pass."""
    need = min(duration_sec, MIN_SAMPLE_SEC)
    runs = [
        r
        for run in track.runs
        for r in subtract_intervals([run], avoid)
        if r[1] - r[0] >= need - 1e-9
    ]
    runs.sort(key=lambda r: max(r[0] - near_sec, near_sec - r[1], 0.0))
    for run in runs[:MAX_CANDIDATES]:
        sample = _measure(track, _window_nearest(run, near_sec, duration_sec))
        if sample is not None and rejection(sample, track) is None:
            return sample
    return None


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


def _speech_prob(audio: np.ndarray) -> float | None:
    from podcast_mcp.engines.vad_silero import get_shared_vad

    vad = get_shared_vad()
    if vad is None or audio.size == 0:
        return None
    return float(np.max(vad.speech_probs(audio)))


def track_floor(path: Path) -> TrackFloor | None:
    """``path``'s floor, speech level and quiet runs (cached per file revision); None when
    it holds no live audio or cannot be read."""
    try:
        resolved = path.resolve(strict=True)
        return _track_floor(resolved, file_revision(resolved))
    except Exception as exc:
        log.warning("room tone levels unavailable for %s: %s", path, exc)
        return None


@lru_cache(maxsize=8)
def _track_floor(path: Path, revision: FileRevision) -> TrackFloor | None:
    """Decode ``path`` once per file revision into its floor, speech level and quiet runs.

    A track whose bed is digital silence (more of it is digital silence than live audio
    at its floor) is gated and has no quiet runs: its holes already match its bed.
    """
    del revision  # part of the cache key: a replaced file is measured again
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    frame = round(SAMPLE_RATE * FRAME_SEC)
    chunks = FFmpegEngine().stream_mono_f32(path, sample_rate=SAMPLE_RATE)
    frames = frame_rms_db_stream(chunks, frame, frame, floor_db=DIGITAL_SILENCE_DB)
    live = frames > DIGITAL_SILENCE_DB
    if not live.any():
        return None
    floor_db = float(np.percentile(frames[live], FLOOR_PERCENTILE))
    quiet = live & (frames <= floor_db + FLOOR_BAND_DB)
    gated = np.count_nonzero(~live) > np.count_nonzero(quiet)
    guard = round(SPEECH_GUARD_SEC / FRAME_SEC)
    runs = [
        (i + guard if i > 0 else i, j - guard if j < frames.size else j)
        for i, j in ([] if gated else bool_runs(quiet))
    ]
    loud = frames[frames > floor_db + FLOOR_BAND_DB]
    return TrackFloor(
        path=path,
        floor_db=floor_db,
        speech_db=float(np.percentile(loud, SPEECH_PERCENTILE)) if loud.size else None,
        runs=tuple((i * FRAME_SEC, j * FRAME_SEC) for i, j in runs if j > i),
    )


def room_tone_bed(project: EpisodeProject, track_id: str) -> tuple[Path, float] | None:
    """``(path, duration_sec)`` of the track's recorded bed, when registered and audible."""
    track = project.track_by_id(track_id)
    if track is None or track.room_tone is None:
        return None
    bed_sec = float(track.room_tone.duration_sec or 0.0)
    if bed_sec <= 0 or project.source_by_id(room_tone_source_id(track_id)) is None:
        return None
    path = Path(track.room_tone.path)
    if not path.is_absolute():
        path = project.workspace_path() / path
    try:
        audio = load_mono_window(path, start_sec=0.0, duration_sec=bed_sec)
    except Exception as exc:
        log.warning("room tone bed %s unreadable: %s", path, exc)
        return None
    if rms_db(audio, floor_db=DIGITAL_SILENCE_DB) <= DIGITAL_SILENCE_DB:
        return None
    return path, bed_sec


def _bed_span(
    project: EpisodeProject, track_id: str, duration_sec: float
) -> tuple[float, float, str] | None:
    """``(0, use, source_id)`` from the track's recorded bed, when it holds audible sound."""
    bed = room_tone_bed(project, track_id)
    if bed is None:
        return None
    return (0.0, min(bed[1], duration_sec), room_tone_source_id(track_id))
