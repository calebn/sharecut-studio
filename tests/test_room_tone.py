"""Room tone is chosen from the track's audio, not from transcript gaps (#1054)."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.room_tone import room_tone_span
from podcast_mcp.edits.timeline_ops import insert_room_tone_pad, mute_room_tone_fill
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    RoomToneFill,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

SR = 16000
DURATION_SEC = 10.0
# Host: a -70 dBFS room floor with voice at -20 dBFS. The transcript has "so", the
# filler "um" and "you", but misses the speech at 2.6-3.9, which sits in its word gap.
FLOOR_DB = -70.0
VOICE_DB = -20.0
WORDS = (("so", 1.0, 1.5), ("um", 4.0, 4.5), ("you", 4.6, 5.0))
UNTRANSCRIBED = (2.6, 3.9)


def _write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.round(np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes(pcm.tobytes())


def _noise(level_db: float, seed: int) -> np.ndarray:
    return np.random.default_rng(seed).normal(0.0, 10 ** (level_db / 20), round(DURATION_SEC * SR))


def _add_voice(samples: np.ndarray, start: float, end: float, level_db: float) -> None:
    """A 140 Hz harmonic voice at ``level_db`` RMS with 10 ms ramps inside ``[start, end)``."""
    i0, i1 = round(start * SR), round(end * SR)
    t = np.arange(i1 - i0) / SR
    voice = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 9))
    voice *= 10 ** (level_db / 20) / np.sqrt(np.mean(voice**2))
    ramp = round(0.01 * SR)
    envelope = np.ones(voice.size)
    envelope[:ramp] = np.linspace(0.0, 1.0, ramp)
    envelope[-ramp:] = np.linspace(1.0, 0.0, ramp)
    samples[i0:i1] += voice * envelope


def _host_audio(floor_db: float = FLOOR_DB) -> np.ndarray:
    host = _noise(floor_db, seed=1054)
    for _, start, end in WORDS:
        _add_voice(host, start, end, VOICE_DB)
    _add_voice(host, *UNTRANSCRIBED, VOICE_DB)
    return host


def _project(
    tmp_path: Path, *, host: np.ndarray, guest: np.ndarray | None = None
) -> EpisodeProject:
    project = EpisodeProject.create("room_tone", str(tmp_path))
    tracks = {"host": host, **({"guest": guest} if guest is not None else {})}
    for tid, samples in tracks.items():
        _write_wav(tmp_path / "raw" / f"{tid}.wav", samples)
        project.tracks.append(
            Track(
                id=tid,
                label=tid.title(),
                role=TrackRole.DIALOGUE,
                speaker=tid.title(),
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=DURATION_SEC),
            )
        )
        project.clips.append(
            Clip(
                id=f"full_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=DURATION_SEC,
                timeline_start=0.0,
            )
        )
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text=w, start=s, end=e) for w, s, e in WORDS],
        )
    ]
    return project


def _host_clip(project: EpisodeProject) -> Clip:
    return next(c for c in project.clips if c.track_id == "host")


def test_untranscribed_speech_in_a_word_gap_is_not_used_to_fill_a_mute(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    # The nearest stretch of floor long enough for the fill starts after "you".
    assert fill == RoomToneFill(start_s=5.0, end_s=5.5, source_id=None)


def test_ripple_pad_is_filled_from_the_floor_not_the_word_gap(tmp_path: Path) -> None:
    gated_guest = np.zeros(round(DURATION_SEC * SR))
    _add_voice(gated_guest, 6.0, 7.0, VOICE_DB)
    project = _project(tmp_path, host=_host_audio(), guest=gated_guest)
    # "um" (4.0-4.5) rippled out: the right clip picks up at "you".
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.5, source_end=10.0, timeline_start=4.0),
        Clip(id="g", track_id="guest", source_start=0.0, source_end=10.0, timeline_start=0.0),
    ]

    insert_room_tone_pad(project, 4.0, 0.3)

    host_pads = [
        (c.source_start, c.source_end)
        for c in project.clips
        if c.track_id == "host" and c.id not in {"a", "b"}
    ]
    assert host_pads == [pytest.approx((5.0, 5.3))]
    # The guest track is gated to digital silence between words: it has no room tone,
    # so its pad stays a hole and its clips still hold only its own 10 s of audio.
    guest_sec = sum(c.source_end - c.source_start for c in project.clips if c.track_id == "guest")
    assert guest_sec == pytest.approx(DURATION_SEC)


def _add_bed(
    project: EpisodeProject,
    tmp_path: Path,
    samples: np.ndarray,
    *,
    register: bool = True,
    write: bool = True,
) -> None:
    if write:
        _write_wav(tmp_path / "raw" / "room-tone" / "host.wav", samples)
    host = project.track_by_id("host")
    assert host is not None
    sec = samples.size / SR
    host.room_tone = MediaAsset(path="raw/room-tone/host.wav", duration_sec=sec)
    if register:
        project.sources.append(
            SourceRecording(
                id="room-tone-host",
                path="raw/room-tone/host.wav",
                duration_sec=sec,
                sample_rate=SR,
                channels=1,
            )
        )


def test_recorded_room_tone_bed_is_preferred_over_track_air(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _noise(-62.0, seed=7)[: 2 * SR])

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill == RoomToneFill(start_s=0.0, end_s=0.5, source_id="room-tone-host")


def test_short_bed_is_tiled_across_a_ripple_pad(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _noise(-62.0, seed=7)[: round(0.2 * SR)])
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.5, source_end=10.0, timeline_start=4.0),
    ]

    insert_room_tone_pad(project, 4.0, 0.5)

    pads = [c for c in project.clips if c.source_id == "room-tone-host"]
    assert [(c.timeline_start, c.source_start, c.source_end) for c in pads] == [
        pytest.approx((4.0, 0.0, 0.2)),
        pytest.approx((4.2, 0.0, 0.2)),
        pytest.approx((4.4, 0.0, 0.1)),
    ]


@pytest.mark.parametrize(
    ("bed", "register", "write"),
    [
        (np.zeros(2 * SR), True, True),
        (_noise(-62.0, seed=7)[: 2 * SR], False, True),
        (_noise(-62.0, seed=7)[: 2 * SR], True, False),
    ],
    ids=["digitally-silent-bed", "bed-without-source", "bed-file-missing"],
)
def test_unusable_bed_falls_back_to_track_air(
    tmp_path: Path, bed: np.ndarray, register: bool, write: bool
) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, bed, register=register, write=write)

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill == RoomToneFill(start_s=5.0, end_s=5.5, source_id=None)


def test_no_room_tone_without_audio_or_length(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    assert room_tone_span(project, "host", near_sec=4.25, duration_sec=0.0) is None
    host = project.track_by_id("host")
    assert host is not None
    host.media = None
    assert room_tone_span(project, "host", near_sec=4.25, duration_sec=0.5) is None
    gated = _project(tmp_path / "gated", host=np.zeros(round(DURATION_SEC * SR)))
    assert room_tone_span(gated, "host", near_sec=4.25, duration_sec=0.5) is None


def test_floor_too_close_to_speech_is_not_room_tone(tmp_path: Path) -> None:
    # A -40 dBFS floor under -20 dBFS speech: 20 dB of contrast, too little to tell
    # room noise from soft voice, so the mute stays silent.
    project = _project(tmp_path, host=_host_audio(floor_db=-40.0))

    assert mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5) is None
