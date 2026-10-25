"""A track's own levels, measured once: every detection level is an offset from them (#1443).

A recording's gain moves every dBFS level in it, so no detector compares a level with a
fixed dBFS value. Each reads the track's :class:`LevelProfile` instead: its room (the
10th percentile of its 10 ms frames), its speech level (the 90th percentile of the live
frames) and its loud level (the 99th), plus digital silence, which reads the same at any
gain. Thresholds are offsets from those, so the same recording at any level gets the same
answers. ``scripts/check_level_literals.py`` keeps absolute levels out of the detectors.
See docs/audio-engineering.md § Detection levels.

A track's profile is measured once per audio file revision and sample rate
(:func:`file_level_profile`) and passed to every stage that reads the file at that rate.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from podcast_mcp.engines.media_probe import has_several_audio_streams
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.bounded_cache import BoundedCache
from podcast_mcp.util.dsp import (
    DIGITAL_SILENCE_DB,
    SPEECH_BAND,
    db_to_amplitude,
    frame_band_filtered_db,
    frame_rms_db_stream,
)
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.project_state import FileRevision, file_revision
from podcast_mcp.util.tracks import track_audio_path

log = logging.getLogger(__name__)

LEVEL_FRAME_SEC = 0.01
PROFILE_SAMPLE_RATE = 16000
_MIN_LIVE_SEC = 0.5
_ROOM_PERCENTILE = 10.0
_SPEECH_PERCENTILE = 90.0
_LOUD_PERCENTILE = 99.0
# A whole track is framed a minute at a time, never as one hour-long float64 copy.
_PROFILE_CHUNK_SEC = 60.0

# The voice floor, relative to the track's own room and speech levels, so a voice ends
# at the same sound at any recording level. Why 27 dB: docs/filler-cut-quality.md
# § Policy, Voice floor.
VOICE_FLOOR_UNDER_SPEECH_DB = 27.0
# Never closer than this to the room: on a noisy track the speech term alone sits in
# the room tone and finds no quiet at all. 6 dB clears the frame-to-frame flicker of
# steady room tone and stays under the 9.5 dB over the room where a breath begins
# (``breath_detect._BREATH_ABOVE_FLOOR_DB``), so a kept word's own breath never
# reads as quiet.
VOICE_FLOOR_OVER_ROOM_DB = 6.0
# A speaker's loudest frames (the 99th percentile) sit about this far over their speech
# level (the 90th): 5.3 to 6.3 dB on the lab tape's three tracks. Further apart, the
# speech level is room tone, as on a track whose speaker talks under a tenth of the time.
LOUD_OVER_SPEECH_DB = 6.0


def room_floor_db(
    levels: np.ndarray, *, among: np.ndarray | None = None, percentile: float = _ROOM_PERCENTILE
) -> float:
    """A low percentile of ``levels`` (the 10th by default) over the frames ``among`` selects.

    Every frame by default. Digital silence counts as a level, so a track a noise gate
    holds at zero between its words has digital silence for a room, and an ungated
    track has its room tone. ``among`` lets a caller read the room where the track is
    not sounding (between its own words) instead of over everything it did.
    """
    return float(np.percentile(levels if among is None else levels[among], percentile))


def speech_level_db(levels: np.ndarray, *, min_live_sec: float = _MIN_LIVE_SEC) -> float | None:
    """The speech level of ``levels``: the 90th percentile of the live frames.

    ``None`` when fewer than ``min_live_sec`` of them are live (any live frame counts for
    zero). Digital silence is the gate's, not the voice's, so it is left out.
    """
    live = levels[levels > DIGITAL_SILENCE_DB]
    if live.size == 0 or live.size < min_live_sec / LEVEL_FRAME_SEC:
        return None
    return float(np.percentile(live, _SPEECH_PERCENTILE))


def frame_levels_db(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """The 10 ms frame levels (dBFS) of ``samples``, digital silence held at ``DIGITAL_SILENCE_DB``.

    The levels every :class:`LevelProfile` is read from, so a caller asking where a frame
    sits against a track's floor measures it as the floor was measured.
    """
    frame = max(1, round(sample_rate * LEVEL_FRAME_SEC))
    chunk = frame * round(_PROFILE_CHUNK_SEC / LEVEL_FRAME_SEC)
    return frame_rms_db_stream(
        (samples[i : i + chunk] for i in range(0, samples.size, chunk)),
        frame,
        frame,
        floor_db=DIGITAL_SILENCE_DB,
    )


@dataclass(frozen=True)
class LevelProfile:
    """A track's room, speech and loud levels (dBFS), and the floors read from them.

    ``loud_db`` (the 99th percentile of the live frames) is where a speaker who talks
    under a tenth of the time still shows their voice, when ``speech_db`` (the 90th) is
    room tone. :data:`SILENT` describes a track with no live audio at all.
    """

    room_db: float
    speech_db: float
    loud_db: float

    @property
    def live(self) -> bool:
        """Whether the track holds any audio over digital silence."""
        return math.isfinite(self.speech_db)

    @property
    def room_rms(self) -> float:
        return db_to_amplitude(self.room_db)

    @property
    def speech_rms(self) -> float:
        return db_to_amplitude(self.speech_db)

    @property
    def has_contrast(self) -> bool:
        """Whether the loudest frames stand out of the room by more than its flicker."""
        return self.live and self.loud_db > self.room_db + VOICE_FLOOR_OVER_ROOM_DB

    @property
    def voice_floor_db(self) -> float:
        """The level under which a frame of this track holds no voice: ``max(S - 27, R + 6)``.

        Every rule that asks whether a frame is quiet or audible reads this one floor,
        never a fixed dBFS level. ``inf`` on a track with no live audio: every frame is
        digital silence, so every frame is quiet.
        """
        if not self.live:
            return math.inf
        return max(
            self.speech_db - VOICE_FLOOR_UNDER_SPEECH_DB, self.room_db + VOICE_FLOOR_OVER_ROOM_DB
        )

    @property
    def audibility_floor_db(self) -> float:
        """The level a word's own recording must reach to count as audible.

        The :attr:`voice_floor_db`, except where it cannot tell voice from room: a track
        whose loudest frames sit within 6 dB of its room has no quiet to find, and its
        floor would sit over its own speech and call every word of it inaudible. Such a
        track judges nothing inaudible (``-inf``). Contrast is read from the loudest
        frames, not the speech level, so a speaker who talks under a tenth of the time
        keeps a floor. A track with no live audio at all holds no word (``inf``).
        """
        if not self.live:
            return math.inf
        return self.voice_floor_db if self.has_contrast else -math.inf

    @property
    def voice_reach_db(self) -> float:
        """The level the mean of a stretch of this track must reach to hold its voice.

        The :attr:`audibility_floor_db`, raised to no lower than 27 dB under the track's
        loudest frames: a speaker who talks under a tenth of the time has room tone for a
        speech level, and a floor under that would call the room a voice.
        """
        floor = self.audibility_floor_db
        if not math.isfinite(floor):
            return floor
        return max(floor, self.loud_db - VOICE_FLOOR_UNDER_SPEECH_DB)

    @property
    def voice_db(self) -> float:
        """How loud this track's speaker talks: the speech level, or for a speaker who talks
        under a tenth of the time, whose speech level is room tone, ``LOUD_OVER_SPEECH_DB``
        under the loud level."""
        return max(self.speech_db, self.loud_db - LOUD_OVER_SPEECH_DB)

    @property
    def path_reference_db(self) -> float:
        """The level the bleed path reads as 0 dB: the voice level, or 0 dBFS (as recorded)
        for a track whose loudest frames show no voice over its room (or no live audio at
        all), such as a lane that talks for a second in four minutes."""
        return self.voice_db if self.has_contrast else 0.0

    @property
    def voice_gain(self) -> float:
        """The linear gain that puts :attr:`path_reference_db` at 0 dB.

        The bleed path reads every track through it, so its thresholds are offsets under
        the track's own voice; comparisons between two tracks add back the difference of
        their references, so they compare the tracks as recorded.
        """
        return db_to_amplitude(-self.path_reference_db)


SILENT = LevelProfile(room_db=-math.inf, speech_db=-math.inf, loud_db=-math.inf)


def profile_from_levels(levels: np.ndarray, *, whole_track: bool = False) -> LevelProfile | None:
    """The :class:`LevelProfile` of 10 ms ``levels``, or ``None`` when too few are live.

    A ``whole_track`` profile reads the room over every frame, digital silence
    included: on a track a noise gate holds at digital zero between words (Zoom), the
    quietest live frames are the words' own soft edges, not a room. Any live audio is
    enough for it: its percentiles cover the whole recording, not a few seconds.
    """
    speech_db = speech_level_db(levels, min_live_sec=0.0 if whole_track else _MIN_LIVE_SEC)
    if speech_db is None:
        return None
    live = levels > DIGITAL_SILENCE_DB
    return LevelProfile(
        room_db=room_floor_db(levels, among=None if whole_track else live),
        speech_db=speech_db,
        loud_db=float(np.percentile(levels[live], _LOUD_PERCENTILE)),
    )


def level_profile(
    samples: np.ndarray, sample_rate: int, *, whole_track: bool = False
) -> LevelProfile | None:
    """:func:`profile_from_levels` over the 10 ms frames of ``samples``."""
    return profile_from_levels(frame_levels_db(samples, sample_rate), whole_track=whole_track)


def speech_level_profile(samples: np.ndarray, sample_rate: int) -> LevelProfile:
    """Whole-track :class:`LevelProfile` from speech-band 10 ms frames (#1377).

    Reconcile audibility reads word levels and floors in the speech band so low-band HVAC
    and rumble do not raise the room and call band-limited speech inaudible.
    """
    frame = max(1, round(sample_rate * LEVEL_FRAME_SEC))
    levels = frame_band_filtered_db(
        samples, sample_rate, frame, SPEECH_BAND, floor_db=DIGITAL_SILENCE_DB
    )
    return profile_from_levels(levels, whole_track=True) or SILENT


def track_profile(samples: np.ndarray, sample_rate: int) -> LevelProfile:
    """The whole-track profile of ``samples``; :data:`SILENT` when none of it is live."""
    return level_profile(samples, sample_rate, whole_track=True) or SILENT


# Bounded: a long-lived server measures every revision of every file it ever opens.
_FILE_PROFILES: BoundedCache[tuple[str, FileRevision, int], LevelProfile] = BoundedCache(256)


def file_level_profile(
    path: Path,
    samples: np.ndarray | None = None,
    *,
    sample_rate: int = PROFILE_SAMPLE_RATE,
    levels: np.ndarray | None = None,
    record_dir: Path | None = None,
    write_record: bool = False,
) -> LevelProfile:
    """The whole-track profile of the audio file at ``path``, measured once per file revision and rate.

    With ``record_dir``, a measurement recorded there by an earlier process is read back, and
    ``write_record`` records this one: planning and preview paths read but leave the
    project's files as they found them.

    Read from its mono audio at ``sample_rate``: a floor is measured at the rate of the
    frames it is compared with, since band-limiting a track lowers its room tone (white
    room tone reads about 3.5 dB lower at 8 kHz than at 16 kHz) more than its voice.
    ``samples`` are that audio, or ``levels`` its :func:`frame_levels_db`, when the caller
    has already decoded it.
    """
    resolved = path.resolve()
    key = (str(resolved), file_revision(resolved), int(sample_rate))
    known = _FILE_PROFILES.get(key)
    if known is not None:
        return known
    name_parts = [_RECORD_REV, *map(str, key)]
    if record_dir and has_several_audio_streams(resolved):
        name_parts.append("a0")
    record = record_dir / f"{short_digest(json.dumps(name_parts))}.json" if record_dir else None
    profile = _read_record(record) if record else None
    if profile is None:
        if levels is None:
            if samples is None:
                samples = load_mono_full(resolved, sample_rate=sample_rate)
            levels = frame_levels_db(samples, sample_rate)
        profile = profile_from_levels(levels, whole_track=True) or SILENT
    if record and write_record:
        _write_record(record, profile)
    _FILE_PROFILES.put(key, profile)
    return profile


# Bump when ``profile_from_levels`` or its whole-track framing changes what it returns.
_RECORD_REV = 2
# A record is a few bytes, but every edit to a recording leaves one behind. Eviction goes by
# write time, so the cap sits well over tracks x sample rates: a long-lived record stays.
_RECORDS_KEPT = 256


def _read_record(path: Path) -> LevelProfile | None:
    """A recorded measurement survives a restart: it costs a pass over the whole file."""
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
        profile = LevelProfile(
            *(float(values[name]) for name in ("room_db", "speech_db", "loud_db"))
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return (
        profile if profile.live and all(math.isfinite(v) for v in vars(profile).values()) else None
    )


def _write_record(path: Path, profile: LevelProfile) -> None:
    if not profile.live or not all(math.isfinite(v) for v in vars(profile).values()):
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        write_text_atomic(path, json.dumps(vars(profile)))
    except OSError:
        log.debug("level profile record not written to %s", path, exc_info=True)
        return
    try:
        stale = sorted(path.parent.glob("*.json"), key=lambda p: p.stat().st_mtime)
        for old in stale[:-_RECORDS_KEPT]:
            old.unlink(missing_ok=True)
    except OSError:
        log.debug("level profile records not pruned in %s", path.parent, exc_info=True)


def recording_profile(project: EpisodeProject, track_id: str) -> LevelProfile:
    """The profile of the track's own recording (its primary media), measured once."""
    return file_level_profile(track_audio_path(project, track_id))


def file_speech_level_profile(
    path: Path,
    samples: np.ndarray | None = None,
    *,
    sample_rate: int = PROFILE_SAMPLE_RATE,
) -> LevelProfile:
    """Speech-band whole-track profile of the audio file at ``path``."""
    if samples is None:
        samples = load_mono_full(path, sample_rate=sample_rate)
    return speech_level_profile(samples, sample_rate)
