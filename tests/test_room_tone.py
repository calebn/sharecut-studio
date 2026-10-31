"""Room tone is chosen from the track's audio, not from transcript gaps (#1054)."""

from __future__ import annotations

import os
import wave
from collections.abc import Callable
from itertools import pairwise
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.edits.cut_placement import CutScopeHold
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.timeline_ops import (
    LaneUnavailable,
    fill_with_room_tone,
    insert_room_tone_pad,
    mute_room_tone_fill,
)
from podcast_mcp.engines import room_tone as room_tone_module
from podcast_mcp.engines import room_tone_synth
from podcast_mcp.engines.audio import SourceAudio
from podcast_mcp.engines.clips_ops import (
    crossfade_block_reason,
    crossfade_borrow_sec,
    crossfade_ms_at_join,
)
from podcast_mcp.engines.room_tone import (
    SPEECH_GUARD_SEC,
    BedUnavailable,
    OwnQuietSample,
    RecordedBedSample,
    Sample,
    SampleAbsent,
    room_tone_bed,
    room_tone_bed_digest,
    room_tone_span,
)
from podcast_mcp.engines.room_tone_tiles import CROSSFADE_MS
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    ClipMuteRegion,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    RoomToneFill,
    SourceRecording,
    SpeakerIngestAlignment,
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

    # The nearest stretch of floor long enough for the fill starts after "you" and
    # its 0.15 s guard.
    assert fill is not None
    assert (fill.start_s, fill.end_s, fill.source_id) == (
        pytest.approx(5.15),
        pytest.approx(5.65),
        None,
    )


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

    insert_room_tone_pad(project, 4.0, 0.3, defaults=load_defaults())

    host_pads = [
        (c.source_start, c.source_end)
        for c in project.clips
        if c.track_id == "host" and c.id not in {"a", "b"}
    ]
    assert host_pads == [pytest.approx((5.15, 5.45))]
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

    insert_room_tone_pad(project, 4.0, 0.5, defaults=load_defaults())

    pads = [c for c in project.clips if c.source_id == "room-tone-host"]
    assert [(c.timeline_start, c.source_start, c.source_end) for c in pads] == [
        pytest.approx((4.0, 0.0, 0.2)),
        pytest.approx((4.2, 0.0, 0.2)),
        pytest.approx((4.4, 0.0, 0.1)),
    ]
    # Tiles abut: only the pad's outer edges fade, so the seams carry no dip.
    assert [(c.fade_in_ms, c.fade_out_ms) for c in pads] == [(10, 0), (0, 0), (0, 10)]


def _speech_bed() -> np.ndarray:
    bed = _noise(-62.0, seed=7)[: 2 * SR]
    _add_voice(bed, 0.5, 1.5, VOICE_DB)
    return bed


@pytest.mark.parametrize(
    ("bed", "register", "write"),
    [
        (np.zeros(2 * SR), True, True),
        (_speech_bed(), True, True),
        (_noise(-62.0, seed=7)[: 2 * SR], False, True),
        (_noise(-62.0, seed=7)[: 2 * SR], True, False),
    ],
    ids=["digitally-silent-bed", "speech-in-bed", "bed-without-source", "bed-file-missing"],
)
def test_unusable_bed_falls_back_to_track_air(
    tmp_path: Path, bed: np.ndarray, register: bool, write: bool
) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, bed, register=register, write=write)

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert (fill.start_s, fill.end_s, fill.source_id) == (
        pytest.approx(5.15),
        pytest.approx(5.65),
        None,
    )


def test_contaminated_bed_is_reported_and_left_untouched(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _speech_bed())
    bed_file = tmp_path / "raw" / "room-tone" / "host.wav"
    before = (bed_file.read_bytes(), project.model_dump_json())

    selected = room_tone_span(
        project, "host", near_sec=4.0, near_source_id=None, timeline_sec=4.0, duration_sec=0.5
    )

    assert isinstance(selected, OwnQuietSample)
    assert selected.bed_failure == "contaminated_bed"
    assert selected.bed_rejected_checks == ("above_floor",)
    assert (bed_file.read_bytes(), project.model_dump_json()) == before


def test_short_burst_in_a_long_bed_is_not_averaged_away(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = _noise(-62.0, seed=7)
    _add_voice(bed, 3.0, 3.6, VOICE_DB)
    _add_bed(project, tmp_path, bed)

    selected = room_tone_bed(project, "host")

    assert isinstance(selected, RecordedBedSample)
    assert selected.end <= 3.0 or selected.start >= 3.6


def test_a_bed_whose_longest_quiet_run_is_too_short_to_tile_is_rejected(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = _noise(-62.0, seed=7)
    for second in range(len(bed) // SR):
        if second % 2 == 1:
            _add_voice(bed, second + 0.1, second + 0.9, VOICE_DB)
    _add_bed(project, tmp_path, bed)

    selected = room_tone_bed(project, "host")

    assert isinstance(selected, BedUnavailable)
    assert selected.cause == "contaminated_bed"


def test_a_bed_stretch_starts_a_guard_after_the_last_window_the_cough_touches(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = _noise(-62.0, seed=7)
    _add_voice(bed, 3.0, 3.6, VOICE_DB)
    _add_bed(project, tmp_path, bed)

    selected = room_tone_bed(project, "host")

    assert isinstance(selected, RecordedBedSample)
    assert selected.start >= 4.0 + SPEECH_GUARD_SEC - 1e-6


def test_a_bed_stretch_ends_a_guard_before_the_first_window_the_cough_touches(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = _noise(-62.0, seed=7)
    _add_voice(bed, 6.0, 6.6, VOICE_DB)
    _add_bed(project, tmp_path, bed)

    selected = room_tone_bed(project, "host")

    assert isinstance(selected, RecordedBedSample)
    assert selected.end <= 5.75 - SPEECH_GUARD_SEC + 1e-6


def test_the_bed_stretch_is_the_longest_quiet_run(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = _minute_noise(7)
    _add_voice(bed, 41.0, 41.6, VOICE_DB)
    _add_bed(project, tmp_path, bed)

    selected = room_tone_bed(project, "host")

    assert isinstance(selected, RecordedBedSample)
    assert (selected.start, selected.end) == pytest.approx((0.0, 41.0), abs=0.5)


def test_a_pad_reads_the_bed_from_the_start_of_its_quiet_stretch(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = _noise(-62.0, seed=7)
    _add_voice(bed, 1.0, 1.6, VOICE_DB)
    _add_bed(project, tmp_path, bed)

    selected = room_tone_span(project, "host", near_sec=4.0, near_source_id=None, duration_sec=2.0)

    assert isinstance(selected, RecordedBedSample)
    assert selected.start >= 1.6 + SPEECH_GUARD_SEC
    assert selected.end - selected.start == pytest.approx(2.0)


def test_a_gated_bed_with_two_separate_pockets_keeps_the_longer_one(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = np.zeros(6 * SR)
    bed[:SR] = _noise(-62.0, seed=7)[:SR]
    bed[5 * SR :] = _noise(-62.0, seed=8)[:SR]
    bed[5 * SR + SR // 2 :] = 0.0
    _add_bed(project, tmp_path, bed)

    selected = room_tone_bed(project, "host")

    assert isinstance(selected, RecordedBedSample)
    assert (selected.start, selected.end) == pytest.approx((0.0, 1.0), abs=0.01)


def test_a_faint_blip_does_not_make_the_clean_bed_near_speech(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = np.random.default_rng(7).normal(0.0, 10 ** (-70.0 / 20), 60 * SR)
    _add_voice(bed, 30.0, 30.05, -45.0)
    _add_bed(project, tmp_path, bed)

    selected = room_tone_bed(project, "host")

    assert isinstance(selected, RecordedBedSample)
    assert selected.end <= 30.0 or selected.start >= 30.05


def test_a_bed_loud_throughout_is_still_rejected(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = _noise(-62.0, seed=7)
    for second in range(len(bed) // SR):
        _add_voice(bed, second + 0.1, second + 0.9, VOICE_DB)
    _add_bed(project, tmp_path, bed)

    selected = room_tone_span(
        project, "host", near_sec=4.0, near_source_id=None, timeline_sec=4.0, duration_sec=0.5
    )

    assert isinstance(selected, OwnQuietSample)
    assert selected.bed_failure == "contaminated_bed"


def _minute_noise(seed: int) -> np.ndarray:
    return np.random.default_rng(seed).normal(0.0, 10 ** (-62.0 / 20), 60 * SR)


def test_one_minute_bed_is_read_whole_and_a_pad_takes_its_start(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _minute_noise(7))

    bed = room_tone_bed(project, "host")
    selected = room_tone_span(project, "host", near_sec=4.0, near_source_id=None, duration_sec=8.0)

    assert isinstance(bed, RecordedBedSample)
    assert bed.end == pytest.approx(60.0)
    assert selected == RecordedBedSample(0.0, 8.0, "room-tone-host", bed.path)


def test_one_minute_bed_with_a_cough_keeps_its_longest_quiet_stretch(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = _minute_noise(7)
    _add_voice(bed, 41.0, 41.6, VOICE_DB)
    _add_bed(project, tmp_path, bed)

    selected = room_tone_span(project, "host", near_sec=4.0, near_source_id=None, duration_sec=8.0)

    assert isinstance(selected, RecordedBedSample)
    assert (selected.start, selected.end) == pytest.approx((0.0, 8.0), abs=0.5)


def test_gated_bed_with_clean_room_noise_is_accepted(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = np.zeros(4 * SR)
    bed[:SR] = _noise(-62.0, seed=7)[:SR]
    _add_bed(project, tmp_path, bed)

    selected = room_tone_span(
        project, "host", near_sec=4.0, near_source_id=None, timeline_sec=4.0, duration_sec=0.5
    )

    assert isinstance(selected, RecordedBedSample)


def test_speech_in_a_gated_bed_is_still_rejected(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    bed = np.zeros(4 * SR)
    bed[: 2 * SR] = _noise(-62.0, seed=7)[: 2 * SR]
    _add_voice(bed, 0.5, 1.5, VOICE_DB)
    _add_bed(project, tmp_path, bed)

    selected = room_tone_span(
        project, "host", near_sec=4.0, near_source_id=None, timeline_sec=4.0, duration_sec=0.5
    )

    assert isinstance(selected, OwnQuietSample)
    assert selected.bed_failure == "contaminated_bed"


def test_contaminated_bed_changes_the_pending_preview_key(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _noise(-62.0, seed=7)[: 2 * SR])
    clean = room_tone_bed_digest(project)

    _add_bed(project, tmp_path, _speech_bed(), register=False)

    assert room_tone_bed_digest(project) != clean


def test_replacing_a_usable_bed_file_changes_the_pending_preview_key(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _noise(-62.0, seed=7)[: 2 * SR])
    before = room_tone_bed_digest(project)

    _add_bed(project, tmp_path, _noise(-62.0, seed=8)[: 2 * SR], register=False)
    bed_path = tmp_path / "raw" / "room-tone" / "host.wav"
    stat = bed_path.stat()
    os.utime(bed_path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))

    assert room_tone_bed_digest(project) != before


def test_a_bed_replaced_while_it_is_read_is_unreadable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _noise(-62.0, seed=7)[: 2 * SR])
    bed_path = tmp_path / "raw" / "room-tone" / "host.wav"
    real_load = room_tone_module.load_mono_window

    def replace_then_load(*args: object, **kwargs: object) -> np.ndarray:
        audio = real_load(*args, **kwargs)
        _write_wav(bed_path, _noise(-62.0, seed=9)[: 2 * SR])
        stat = bed_path.stat()
        os.utime(bed_path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        return audio

    monkeypatch.setattr(room_tone_module, "load_mono_window", replace_then_load)

    assert room_tone_bed(project, "host") == BedUnavailable("unreadable_file")


def test_clean_bed_passes_without_a_voice_detector(tmp_path: Path, no_voice_detector: None) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _noise(-62.0, seed=7)[: 2 * SR])

    assert isinstance(
        room_tone_span(
            project, "host", near_sec=4.0, near_source_id=None, timeline_sec=4.0, duration_sec=0.5
        ),
        RecordedBedSample,
    )


def test_bed_the_voice_detector_cannot_measure_is_not_used(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _noise(-62.0, seed=11)[: 2 * SR])

    def broken(_audio: np.ndarray) -> float:
        raise RuntimeError("detector failed")

    monkeypatch.setattr("podcast_mcp.engines.room_tone._speech_prob", broken)

    selected = room_tone_span(
        project, "host", near_sec=4.0, near_source_id=None, timeline_sec=4.0, duration_sec=0.5
    )

    assert not isinstance(selected, RecordedBedSample)
    assert selected.bed_failure == "unreadable_file"


def test_clean_bed_has_no_bed_failure(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _noise(-62.0, seed=7)[: 2 * SR])

    selected = room_tone_span(
        project, "host", near_sec=4.0, near_source_id=None, timeline_sec=4.0, duration_sec=0.5
    )

    assert isinstance(selected, RecordedBedSample)


def test_sampled_tiles_fade_only_at_the_pad_edges(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.5, source_end=10.0, timeline_start=4.0),
    ]

    # A 0.5 s sample tiled across a 1.3 s pad.
    insert_room_tone_pad(project, 4.0, 1.3, sample_duration_sec=0.5, defaults=load_defaults())

    pads = sorted(
        (c for c in project.clips if c.id not in {"a", "b"} and c.track_id == "host"),
        key=lambda c: c.timeline_start,
    )
    assert [(c.timeline_start, c.source_end - c.source_start) for c in pads] == [
        pytest.approx((4.0, 0.5)),
        pytest.approx((4.5, 0.5)),
        pytest.approx((5.0, 0.3)),
    ]
    assert len({(c.source_start) for c in pads}) == 1
    # Tiles abut: only the pad's outer edges fade, so the seams carry no dip.
    assert [(c.fade_in_ms, c.fade_out_ms) for c in pads] == [(10, 0), (0, 0), (0, 10)]


@pytest.fixture
def tiling_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep recorded audio and the tiler for a fill that would otherwise be synthesised."""
    monkeypatch.setattr(room_tone_synth, "SYNTH_MAX_REPLAY_SEC", float("inf"))


def _pad_over_a_short_bed(
    tmp_path: Path, at_time: float, seconds: float
) -> tuple[list[Clip], EpisodeProject]:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _noise(-62.0, seed=7)[: 3 * SR])
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.5, source_end=10.0, timeline_start=4.0),
    ]
    insert_room_tone_pad(project, at_time, seconds, defaults=load_defaults())
    pads = sorted(
        (c for c in project.clips if c.source_id == "room-tone-host"),
        key=lambda c: c.timeline_start,
    )
    return pads, project


def test_a_pad_longer_than_the_bed_blends_its_repeats(tmp_path: Path, tiling_only: None) -> None:
    pads, project = _pad_over_a_short_bed(tmp_path, 4.0, 20.0)

    assert len(pads) > 2
    assert sum(c.source_end - c.source_start for c in pads) == pytest.approx(20.0)
    for left, right in pairwise(pads):
        assert right.join_in_mode == ClipJoinMode.CROSSFADE
        assert crossfade_block_reason(left, right, project) is None
        assert crossfade_ms_at_join(left, right) == CROSSFADE_MS
        assert left.source_start != right.source_start
    assert [(c.fade_in_ms, c.fade_out_ms) for c in (pads[0], pads[-1])] == [
        (10, CROSSFADE_MS),
        (CROSSFADE_MS, 10),
    ]


def test_a_blended_repeat_never_borrows_audio_outside_the_bed(
    tmp_path: Path, tiling_only: None
) -> None:
    pads, project = _pad_over_a_short_bed(tmp_path, 4.0, 20.0)

    for left, right in pairwise(pads):
        borrow = crossfade_borrow_sec(project, left, right)
        assert borrow > 0
        assert left.source_end + borrow <= 3.0 + 1e-9
        assert right.source_start - borrow >= 0.0 - 1e-9


def test_a_pad_the_bed_covers_is_one_unblended_clip(tmp_path: Path) -> None:
    pads, _ = _pad_over_a_short_bed(tmp_path, 4.0, 2.0)

    assert [(c.source_start, c.source_end) for c in pads] == [pytest.approx((0.0, 2.0))]
    assert (pads[0].fade_in_ms, pads[0].fade_out_ms) == (10, 10)


def test_the_same_pad_position_tiles_the_bed_the_same_way(
    tmp_path: Path, tiling_only: None
) -> None:
    first, _ = _pad_over_a_short_bed(tmp_path / "one", 4.0, 20.0)
    second, _ = _pad_over_a_short_bed(tmp_path / "two", 4.0, 20.0)

    assert [(c.source_start, c.source_end) for c in first] == [
        (c.source_start, c.source_end) for c in second
    ]


def _mute_fill_tiles(
    tmp_path: Path, mute: tuple[float, float], fill: tuple[float, float]
) -> list[tuple[float, SourceAudio]]:
    from podcast_mcp.engines.timeline_render import _room_tone_under_mutes

    project = _project(tmp_path, host=_host_audio())
    track = project.track_by_id("host")
    clip = Clip(id="c", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0)
    clip.mute_regions = [
        ClipMuteRegion(
            start_s=mute[0], end_s=mute[1], fill=RoomToneFill(start_s=fill[0], end_s=fill[1])
        )
    ]
    tiles = _room_tone_under_mutes(project, track, clip, 0.0, 10.0)
    assert all(isinstance(t.audio, SourceAudio) for t in tiles)
    return [(t.start_sec, t.audio) for t in tiles]


def test_a_mute_fill_longer_than_its_span_overlaps_blended_tiles_inside_the_span(
    tmp_path: Path,
) -> None:
    tiles = _mute_fill_tiles(tmp_path, (1.0, 9.0), (4.0, 7.0))

    assert len(tiles) > 2
    for _, leaf in tiles:
        assert leaf.src_start >= 4.0 - 1e-9
        assert leaf.src_end <= 7.0 + 1e-9
    for (_, left), (_, right) in pairwise(tiles):
        assert left.reach_out == right.reach_in > 0
        assert left.fade_out_sec == right.fade_in_sec == pytest.approx(2 * left.reach_out)
        assert left.nominal_start != right.nominal_start
    nominal = sum(leaf.nominal_end - leaf.nominal_start for _, leaf in tiles)
    assert nominal == pytest.approx(8.0)


def test_a_mute_fill_cut_off_by_the_window_does_not_fade_out_at_the_cut(tmp_path: Path) -> None:
    cut_off = _mute_fill_tiles(tmp_path / "cut", (8.0, 12.0), (4.0, 7.0))
    whole = _mute_fill_tiles(tmp_path / "whole", (2.0, 8.0), (4.0, 7.0))

    assert cut_off[-1][1].fade_out_sec == 0.0
    assert whole[-1][1].fade_out_sec > 0.0


def test_a_mute_fill_the_span_covers_is_one_unblended_tile(tmp_path: Path) -> None:
    tiles = _mute_fill_tiles(tmp_path, (1.0, 3.0), (4.0, 7.0))

    assert [
        (t, leaf.src_start, leaf.src_end, leaf.reach_in, leaf.reach_out) for t, leaf in tiles
    ] == [pytest.approx((1.0, 4.0, 6.0, 0.0, 0.0))]


def test_a_mute_fill_tiles_the_same_way_every_time(tmp_path: Path) -> None:
    first = _mute_fill_tiles(tmp_path / "one", (1.0, 9.0), (4.0, 7.0))
    second = _mute_fill_tiles(tmp_path / "two", (1.0, 9.0), (4.0, 7.0))

    def geometry(tiles: list[tuple[float, SourceAudio]]) -> list[tuple[float, ...]]:
        return [
            (at, leaf.src_start, leaf.src_end, leaf.fade_in_sec, leaf.fade_out_sec)
            for at, leaf in tiles
        ]

    assert geometry(first) == geometry(second)


def test_room_tone_is_not_taken_from_source_a_pending_cut_still_plays(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())

    nearest = room_tone_span(
        project, "host", near_sec=4.25, near_source_id=None, timeline_sec=4.25, duration_sec=0.3
    )
    kept = room_tone_span(
        project,
        "host",
        near_sec=4.25,
        near_source_id=None,
        timeline_sec=4.25,
        duration_sec=0.3,
        avoid=[(5.0, 7.0)],
    )

    assert isinstance(nearest, OwnQuietSample)
    assert nearest.sample.start == pytest.approx(5.15)
    assert isinstance(kept, OwnQuietSample)
    assert (kept.sample.start, kept.sample.end) == (pytest.approx(2.15), pytest.approx(2.45))


def test_no_room_tone_without_audio_or_length(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    assert room_tone_span(
        project, "host", near_sec=4.25, near_source_id=None, timeline_sec=4.25, duration_sec=0.0
    ) == SampleAbsent("no_fill_requested")
    host = project.track_by_id("host")
    assert host is not None
    host.media = None
    missing = room_tone_span(
        project, "host", near_sec=4.25, near_source_id=None, timeline_sec=4.25, duration_sec=0.5
    )
    assert isinstance(missing, SampleAbsent)
    assert missing.cause == "missing_media"
    gated = _project(tmp_path / "gated", host=np.zeros(round(DURATION_SEC * SR)))
    silent = room_tone_span(
        gated, "host", near_sec=4.25, near_source_id=None, timeline_sec=4.25, duration_sec=0.5
    )
    assert isinstance(silent, SampleAbsent)
    assert silent.cause == "digital_silence"


def test_floor_too_close_to_speech_is_not_room_tone(tmp_path: Path) -> None:
    # A -40 dBFS floor under -20 dBFS speech: 20 dB of contrast, too little to tell
    # room noise from soft voice, so the mute stays silent.
    project = _project(tmp_path, host=_host_audio(floor_db=-40.0))

    assert mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5) is None


@pytest.mark.parametrize("bleed_db", [-62.0, -58.0, -45.0])
def test_bleed_in_the_nearest_gap_is_not_room_tone(tmp_path: Path, bleed_db: float) -> None:
    # A peer's voice leaks into the host's mic after "you": 8 to 25 dB over the -70 floor
    # and 38 to 60 dB under the host's own speech. It is the nearest stretch to the cut,
    # so only the sampler's checks stand between it and the fill.
    host = _host_audio()
    _add_voice(host, 5.0, 7.0, bleed_db)
    project = _project(tmp_path, host=host)

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    # The floor before the untranscribed speech is the nearest stretch that is not bleed.
    assert fill is not None
    assert (fill.start_s, fill.end_s, fill.source_id) == (
        pytest.approx(1.95),
        pytest.approx(2.45),
        None,
    )


def test_a_failing_voice_detector_leaves_the_fill_silent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class BrokenVad:
        def speech_probs(self, audio: np.ndarray) -> np.ndarray:
            raise RuntimeError("onnx session failed")

    monkeypatch.setattr("podcast_mcp.engines.vad_silero.get_shared_vad", lambda: BrokenVad())
    project = _project(tmp_path, host=_host_audio())

    assert mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5) is None


# A room's reverb: a word's voice decays 60 dB in 0.3 s after it stops, and opens over
# 80 ms from 60 dB down. Both edges cross the floor's level while still voice.
ATTACK_SEC = 0.08
DECAY_DB_PER_SEC = 200.0


def _add_word(samples: np.ndarray, start: float, end: float, level_db: float) -> None:
    """A 140 Hz harmonic voice at ``level_db`` over ``[start, end)``, with an attack and tail."""
    tail_sec = 120.0 / DECAY_DB_PER_SEC
    i0, i2 = round(start * SR), min(samples.size, round((end + tail_sec) * SR))
    t = np.arange(i2 - i0) / SR
    voice = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 9))
    held = t < end - start
    voice *= 10 ** (level_db / 20) / np.sqrt(np.mean(voice[held] ** 2))
    envelope_db = np.where(held, 0.0, -DECAY_DB_PER_SEC * (t - (end - start)))
    opening = t < ATTACK_SEC
    envelope_db[opening] = -60.0 * (1.0 - t[opening] / ATTACK_SEC)
    samples[i0:i2] += voice * 10 ** (envelope_db / 20)


@pytest.fixture
def no_voice_detector(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("podcast_mcp.engines.vad_silero.get_shared_vad", lambda: None)


WORDS_WITH_TAILS = ((1.0, 1.5), (2.5, 3.2), (4.0, 4.5), (6.4, 7.0))


def _gated_steady_word() -> np.ndarray:
    guest = np.zeros(round(DURATION_SEC * SR))
    _add_voice(guest, 6.0, 7.0, VOICE_DB)
    return guest


def _gated_voice(start: float, end: float) -> np.ndarray:
    guest = np.zeros(round(DURATION_SEC * SR))
    _add_voice(guest, start, end, -25.0)
    return guest


def _gated_talker() -> np.ndarray:
    # Speech on 60% of the track; the gate passes each word's attack and reverb tail
    # until it falls under the 16-bit floor, then digital silence.
    guest = np.zeros(round(DURATION_SEC * SR))
    for start in np.arange(0.2, DURATION_SEC - 1.0, 1.0):
        _add_word(guest, start, start + 0.6, VOICE_DB)
    return guest


@pytest.mark.usefixtures("no_voice_detector")
@pytest.mark.parametrize(
    ("guest", "cause"),
    [(_gated_steady_word(), "gated_live"), (_gated_talker(), "no_quiet_run")],
    ids=["word", "talker"],
)
def test_a_gated_track_has_no_room_tone_without_a_voice_detector(
    tmp_path: Path, guest: np.ndarray, cause: str
) -> None:
    project = _project(tmp_path, host=_host_audio(), guest=guest)

    for near in (4.0, 6.5, 8.5):
        selected = room_tone_span(
            project,
            "guest",
            near_sec=near,
            near_source_id=None,
            timeline_sec=near,
            duration_sec=0.3,
        )
        assert isinstance(selected, SampleAbsent)
        assert selected.cause == cause
    # The host's room floor is still found without the detector.
    assert isinstance(
        room_tone_span(
            project, "host", near_sec=4.0, near_source_id=None, timeline_sec=4.0, duration_sec=0.3
        ),
        OwnQuietSample,
    )


@pytest.mark.usefixtures("no_voice_detector")
@pytest.mark.parametrize("near_sec", [1.5, 2.5, 3.2, 4.5, 6.4])
@pytest.mark.parametrize("duration_sec", [0.3, 0.5])
def test_word_onsets_and_tails_are_never_room_tone(
    tmp_path: Path, near_sec: float, duration_sec: float
) -> None:
    host = _noise(FLOOR_DB, seed=1054)
    for start, end in WORDS_WITH_TAILS:
        _add_word(host, start, end, VOICE_DB)
    project = _project(tmp_path, host=host)

    span = room_tone_span(
        project,
        "host",
        near_sec=near_sec,
        near_source_id=None,
        timeline_sec=near_sec,
        duration_sec=duration_sec,
    )

    assert isinstance(span, OwnQuietSample)
    start, end = span.sample.start, span.sample.end
    # A word is audible from its start until its tail falls 10 dB under the floor.
    tail_sec = (VOICE_DB - (FLOOR_DB - 10.0)) / DECAY_DB_PER_SEC
    heard = [(s, e + tail_sec) for s, e in WORDS_WITH_TAILS]
    assert [(s, e) for s, e in heard if start < e and s < end] == []


def _host_timeline(project: EpisodeProject) -> list[tuple[float, float]]:
    clips = sorted(
        (c for c in project.clips if c.track_id == "host"), key=lambda c: c.timeline_start
    )
    return [(round(c.timeline_start, 3), round(c.timeline_end, 3)) for c in clips]


def _padded_filler(replace_gap_sec: float = 0.3, *, next_burst_sec: float = 4.6) -> EditDecision:
    return EditDecision(
        id="um",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=4.0,
        end=4.5,
        boundary_mode="exact",
        review_required=False,
        replace_gap_sec=replace_gap_sec,
        next_burst_sec=next_burst_sec,
        reason="filler:um",
    )


def _talking_all_through() -> np.ndarray:
    track = _noise(FLOOR_DB, seed=1212)
    _add_voice(track, 0.1, DURATION_SEC - 0.1, VOICE_DB)
    return track


def _chopped_by_speech() -> np.ndarray:
    track = _noise(FLOOR_DB, seed=1213)
    for start in np.arange(0.0, DURATION_SEC, 0.5):
        _add_voice(track, start + 0.05, start + 0.42, VOICE_DB)
    return track


@pytest.mark.parametrize("live_host", [_talking_all_through, _chopped_by_speech])
def test_a_live_track_with_no_room_tone_gets_a_silent_pad(
    tmp_path: Path, live_host: Callable[[], np.ndarray]
) -> None:
    project = _project(tmp_path, host=live_host(), guest=_gated_steady_word())
    project.edit_decisions = [
        _padded_filler(next_burst_sec=4.55 if live_host is _chopped_by_speech else 4.6)
    ]

    assert approve_edits(project, ["um"], defaults=load_defaults()) == 1

    record = project.editorial.edit_log[-1]
    assert record.params["pad_samples"] == []
    assert record.params["per_track_source"].keys() == {"host", "guest"}
    assert _host_timeline(project) == [(0.0, 4.0), (4.3, 9.8)]
    assert project.edit_decisions == []


@pytest.mark.parametrize(
    "cause,sentence",
    [
        ("media_extent_unavailable", "Host has a recording whose length is unknown"),
        ("effect_source_geometry", "Host does not play as one continuous piece at the join"),
        ("never_heard_of_it", "Host could not be checked"),
    ],
)
def test_a_lane_problem_reads_as_a_sentence(cause: str, sentence: str) -> None:
    held = CutScopeHold("um", ("host",), "pause_air", (LaneUnavailable("host", cause),))

    message = str(ScopeChangedAtApproval([held], {"host": "Host"}, {"um": "Host's cut at 0:04.0"}))

    assert message == (
        "Host's cut at 0:04.0 was not applied because the pause cannot retain enough original "
        f"quiet audio safely ({sentence}). "
        "Select the part to cut on the timeline, or reject the held cuts. "
        "To apply it as is, repeat the call with the audio-check override "
        "(CLI --override-audio-checks, MCP override_audio_checks=true)."
    )


def test_a_gated_track_keeps_its_silent_pad_while_the_live_track_gets_room_tone(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path, host=_host_audio(), guest=_gated_steady_word())
    project.edit_decisions = [_padded_filler()]

    assert approve_edits(project, ["um"], defaults=load_defaults()) == 1

    record = project.editorial.edit_log[-1]
    assert {s["track_id"] for s in record.params["pad_samples"]} == {"host"}
    assert record.params["per_track_source"].keys() == {"host", "guest"}


@pytest.mark.usefixtures("no_voice_detector")
def test_without_the_voice_detector_a_live_room_still_gets_its_pad(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio(), guest=_gated_steady_word())
    project.edit_decisions = [_padded_filler()]

    assert approve_edits(project, ["um"], defaults=load_defaults()) == 1

    record = project.editorial.edit_log[-1]
    assert {s["track_id"] for s in record.params["pad_samples"]} == {"host"}


def test_every_live_track_gets_its_own_room_tone_in_the_pad(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio(), guest=_noise(-64.0, seed=2))
    project.edit_decisions = [_padded_filler()]

    assert approve_edits(project, ["um"], defaults=load_defaults()) == 1

    record = project.editorial.edit_log[-1]
    assert {s["track_id"] for s in record.params["pad_samples"]} == {"host", "guest"}


def test_a_pause_trim_over_source_a_pad_replays_is_held_not_a_hull(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())
    project.edit_decisions = [_padded_filler()]
    assert approve_edits(project, ["um"], defaults=load_defaults()) == 1
    sample = project.editorial.edit_log[-1].params["pad_samples"][0]
    replayed = (sample["source_start"], sample["source_end"])
    assert replayed == (pytest.approx(5.15), pytest.approx(5.45))
    project.edit_decisions = [
        EditDecision(
            id="pause",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=5.05,
            end=6.5,
            boundary_mode="exact",
            review_required=False,
            reason="pause:1.45s:solo",
        )
    ]
    before = project.model_dump()

    with pytest.raises(ScopeChangedAtApproval) as held:
        approve_edits(project, ["pause"], defaults=load_defaults())

    assert held.value.held[0].reason == "source_geometry"
    assert project.model_dump() == before


def test_room_tone_is_picked_once_and_recorded_with_the_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio())
    assert room_tone.read_room_tone_pool(project, "host") is None

    pool = room_tone.record_room_tone_pool(project, "host")
    assert pool
    assert all(
        not any(s < x.end and x.start < e for _, s, e in WORDS)
        and not (x.end > 2.6 and x.start < 3.9)
        for x in pool
    )

    # A later process reads the record: no decode, no measuring, no picking again.
    room_tone._POOLS.clear()

    def refuse(*_args, **_kwargs):
        raise AssertionError("a recorded pool must not read audio")

    monkeypatch.setattr(room_tone, "track_floor", refuse)
    monkeypatch.setattr(room_tone, "load_mono_window", refuse)
    monkeypatch.setattr(room_tone, "_pick_sample", refuse)
    assert room_tone.record_room_tone_pool(project, "host") == pool

    nearest = room_tone_span(
        project, "host", near_sec=4.25, near_source_id=None, timeline_sec=4.25, duration_sec=0.3
    )
    assert isinstance(nearest, OwnQuietSample)
    assert any(x.start <= nearest.sample.start and nearest.sample.end <= x.end for x in pool)
    avoided = (nearest.sample.start - 0.01, nearest.sample.end + 0.01)
    other = room_tone_span(
        project,
        "host",
        near_sec=4.25,
        near_source_id=None,
        timeline_sec=4.25,
        duration_sec=0.3,
        avoid=[avoided],
    )
    assert isinstance(other, OwnQuietSample)
    assert other.sample.end <= avoided[0] or other.sample.start >= avoided[1]


def test_a_replaced_recording_is_picked_again(tmp_path: Path) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio())
    room_tone.record_room_tone_pool(project, "host")
    room_tone._POOLS.clear()
    assert room_tone.read_room_tone_pool(project, "host") is not None

    _write_wav(tmp_path / "raw" / "host.wav", _host_audio(floor_db=-65.0))
    assert room_tone.read_room_tone_pool(project, "host") is None


def test_a_pool_is_not_picked_without_the_voice_detector(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio())
    monkeypatch.setattr(room_tone, "_voice_detector_missing", lambda: True)

    def refuse(*_args, **_kwargs):
        raise AssertionError("no detector: the recording must not be decoded to find that out")

    monkeypatch.setattr(room_tone, "track_floor", refuse)
    assert room_tone.record_room_tone_pool(project, "host") is None
    assert room_tone.read_room_tone_pool(project, "host") is None


def test_the_pool_digest_changes_once_a_pool_is_recorded(tmp_path: Path) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio())
    before = room_tone.room_tone_pool_digest(project)
    room_tone.record_room_tone_pool(project, "host")

    assert before == ""
    assert room_tone.room_tone_pool_digest(project) != before


def test_a_long_recording_gets_an_anchor_about_every_minute(tmp_path: Path) -> None:
    from podcast_mcp.engines import room_tone

    assert room_tone.POOL_ANCHORS_MIN <= room_tone.POOL_ANCHORS_MAX
    project = _project(tmp_path, host=_host_audio())
    pool = room_tone.record_room_tone_pool(project, "host")
    assert pool is not None and len(pool) <= room_tone.POOL_ANCHORS_MIN


def test_the_in_memory_pools_are_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.engines import room_tone

    monkeypatch.setattr(room_tone, "_POOLS_KEPT", 3)
    monkeypatch.setattr(room_tone, "_POOLS", {})
    for index in range(6):
        room_tone._remember_pool((f"/f{index}", (1, 1, 1, index), ()), ())
    assert [key[0] for key in room_tone._POOLS] == ["/f3", "/f4", "/f5"]


def test_ensure_pools_records_once_and_skips_unreadable_tracks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio())
    room_tone.ensure_room_tone_pools(project, ["host", "missing", "host"])
    pool = room_tone.read_room_tone_pool(project, "host")
    assert pool is not None

    def refuse(*_args, **_kwargs):
        raise AssertionError("a recorded pool must not be picked again")

    monkeypatch.setattr(room_tone, "track_floor", refuse)
    room_tone.ensure_room_tone_pools(project, ["host"])
    assert room_tone.read_room_tone_pool(project, "host") == pool


def test_scheduling_a_pool_records_it_in_the_background_once(tmp_path: Path) -> None:
    import threading

    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio())
    assert room_tone.schedule_room_tone_pool(project, "host") is True
    for thread in threading.enumerate():
        if thread.name == "room-tone-pool-host":
            thread.join(60)
    assert room_tone.read_room_tone_pool(project, "host") is not None
    assert room_tone.schedule_room_tone_pool(project, "host") is False
    assert room_tone.schedule_room_tone_pool(project, "missing") is False


def test_a_peer_voice_bleeding_below_the_level_checks_is_not_room_tone(tmp_path: Path) -> None:
    # A peer's voice reaches the host mic 2 dB over its floor, nearest to the cut, under every
    # level check, so only the envelope test catches it.
    guest = _noise(-64.0, seed=2)
    _add_voice(guest, 5.0, 7.0, -25.0)
    host = _host_audio()
    _add_voice(host, 5.0, 7.0, -68.0)
    project = _project(tmp_path, host=host, guest=guest)

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert fill.end_s <= 5.0 or fill.start_s >= 7.0


def _aligned(project: EpisodeProject, host_shift: float, guest_shift: float) -> None:
    for clip in project.clips:
        clip.timeline_start = {"host": host_shift, "guest": guest_shift}[clip.track_id]
    _record_alignment(project, host_shift, guest_shift)


def _record_alignment(project: EpisodeProject, host_shift: float, guest_shift: float) -> None:
    project.meta.ingest_alignment = {
        "Host": SpeakerIngestAlignment.from_source_to_timeline_shift(
            host_shift, align_method="test"
        ),
        "Guest": SpeakerIngestAlignment.from_source_to_timeline_shift(
            guest_shift, align_method="test"
        ),
    }


def _bleed_pair(guest_voice: tuple[float, float]) -> tuple[np.ndarray, np.ndarray]:
    host = _host_audio()
    _add_voice(host, 5.0, 7.0, -68.0)
    guest = _noise(-64.0, seed=2)
    _add_voice(guest, *guest_voice, -25.0)
    return host, guest


def test_a_peer_voice_that_lines_up_after_the_ingest_shift_is_not_room_tone(
    tmp_path: Path,
) -> None:
    host, guest = _bleed_pair((7.0, 9.0))
    project = _project(tmp_path, host=host, guest=guest)
    _aligned(project, host_shift=2.0, guest_shift=0.0)

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert (fill.start_s, fill.end_s) == pytest.approx((1.95, 2.45))


def test_a_peer_voice_that_only_lines_up_at_the_same_raw_second_is_not_evidence(
    tmp_path: Path,
) -> None:
    host, guest = _bleed_pair((5.0, 7.0))
    project = _project(tmp_path, host=host, guest=guest)
    _aligned(project, host_shift=2.0, guest_shift=0.0)

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert (fill.start_s, fill.end_s) == pytest.approx((5.15, 5.65))


def test_a_changed_ingest_shift_makes_the_pool_be_picked_again(tmp_path: Path) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio(), guest=_noise(-64.0, seed=2))
    _aligned(project, host_shift=2.0, guest_shift=0.0)
    assert room_tone.record_room_tone_pool(project, "host")
    assert room_tone.read_room_tone_pool(project, "host") is not None

    _aligned(project, host_shift=2.0, guest_shift=1.0)

    assert room_tone.read_room_tone_pool(project, "host") is None


def test_ingest_entries_relate_the_files_whatever_the_first_clips_are_placed_at(
    tmp_path: Path,
) -> None:
    from podcast_mcp.engines import room_tone

    host, guest = _bleed_pair((3.0, 5.0))
    project = _project(tmp_path, host=host, guest=guest)
    for clip in project.clips:
        clip.source_start = {"host": 3.0, "guest": 1.0}[clip.track_id]
    _record_alignment(project, host_shift=0.0, guest_shift=2.0)

    assert room_tone._ingest_shift(project, "guest") == pytest.approx(2.0)
    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert (fill.start_s, fill.end_s) == pytest.approx((1.95, 2.45))


def _host_clips(project: EpisodeProject, ids: tuple[str, ...], shift: float) -> None:
    project.clips = [c for c in project.clips if c.track_id != "host"]
    for i, clip_id in enumerate(ids):
        project.clips.append(
            Clip(
                id=clip_id,
                track_id="host",
                source_start=float(i),
                source_end=float(i) + 1.0,
                timeline_start=float(i) + shift,
            )
        )


def _per_clip_entry(shift: float) -> SpeakerIngestAlignment:
    return SpeakerIngestAlignment.from_source_to_timeline_shift(shift, align_method="test")


def test_a_split_clip_without_its_own_entry_uses_the_shift_the_others_agree_on(
    tmp_path: Path,
) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio(), guest=_noise(-64.0, seed=2))
    _host_clips(project, ("b", "c"), shift=2.0)
    project.meta.ingest_alignment = {"host:a": _per_clip_entry(2.0), "host:d": _per_clip_entry(2.0)}

    assert room_tone._ingest_shift(project, "host") == pytest.approx(2.0)


def test_a_split_clip_without_its_own_entry_falls_back_when_the_others_disagree(
    tmp_path: Path,
) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio(), guest=_noise(-64.0, seed=2))
    _host_clips(project, ("b", "c"), shift=2.0)
    project.meta.ingest_alignment = {"host:a": _per_clip_entry(2.0), "host:d": _per_clip_entry(3.0)}

    assert room_tone._ingest_shift(project, "host") == 0.0


def test_ingest_shift_resolves_each_source_once_however_many_clips(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio(), guest=_noise(-64.0, seed=2))
    _aligned(project, host_shift=2.0, guest_shift=0.0)
    project.clips.extend(
        Clip(
            id=f"x{i}",
            track_id="host",
            source_start=0.0,
            source_end=0.5,
            timeline_start=100.0 + i,
            source_id=None,
        )
        for i in range(300)
    )
    resolved: list[str | None] = []
    original = EpisodeProject.equivalent_source_ids

    def counting(self: EpisodeProject, track_id: str, source_id: str | None) -> object:
        resolved.append(source_id)
        return original(self, track_id, source_id)

    monkeypatch.setattr(EpisodeProject, "equivalent_source_ids", counting)

    assert room_tone._ingest_shift(project, "host") == pytest.approx(2.0)
    assert len(resolved) <= 1

    project.meta.ingest_alignment = None
    resolved.clear()

    assert room_tone._ingest_shift(project, "host") == 0.0
    assert resolved == []


def test_a_music_track_is_not_a_peer_whose_voice_can_bleed(tmp_path: Path) -> None:
    from podcast_mcp.engines import room_tone

    host, guest = _bleed_pair((5.0, 7.0))
    project = _project(tmp_path, host=host, guest=guest)
    project.tracks[1].role = TrackRole.MUSIC

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert (fill.start_s, fill.end_s) == pytest.approx((5.15, 5.65))
    key = room_tone._pool_key(project, "host")
    assert key is not None
    assert key[2] == ()


POOL = (
    Sample(0.0, 2.0, -75.0, 0.0),
    Sample(10.0, 12.0, -75.0, 0.0),
    Sample(20.0, 22.0, -75.0, 0.0),
)


def _pooled_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pool: tuple[Sample, ...]
) -> EpisodeProject:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio())
    _write_wav(tmp_path / "raw" / "later.wav", _noise(FLOOR_DB, seed=2265))
    project.sources.append(
        SourceRecording(
            id="later",
            path="raw/later.wav",
            duration_sec=DURATION_SEC,
            sample_rate=SR,
            channels=1,
        )
    )
    monkeypatch.setattr(room_tone, "read_room_tone_pool", lambda _project, _track: pool)
    return project


def _add_pad_clip(project: EpisodeProject, selected: OwnQuietSample, timeline_start: float) -> None:
    project.clips.append(
        Clip(
            id=f"pad{len(project.clips)}",
            track_id="host",
            source_start=selected.sample.start,
            source_end=selected.sample.end,
            timeline_start=timeline_start,
        )
    )


def _cut(
    project: EpisodeProject, near: float, timeline: float, source_id: str | None
) -> OwnQuietSample:
    selected = room_tone_span(
        project,
        "host",
        near_sec=near,
        near_source_id=source_id,
        timeline_sec=timeline,
        duration_sec=0.5,
    )
    assert isinstance(selected, OwnQuietSample)
    return selected


def test_later_recording_cuts_within_two_minutes_take_different_samples(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, POOL)

    first = _cut(project, 2300.0, 1000.0, "later")
    _add_pad_clip(project, first, 1000.0)
    nearby = _cut(project, 2371.0, 1071.0, "later")
    distant = _cut(project, 2600.0, 1300.0, "later")

    assert POOL[2].start <= first.sample.start < POOL[2].end
    assert (nearby.sample.start, nearby.sample.end) != (first.sample.start, first.sample.end)
    assert POOL[0].start <= nearby.sample.start < POOL[0].end
    assert POOL[1].start <= distant.sample.start < POOL[1].end


def test_distant_cuts_on_a_later_recording_spread_over_the_pool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, POOL)

    picks = [_cut(project, 2300.0, t, "later").sample for t in (1000.0, 1300.0, 1450.0)]

    assert [(x.start, x.end) for x in picks] == [(20.75, 21.25), (10.75, 11.25), (0.75, 1.25)]


def test_a_pool_sample_cut_down_by_an_avoid_to_a_quarter_second_is_still_tiled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, (Sample(0.0, 2.0, -75.0, 0.0),))

    selected = room_tone_span(
        project,
        "host",
        near_sec=1.0,
        near_source_id=None,
        timeline_sec=1.0,
        duration_sec=0.5,
        avoid=[(0.0, 1.75), (2.0, 10.0)],
    )

    assert isinstance(selected, OwnQuietSample)
    assert (selected.sample.start, selected.sample.end) == (1.75, 2.0)


def test_a_quarter_second_vetted_sample_is_tiled_for_a_longer_pad_without_a_pool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines import room_tone

    host = _noise(FLOOR_DB, seed=1054)
    for start in (0.0, 1.05, 2.1, 3.15, 4.2, 5.25, 6.3, 7.35, 8.4, 9.45):
        _add_voice(host, start, min(start + 0.5, DURATION_SEC), VOICE_DB)
    project = _project(tmp_path, host=host)
    monkeypatch.setattr(room_tone, "read_room_tone_pool", lambda _project, _track: ())

    selected = room_tone_span(
        project, "host", near_sec=3.3, near_source_id=None, timeline_sec=3.3, duration_sec=0.6
    )

    assert isinstance(selected, OwnQuietSample)
    assert (selected.sample.start, selected.sample.end) == pytest.approx((2.75, 3.0))


def test_every_recorded_pool_sample_is_at_least_one_second(tmp_path: Path) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio())
    pool = room_tone.record_room_tone_pool(project, "host")

    assert len(pool) == 6
    assert (pool[0].start, pool[0].end) == pytest.approx((5.15, 7.15))
    assert all(x.end - x.start >= 1.0 - 1e-9 for x in pool)


def test_a_later_recording_cut_with_no_pool_picks_from_the_first_quiet_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, ())

    selected = _cut(project, 2300.0, 1000.0, "later")

    assert (selected.sample.start, selected.sample.end) == (0.0, 0.5)


def test_nearby_mute_fills_on_a_later_recording_without_a_pool_take_the_same_sample(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, ())
    clip = Clip(
        id="later_clip",
        track_id="host",
        source_id="later",
        source_start=0.0,
        source_end=DURATION_SEC,
        timeline_start=1000.0,
    )
    project.clips.append(clip)

    first = mute_room_tone_fill(project, clip, 4.0, 4.4)
    assert first is not None
    clip.mute_regions.append(ClipMuteRegion(start_s=4.0, end_s=4.4, fill=first))
    second = mute_room_tone_fill(project, clip, 4.6, 5.0)

    assert second is not None
    assert (first.start_s, first.end_s) == (pytest.approx(0.0), pytest.approx(0.4))
    assert (second.start_s, second.end_s) == (pytest.approx(0.0), pytest.approx(0.4))


@pytest.mark.usefixtures("tiling_only")
def test_gaps_filled_in_one_call_take_different_samples(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, POOL)
    project.clips = [
        Clip(id="a", track_id="host", source_start=3.0, source_end=4.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.0, source_end=5.0, timeline_start=5.0),
        Clip(id="c", track_id="host", source_start=5.0, source_end=6.0, timeline_start=10.0),
    ]

    fill_with_room_tone(project, "host", defaults=load_defaults())

    firsts = sorted(
        (c.timeline_start, c.source_start, c.source_end)
        for c in project.clips
        if c.id not in {"a", "b", "c"} and c.timeline_start in (1.0, 6.0)
    )
    assert firsts == [(1.0, 1.75, 2.0), (6.0, 10.0, 10.25)]


def test_a_pool_recorded_before_a_peer_existed_is_rebuilt(tmp_path: Path) -> None:
    from podcast_mcp.engines import room_tone

    project = _project(tmp_path, host=_host_audio())
    assert room_tone.record_room_tone_pool(project, "host")

    _write_wav(tmp_path / "raw" / "guest.wav", _noise(-64.0, seed=2))
    project.tracks.append(
        Track(
            id="guest",
            label="Guest",
            media=MediaAsset(path="raw/guest.wav"),
            role=TrackRole.DIALOGUE,
        )
    )
    assert room_tone.read_room_tone_pool(project, "host") is None

    rebuilt = room_tone.record_room_tone_pool(project, "host")
    assert room_tone.read_room_tone_pool(project, "host") == rebuilt
    _write_wav(tmp_path / "raw" / "guest.wav", _noise(-60.0, seed=3))
    assert room_tone.read_room_tone_pool(project, "host") is None


def test_a_gated_peers_voice_reaching_the_mic_is_not_room_tone(tmp_path: Path) -> None:
    host = _host_audio()
    _add_voice(host, 5.0, 7.0, -68.0)
    project = _project(tmp_path, host=host, guest=_gated_voice(5.0, 7.0))

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert fill.end_s <= 5.0 or fill.start_s >= 7.0


def test_a_long_clip_does_not_count_a_mute_fill_outside_the_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, POOL)
    clip = _host_clip(project)
    clip.source_end = 600.0
    clip.mute_regions.append(
        ClipMuteRegion(start_s=8.0, end_s=8.5, fill=RoomToneFill(start_s=0.0, end_s=0.5))
    )

    far = _cut(project, 1.0, 500.0, None)
    near = _cut(project, 1.0, 20.0, None)

    assert (far.sample.start, far.sample.end) == (0.75, 1.25)
    assert (near.sample.start, near.sample.end) == (10.0, 10.5)


def test_a_pad_clip_that_partly_overlaps_a_pool_sample_counts_as_playing_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, POOL)
    project.clips.append(
        Clip(id="pad", track_id="host", source_start=1.5, source_end=2.5, timeline_start=5.0)
    )

    selected = _cut(project, 1.0, 6.0, None)

    assert (selected.sample.start, selected.sample.end) == (10.0, 10.5)


def test_a_primary_cut_whose_nearest_sample_is_in_use_takes_the_second_nearest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, POOL)

    first = _cut(project, 1.0, 1.0, None)
    _add_pad_clip(project, first, 1.0)
    second = _cut(project, 1.0, 5.0, None)

    assert POOL[0].start <= first.sample.start and first.sample.end <= POOL[0].end
    assert POOL[1].start <= second.sample.start and second.sample.end <= POOL[1].end


def test_a_one_sample_pool_is_still_used_when_that_sample_is_in_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, POOL[:1])

    first = _cut(project, 1.0, 1.0, None)
    _add_pad_clip(project, first, 1.0)
    again = _cut(project, 1.0, 5.0, None)

    assert (again.sample.start, again.sample.end) == (first.sample.start, first.sample.end)


def test_a_mute_fill_ignores_the_fills_and_clips_near_it_on_the_timeline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, POOL)
    clip = _host_clip(project)
    alone = mute_room_tone_fill(project, clip, 1.0, 1.5)

    project.clips.append(
        Clip(id="pad", track_id="host", source_start=0.0, source_end=2.0, timeline_start=5.0)
    )
    clip.mute_regions.append(
        ClipMuteRegion(start_s=8.0, end_s=8.5, fill=RoomToneFill(start_s=0.0, end_s=0.5))
    )
    crowded = mute_room_tone_fill(project, clip, 1.0, 1.5)

    assert alone == RoomToneFill(start_s=1.0, end_s=1.5)
    assert crowded == alone


def test_two_nearby_mute_fills_pick_by_source_position_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pool = (Sample(3.0, 5.0, -75.0, 0.0), Sample(6.0, 8.0, -75.0, 0.0))
    project = _pooled_project(tmp_path, monkeypatch, pool)
    clip = _host_clip(project)

    first = mute_room_tone_fill(project, clip, 4.0, 4.5)
    assert first is not None
    clip.mute_regions.append(ClipMuteRegion(start_s=4.0, end_s=4.5, fill=first))
    second = mute_room_tone_fill(project, clip, 4.6, 5.0)

    assert first == RoomToneFill(start_s=4.0, end_s=4.5)
    assert second == RoomToneFill(start_s=4.6, end_s=5.0)


def test_an_off_clock_mute_fill_rotates_the_pool_by_its_source_position(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _pooled_project(tmp_path, monkeypatch, POOL)
    clip = Clip(
        id="later_clip",
        track_id="host",
        source_id="later",
        source_start=2000.0,
        source_end=2600.0,
        timeline_start=1000.0,
    )
    project.clips.append(clip)

    at_2300 = mute_room_tone_fill(project, clip, 2300.0, 2300.5)
    at_2500 = mute_room_tone_fill(project, clip, 2500.0, 2500.5)

    assert at_2300 is not None
    assert at_2500 is not None
    assert (at_2300.start_s, at_2300.end_s) == pytest.approx((10.75, 11.25))
    assert (at_2500.start_s, at_2500.end_s) == pytest.approx((20.75, 21.25))


def test_a_nearer_window_under_a_loud_peer_loses_to_a_farther_one_where_the_peer_is_quiet(
    tmp_path: Path,
) -> None:
    # The host's mic stays at its floor, so no envelope follows the guest and nothing is
    # rejected; the guest is loud over the nearest quiet stretch and at its floor over the next.
    guest = _noise(-64.0, seed=2)
    _add_voice(guest, 5.0, 8.0, -25.0)
    project = _project(tmp_path, host=_host_audio(), guest=guest)

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert (fill.start_s, fill.end_s) == pytest.approx((1.95, 2.45))


def test_with_no_window_where_the_peer_is_quiet_the_quietest_peer_wins_over_the_nearest(
    tmp_path: Path,
) -> None:
    guest = _noise(-64.0, seed=2)
    _add_voice(guest, 0.0, 5.0, -50.0)
    _add_voice(guest, 5.0, 10.0, -25.0)
    project = _project(tmp_path, host=_host_audio(), guest=guest)

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert (fill.start_s, fill.end_s) == pytest.approx((1.95, 2.45))


def test_a_peer_file_that_does_not_cover_a_window_ranks_it_after_one_it_covers(
    tmp_path: Path,
) -> None:
    guest = _noise(-64.0, seed=2)[: SR * 5]
    _add_voice(guest, 0.0, 3.0, -50.0)
    project = _project(tmp_path, host=_host_audio(), guest=guest)

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert (fill.start_s, fill.end_s) == pytest.approx((1.95, 2.45))


def test_a_peer_recording_that_ends_early_does_not_reject_later_room_tone(tmp_path: Path) -> None:
    guest = _noise(-64.0, seed=2)[: SR // 5]
    project = _project(tmp_path, host=_host_audio(), guest=guest)

    fill = mute_room_tone_fill(project, _host_clip(project), 4.0, 4.5)

    assert fill is not None
    assert (fill.start_s, fill.end_s) == pytest.approx((5.15, 5.65))


def test_a_cut_decision_near_a_fill_join_does_not_rewrite_the_fill_crossfade(
    tmp_path: Path, tiling_only: None
) -> None:
    from podcast_mcp.edits.cut_application import _write_join_fades

    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, _noise(-62.0, seed=7)[: 3 * SR])
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.5, source_end=10.0, timeline_start=4.0),
    ]
    insert_room_tone_pad(project, 4.0, 20.0, defaults=load_defaults())
    pads = sorted(
        (c for c in project.clips if c.source_id == "room-tone-host"),
        key=lambda c: c.timeline_start,
    )
    join = pads[0].source_end
    before = [(c.join_in_mode, c.fade_in_ms, c.fade_out_ms) for c in pads]

    _write_join_fades(
        project,
        [
            EditDecision(
                id="d",
                track_id="host",
                type=EditDecisionType.REMOVE,
                start=join - 1.0,
                end=join + 0.01,
                crossfade_ms=10,
            )
        ],
        defaults=load_defaults(),
    )

    assert [(c.join_in_mode, c.fade_in_ms, c.fade_out_ms) for c in pads] == before


def test_a_rewind_join_in_the_same_source_is_not_a_cut(tmp_path: Path) -> None:
    from podcast_mcp.edits.cut_application import _write_join_fades

    project = _project(tmp_path, host=_host_audio())
    project.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=2.0,
            source_end=3.0,
            timeline_start=0.0,
            fade_out_ms=40,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.0,
            fade_in_ms=40,
            join_in_mode=ClipJoinMode.CROSSFADE,
        ),
    ]

    result = _write_join_fades(
        project,
        [EditDecision(id="d", track_id="host", start=2.9, end=3.0, crossfade_ms=10)],
        defaults=load_defaults(),
    )

    assert result["affected_tracks"] == []
    assert project.clips[1].join_in_mode == ClipJoinMode.CROSSFADE
