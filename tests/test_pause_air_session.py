"""A pause trim is a session ripple: every track is read where the ripple removes it (#1055).

A ripple removes session time. Each recording sits on the timeline wherever ingest or
alignment put it, so the stretch of a peer that goes is not the trim track's own source
seconds, and a peer can hold no audio under part of the span. One rule judges every track
the ripple cuts, so the same stretch of shared air gets the same answer from each track.
"""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.edits.breath_detect import PauseAir, PauseAirSkip, _track_sounds, pause_air_span
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole
from test_breath_detect import (
    _FLOOR_RMS,
    _SPEECH_RMS,
    _fake_windows,
    _fixture_words,
    _harmonic_tone,
    _host_project,
)

_PAUSE = (4.3, 5.45)
_CUT = (4.4, 5.3)


def _project(
    *,
    host_at: float = 0.0,
    guest_clips: tuple[tuple[float, float, float], ...] = ((0.0, 30.0, 0.0),),
):
    """The fixture host (placed ``host_at`` s into the session) and a guest whose clips are
    ``(source_start, source_end, timeline_start)``."""
    project = _host_project(_fixture_words())
    project.clips[0].timeline_start = host_at
    project.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/guest.wav", duration_sec=30.0),
        )
    )
    project.clips.extend(
        Clip(id=f"g{i}", track_id="guest", source_start=a, source_end=b, timeline_start=at)
        for i, (a, b, at) in enumerate(guest_clips)
    )
    return project


def _gated(*placed: tuple[np.ndarray, float]):
    """A gated second mic: digital silence with only ``placed`` blobs (``(samples, at)``)."""

    def window(path, start_sec, duration_sec, sample_rate=16000):
        signal = np.zeros(round(40.0 * sample_rate), dtype=np.float32)
        for blob, at in placed:
            i = round(at * sample_rate)
            signal[i : i + blob.size] = blob
        i = round(start_sec * sample_rate)
        return signal[i : i + round(duration_sec * sample_rate)]

    return window


def _air(project, own: str, cut, *, host, guest, pause=_PAUSE):
    def windows(path, start_sec, duration_sec, sample_rate=16000):
        reader = guest if "guest" in str(path) else host
        return reader(path, start_sec, duration_sec, sample_rate)

    with patch("podcast_mcp.edits.breath_detect.load_mono_window", side_effect=windows):
        got = pause_air_span(project, own, *cut, pause=pause)
    return got.span if isinstance(got, PauseAir) else got


@pytest.mark.parametrize("offset", [0.05, 0.5, 2.0])
def test_a_peer_is_read_where_the_ripple_removes_it_when_the_tracks_are_offset(offset) -> None:
    # The host sits `offset` s into the session, the guest at its start. The guest's word
    # runs from 100 ms before to 100 ms after the trim's start on the SESSION clock; at
    # the trim's own seconds the guest holds nothing. The start moves to the word's end,
    # three frames on, whatever the offset.
    word = _harmonic_tone(3200, _SPEECH_RMS)
    guest = _gated((word, _CUT[0] + offset - 0.1))

    got = _air(
        _project(host_at=offset), "host", _CUT, host=_fake_windows(), guest=guest, pause=_PAUSE
    )

    assert got == pytest.approx((_CUT[0] + 0.13, _CUT[1]))


def test_material_cut_from_a_peers_lane_contributes_no_sound() -> None:
    # The guest's source 4.5 to 6.0 was cut from its lane (clips 0 to 4.5 and 6.0 on,
    # abutting at session 4.5). Its word at source 5.25 to 5.45 is not in the render, so
    # the host's trim end at 5.3 is not inside a sound.
    word = _harmonic_tone(3200, _SPEECH_RMS)
    guest = _gated((word, 5.25))
    project = _project(guest_clips=((0.0, 4.5, 0.0), (6.0, 30.0, 4.5)))

    assert _air(project, "host", _CUT, host=_fake_windows(), guest=guest) == pytest.approx(_CUT)


def test_a_peer_sound_a_clip_boundary_cuts_reaches_a_frame_past_the_join() -> None:
    # The guest's lane joins at session 4.9 (source 4.9, then 5.5): its word at source 4.7
    # to 5.0 is cut at the join, and the trim starting at the join would sit at the cut
    # end of that sound. The edge clears it by a frame.
    word = _harmonic_tone(4800, _SPEECH_RMS)
    guest = _gated((word, 4.7))
    project = _project(guest_clips=((0.0, 4.9, 0.0), (5.5, 30.0, 4.9)))

    got = _air(project, "host", (4.9, 5.3), host=_fake_windows(), guest=guest)

    assert got == pytest.approx((4.91, 5.3))


def test_a_peer_with_no_clip_under_the_span_has_no_sound_in_it() -> None:
    # The guest's lane ends at session 4.0: its word across the trim's end at source 5.25
    # is not in the render.
    word = _harmonic_tone(3200, _SPEECH_RMS)
    guest = _gated((word, 5.25))
    project = _project(guest_clips=((0.0, 4.0, 0.0),))

    assert _air(project, "host", _CUT, host=_fake_windows(), guest=guest) == pytest.approx(_CUT)


def test_a_peer_with_no_recording_to_read_there_is_no_room() -> None:
    project = _project()
    project.tracks[-1].media = None

    assert _air(project, "host", _CUT, host=_fake_windows(), guest=_gated()) == (
        PauseAirSkip.NO_ROOM
    )


def test_both_tracks_judge_a_shared_pause_the_same() -> None:
    # A hum on the guest at 4.6 to 4.7 sits inside the pause both tracks share. The ripple
    # removes the same time from both, so whichever track asks, the hum splits the air
    # and the longer stretch after it is the trim.
    hum = _harmonic_tone(1600, _SPEECH_RMS)
    host = _fake_windows()
    guest = _fake_windows(gap_floor=_FLOOR_RMS, placed=((hum, 4.6),))
    project = _project()
    project.transcripts = [
        project.transcripts[0],
        project.transcripts[0].model_copy(update={"track_id": "guest"}),
    ]

    from_host = _air(project, "host", _CUT, host=host, guest=guest)
    from_guest = _air(project, "guest", _CUT, host=host, guest=guest)

    assert (from_host, from_guest) == (pytest.approx((4.73, 5.3)), pytest.approx((4.73, 5.3)))


def test_the_sounds_a_trim_must_leave_whole_are_reported_on_the_session_clock() -> None:
    # The host sits 0.5 s into the session; the guest's hum at source 4.9 to 5.0 is session
    # 4.9 to 5.0, and the trim reports it as a sound it keeps.
    hum = _harmonic_tone(1600, _SPEECH_RMS)
    guest = _gated((hum, 4.9))
    project = _project(host_at=0.5)

    def windows(path, start_sec, duration_sec, sample_rate=16000):
        reader = guest if "guest" in str(path) else _fake_windows()
        return reader(path, start_sec, duration_sec, sample_rate)

    with patch("podcast_mcp.edits.breath_detect.load_mono_window", side_effect=windows):
        got = pause_air_span(project, "host", *_CUT, pause=_PAUSE)

    assert isinstance(got, PauseAir)
    (hum_span,) = [(lo, hi) for lo, hi in got.kept if 4.8 < lo < 5.1]
    assert hum_span == pytest.approx((4.87, 5.03), abs=1e-6)


def _long_track(blip_at: float):
    """40 s: words from 0 to 12 s over -70 dBFS room tone, then room tone alone with one
    130 ms blip 43 dB under the speech (removable) at ``blip_at``."""
    from test_breath_detect import _dbfs, _shaped_noise

    rate = 16000
    signal = _shaped_noise(40 * rate, _FLOOR_RMS, rate)
    tone = _harmonic_tone(4800, _SPEECH_RMS)
    words = [(f"w{i}", i * 0.6, i * 0.6 + 0.3) for i in range(20)]
    for _, at, _end in words:
        signal[round(at * rate) : round(at * rate) + tone.size] = tone
    blip = _shaped_noise(round(0.13 * rate), _dbfs(-58.0), rate)
    signal[round(blip_at * rate) : round(blip_at * rate) + blip.size] = blip

    def window(path, start_sec, duration_sec, sample_rate=16000):
        i = round(start_sec * sample_rate)
        return signal[i : i + round(duration_sec * sample_rate)]

    return words, window


@pytest.mark.parametrize(
    ("pause", "cut"), [((12.3, 39.0), (13.0, 38.0)), ((25.0, 31.0), (25.2, 30.8))]
)
def test_a_quiet_sound_is_removed_whole_whichever_pause_asks_about_it(pause, cut) -> None:
    # The blip at 26 s is 43 dB under the track's speech. A short pause of silence around
    # it holds almost none of the track's speech in its own frames; the track's speech level
    # is the track's, so the blip is quiet for both and goes whole with the air.
    words, window = _long_track(26.0)
    project = _host_project(words)

    with patch("podcast_mcp.edits.breath_detect.load_mono_window", side_effect=window):
        got = pause_air_span(project, "host", *cut, pause=pause)

    assert isinstance(got, PauseAir) and got.span == pytest.approx(cut)


def test_a_peer_sound_where_the_span_runs_a_little_past_the_pause_still_moves_the_edge() -> None:
    # The edge checks can leave the span outside the pause it was cut from. The guest's word
    # at 19.85 to 19.93 is before the pause (20 to 25) and inside the span (19.9 to 24).
    from test_breath_detect import _with_guest

    words, host = _long_track(35.0)
    project = _with_guest(_host_project(words))
    guest = _gated((_harmonic_tone(1280, _SPEECH_RMS), 19.85))

    def windows(path, start_sec, duration_sec, sample_rate=16000):
        reader = guest if "guest" in str(path) else host
        return reader(path, start_sec, duration_sec, sample_rate)

    with patch("podcast_mcp.edits.breath_detect.load_mono_window", side_effect=windows):
        got = pause_air_span(project, "host", 19.9, 24.0, pause=(20.0, 25.0))

    assert isinstance(got, PauseAir) and got.span == pytest.approx((19.96, 24.0))


def test_a_peer_lane_split_into_abutting_clips_is_read_once_not_once_per_clip() -> None:
    # Clips that abut in the lane and in the source are one stretch of audio: the peer's
    # room and levels are read once for them, and a sound across the split is one sound.
    word = _harmonic_tone(4800, _SPEECH_RMS)
    guest = _gated((word, 4.7))
    project = _project(guest_clips=((0.0, 4.9, 0.0), (4.9, 30.0, 4.9)))
    real = _track_sounds
    calls: list[str] = []

    def counting(project, track_id, *args, **kwargs):
        calls.append(track_id)
        return real(project, track_id, *args, **kwargs)

    with patch("podcast_mcp.edits.breath_detect._track_sounds", side_effect=counting):
        got = _air(project, "host", (4.9, 5.3), host=_fake_windows(), guest=guest)

    assert calls.count("guest") == 1
    assert got == pytest.approx((5.03, 5.3))
