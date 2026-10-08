"""A session's rooms and sounds, read once and laid on the session clock (``edits/session_air.py``, #1055)."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.breath_detect import PauseAir, pause_air_span
from podcast_mcp.edits.session_air import (
    Placement,
    SessionAir,
    lane_placements,
    primary_media,
)
from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole
from test_breath_detect import (
    _FLOOR_RMS,
    _SPEECH_RMS,
    _dbfs,
    _fixture_words,
    _harmonic_tone,
    _host_project,
    _shaped_noise,
    _with_guest,
)
from test_pause_air_session import _gated, _long_track, _reader

RATE = 16_000


def _project_with_lanes(**lanes: list[tuple[float, float, float]]) -> EpisodeProject:
    project = EpisodeProject.create("lanes", "/tmp/ws")
    for track_id, clips in lanes.items():
        project.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=30.0),
            )
        )
        project.clips.extend(
            Clip(
                id=f"{track_id}{i}",
                track_id=track_id,
                source_start=a,
                source_end=b,
                timeline_start=at,
            )
            for i, (a, b, at) in enumerate(clips)
        )
    return project


def test_a_lane_plays_its_clips_in_timeline_order_and_abutting_clips_are_one() -> None:
    project = _project_with_lanes(host=[(10.0, 12.0, 5.0), (0.0, 2.0, 0.0), (2.0, 3.0, 2.0)])

    got = lane_placements(project, project.track_by_id("host"))

    assert [(p.tl_start, p.tl_end, p.src_start, p.src_end) for p in got] == [
        (0.0, 3.0, 0.0, 3.0),
        (5.0, 7.0, 10.0, 12.0),
    ]


def test_clips_that_abut_in_the_lane_but_not_in_the_source_are_two_stretches() -> None:
    project = _project_with_lanes(host=[(0.0, 2.0, 0.0), (5.0, 6.0, 2.0)])

    got = lane_placements(project, project.track_by_id("host"))

    assert [(p.tl_start, p.src_start) for p in got] == [(0.0, 0.0), (2.0, 5.0)]


def test_a_lane_with_no_clips_plays_its_media_from_the_start_of_the_session() -> None:
    project = _project_with_lanes(host=[])
    host = project.track_by_id("host")

    (only,) = lane_placements(project, host)

    assert (only.tl_start, only.src_start, only.media) == (0.0, 0.0, primary_media(project, host))
    assert only.tl_end == float("inf")
    host.timeline_empty = True
    assert lane_placements(project, host) == []


def test_a_placement_maps_source_seconds_to_the_session_clock() -> None:
    placement = Placement("host", None, None, tl_start=5.0, tl_end=8.0, src_start=10.0)

    assert placement.to_session(11.5) == 6.5
    assert placement.src_end == 13.0


def test_a_sound_a_placement_edge_cuts_reaches_a_frame_past_the_edge() -> None:
    # The guest's lane is cut at session 4.9 and plays on from source 5.5: its word at
    # source 4.7 to 5.0 is cut by the edge, so the join is inside it, not beside it.
    word = _harmonic_tone(4800, _SPEECH_RMS)
    project = _with_guest(_host_project(_fixture_words()))
    project.clips = [c for c in project.clips if c.track_id != "guest"] + [
        Clip(id="g0", track_id="guest", source_start=0.0, source_end=4.9, timeline_start=0.0),
        Clip(id="g1", track_id="guest", source_start=5.5, source_end=30.0, timeline_start=4.9),
    ]
    reader = _reader(host=_gated(), guest=_gated((word, 4.7)))

    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=reader):
        sounds = SessionAir(project).sounds_in(4.8, 5.1)

    guests = [s for s in sounds if s.lo > 4.5 and s.hi > 4.9 and s.lo < 4.9]
    assert any(s.hi == pytest.approx(4.91) for s in guests)


def test_the_same_stretch_asked_for_in_two_windows_holds_the_same_sounds() -> None:
    # The sounds of a recording are read once for the whole recording: a window shows the
    # ones in it, never different ones for being asked about at a different place.
    word = _harmonic_tone(4800, _SPEECH_RMS)
    project = _with_guest(_host_project(_fixture_words()))
    reader = _reader(host=_gated((word, 6.0)), guest=_gated((word, 8.0)))

    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=reader):
        air = SessionAir(project)
        wide = air.sounds_in(5.0, 9.0)
        narrow = air.sounds_in(5.8, 6.4)

    inside = [s for s in wide if s.hi > 5.8 and s.lo < 6.4]
    assert narrow and sorted(narrow) == sorted(inside)


def test_a_quiet_sound_far_from_the_tracks_speech_is_still_removed_whole() -> None:
    # The track speaks only in the first 30 s; the blip 66 s in is 43 dB under that speech.
    # A speech level read from the frames around a pause would see no speech there at all.
    rate = RATE
    signal = _shaped_noise(100 * rate, _FLOOR_RMS, rate)
    tone = _harmonic_tone(4800, _SPEECH_RMS)
    words = [(f"w{i}", i * 0.35, i * 0.35 + 0.3) for i in range(85)]
    for _, at, _end in words:
        signal[round(at * rate) : round(at * rate) + tone.size] = tone
    blip = _shaped_noise(round(0.13 * rate), _dbfs(-58.0), rate)
    signal[round(66.0 * rate) : round(66.0 * rate) + blip.size] = blip

    def window(path, start_sec, duration_sec, sample_rate=16000):
        i = round(start_sec * sample_rate)
        return signal[i : i + round(duration_sec * sample_rate)]

    project = _host_project(words)
    project.tracks[0].media.duration_sec = 100.0
    project.clips[0].source_end = 100.0
    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=window):
        got = pause_air_span(project, "host", 62.2, 70.8)

    assert isinstance(got, PauseAir) and got.span == pytest.approx((62.2, 70.8))


def test_a_recording_with_no_duration_in_its_media_is_read_to_where_its_audio_ends() -> None:
    # Neither track's media carries a duration. The guest still has a speech level (from its
    # words), so a blip 43 dB under it goes whole, and a hum at its speech level splits the air.
    from podcast_mcp.models import Transcript, TranscriptWord

    words, _ = _long_track(26.0)
    _, host = _long_track(20.0, blip_db=-90.0)
    _, quiet_guest = _long_track(26.0)
    _, loud_guest = _long_track(26.0, blip_db=-20.0)
    project = _with_guest(_host_project(words))
    for clip in project.clips:
        clip.source_end = 40.0
    for track in project.tracks:
        track.media.duration_sec = None
    project.transcripts.append(
        Transcript(
            track_id="guest", words=[TranscriptWord(text=t, start=a, end=b) for t, a, b in words]
        )
    )

    def run(guest):
        with patch(
            "podcast_mcp.edits.session_air.load_mono_window",
            side_effect=_reader(host=host, guest=guest),
        ):
            return pause_air_span(project, "host", 25.2, 30.8)

    assert run(quiet_guest).span == pytest.approx((25.2, 30.8))
    assert run(loud_guest).start >= 26.13


def test_a_track_is_read_through_the_decode_the_run_already_holds() -> None:
    # The caller's decoded track is used as it is: no file is opened for it.
    rate = RATE
    samples = _shaped_noise(12 * rate, _FLOOR_RMS, rate)
    tone = _harmonic_tone(4800, _SPEECH_RMS)
    for at in (0.0, 0.6, 1.2, 1.8):
        samples[round(at * rate) : round(at * rate) + tone.size] = tone
    cache = TrackAudioCache(
        jump=TrackRmsCache(samples[::2], sample_rate=8000),
        waveform=TrackRmsCache(samples, sample_rate=rate),
    )
    words = [(f"w{i}", 0.6 * i, 0.6 * i + 0.3) for i in range(4)]
    project = _host_project(words)

    def unreadable(path, start_sec, duration_sec, sample_rate=16000):
        raise AssertionError("a file was opened")

    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=unreadable):
        got = pause_air_span(project, "host", 3.0, 8.0, audio_caches={"host": cache})

    assert got == PauseAir(3.0, 8.0)
