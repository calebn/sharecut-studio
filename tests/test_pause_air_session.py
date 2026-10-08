"""A pause trim is a session ripple: every track is read where the ripple removes it (#1055).

A ripple removes session time. Each recording sits on the timeline wherever ingest or
alignment put it, so the stretch of a peer that goes is not the trim track's own source
seconds, and a peer can hold no audio under part of the span. One rule judges every track
the ripple cuts, the trim's own included, each through its own lane and no other: the same
stretch of shared air gets the same answer from each track, and from each pause.
"""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.edits.breath_detect import PauseAir, PauseAirSkip, pause_air_span
from podcast_mcp.edits.session_air import SessionAir, lane_placements
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from test_breath_detect import (
    _FLOOR_RMS,
    _SPEECH_RMS,
    _dbfs,
    _fake_windows,
    _fixture_words,
    _frames_at,
    _harmonic_tone,
    _host_project,
    _natural_room,
    _shaped_noise,
)

_CUT = (4.4, 5.3)
RATE = 16_000


def _project(
    *,
    host_at: float = 0.0,
    guest_clips: tuple[tuple[float, float, float], ...] = ((0.0, 30.0, 0.0),),
    host_clips: tuple[tuple[float, float, float], ...] | None = None,
):
    """The fixture host (placed ``host_at`` s into the session, or on ``host_clips``) and a
    guest whose clips are ``(source_start, source_end, timeline_start)``."""
    project = _host_project(_fixture_words())
    project.clips[0].timeline_start = host_at
    if host_clips is not None:
        project.clips = [
            Clip(id=f"h{i}", track_id="host", source_start=a, source_end=b, timeline_start=at)
            for i, (a, b, at) in enumerate(host_clips)
        ]
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


def _reader(**by_name):
    """A ``load_mono_window`` stand-in that serves each file the reader named in its file name."""

    def window(path, start_sec, duration_sec, sample_rate=16000):
        name = next(n for n in by_name if n in str(path))
        return by_name[name](path, start_sec, duration_sec, sample_rate)

    return window


def _air(project, own: str, cut, *, host, guest):
    with patch(
        "podcast_mcp.edits.session_air.load_mono_window",
        side_effect=_reader(host=host, guest=guest),
    ):
        got = pause_air_span(project, own, *cut)
    return got.span if isinstance(got, PauseAir) else got


@pytest.mark.parametrize("offset", [0.05, 0.5, 2.0])
def test_a_peer_is_read_where_the_ripple_removes_it_when_the_tracks_are_offset(offset) -> None:
    # The host sits `offset` s into the session, the guest at its start. The guest's word
    # runs from 100 ms before to 100 ms after the trim's start on the SESSION clock; at
    # the trim's own seconds the guest holds nothing. The start moves to the word's end,
    # three frames on, whatever the offset.
    word = _harmonic_tone(3200, _SPEECH_RMS)
    guest = _gated((word, _CUT[0] + offset - 0.1))

    got = _air(_project(host_at=offset), "host", _CUT, host=_fake_windows(), guest=guest)

    assert got == pytest.approx((_CUT[0] + 0.13, _CUT[1]), abs=0.031)
    assert got[0] >= _CUT[0] + 0.13 - 1e-6


def test_material_cut_from_a_peers_lane_contributes_no_sound() -> None:
    # The guest's source 4.5 to 6.0 was cut from its lane (clips 0 to 4.5 and 6.0 on,
    # abutting at session 4.5). Its word at source 5.25 to 5.45 is not in the render, so
    # the host's trim end at 5.3 is not inside a sound.
    word = _harmonic_tone(3200, _SPEECH_RMS)
    guest = _gated((word, 5.25))
    project = _project(guest_clips=((0.0, 4.5, 0.0), (6.0, 30.0, 4.5)))
    still_there = _project(guest_clips=((0.0, 30.0, 0.0),))

    assert _air(project, "host", _CUT, host=_fake_windows(), guest=guest) == pytest.approx(_CUT)
    # Left on the lane the same word is a sound, and the trim ends before it.
    assert _air(still_there, "host", _CUT, host=_fake_windows(), guest=guest)[1] < 5.25


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
    still_there = _project(guest_clips=((0.0, 30.0, 0.0),))

    assert _air(project, "host", _CUT, host=_fake_windows(), guest=guest) == pytest.approx(_CUT)
    assert _air(still_there, "host", _CUT, host=_fake_windows(), guest=guest)[1] < 5.25


def test_a_peer_with_no_recording_to_read_there_is_no_room() -> None:
    project = _project()
    project.tracks[-1].media = None

    assert _air(project, "host", _CUT, host=_fake_windows(), guest=_gated()) == (
        PauseAirSkip.NO_ROOM
    )


def test_the_trim_track_needs_a_speech_level_a_peer_without_one_does_not() -> None:
    # A track a trim is cut from must have something to protect: with no transcript words
    # it has no speech level, nothing can be called quiet next to it, and the trim is
    # skipped. The same missing words on a peer only keep every sound on it whole.
    own_without_words = _project()
    own_without_words.transcripts = []
    peer_without_words = _project()
    peer_without_words.transcripts = [
        t for t in peer_without_words.transcripts if t.track_id == "host"
    ]

    assert _air(own_without_words, "host", _CUT, host=_fake_windows(), guest=_gated()) == (
        PauseAirSkip.NO_ROOM
    )
    assert _air(peer_without_words, "host", _CUT, host=_fake_windows(), guest=_gated()) == (
        pytest.approx(_CUT)
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

    assert from_host == from_guest
    # The hum ends at 4.7; its edge is the sound's last frame and the band's ringing on.
    assert 4.73 <= from_host[0] <= 4.8 and from_host[1] == pytest.approx(5.3)


def test_the_sounds_of_a_window_are_laid_on_the_session_clock() -> None:
    # The host sits 0.5 s into the session; the guest's hum at source 4.9 to 5.0 is session
    # 4.9 to 5.0, a guard frame and the average's spread either side of it.
    hum = _harmonic_tone(1600, _SPEECH_RMS)
    project = _project(host_at=0.5)

    with patch(
        "podcast_mcp.edits.session_air.load_mono_window",
        side_effect=_reader(host=_fake_windows(), guest=_gated((hum, 4.9))),
    ):
        sounds = SessionAir(project).sounds_in(4.6, 5.2)

    guest_hum = [s for s in sounds if 4.8 < s.lo < 5.1]
    assert [(round(s.lo, 2), round(s.hi, 2), s.removable) for s in guest_hum] == [
        (4.87, 5.03, False)
    ]


def _long_track(blip_at: float, blip_db: float = -58.0):
    """40 s: words from 0 to 12 s over -70 dBFS room tone, then room tone alone with one
    130 ms blip at ``blip_db`` (43 dB under the speech: removable) at ``blip_at``."""
    rate = 16000
    signal = _shaped_noise(40 * rate, _FLOOR_RMS, rate)
    tone = _harmonic_tone(4800, _SPEECH_RMS)
    words = [(f"w{i}", i * 0.6, i * 0.6 + 0.3) for i in range(20)]
    for _, at, _end in words:
        signal[round(at * rate) : round(at * rate) + tone.size] = tone
    blip = _shaped_noise(round(0.13 * rate), _dbfs(blip_db), rate)
    signal[round(blip_at * rate) : round(blip_at * rate) + blip.size] = blip

    def window(path, start_sec, duration_sec, sample_rate=16000):
        i = round(start_sec * sample_rate)
        return signal[i : i + round(duration_sec * sample_rate)]

    return words, window


@pytest.mark.parametrize("cut", [(13.0, 38.0), (25.2, 30.8)])
def test_a_quiet_sound_is_removed_whole_whichever_pause_asks_about_it(cut) -> None:
    # The blip at 26 s is 43 dB under the track's speech. A short stretch of silence around
    # it holds almost none of the track's speech; the track's speech level is the track's,
    # so the blip is quiet for both and goes whole with the air.
    words, window = _long_track(26.0)
    project = _host_project(words)
    project.clips[0].source_end = 40.0

    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=window):
        got = pause_air_span(project, "host", *cut)

    assert isinstance(got, PauseAir) and got.span == pytest.approx(cut)


@pytest.mark.parametrize("cut", [(13.0, 38.0), (25.2, 30.8)])
def test_a_blip_30_db_under_the_speech_splits_the_air_whichever_pause_asks(cut) -> None:
    # The control for the test above: at -45 dBFS the blip reaches the ceiling (40 dB under the
    # speech), so it stays whole and the trim keeps the longer air on one side of it.
    words, window = _long_track(26.0, blip_db=-45.0)
    project = _host_project(words)
    project.clips[0].source_end = 40.0

    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=window):
        got = pause_air_span(project, "host", *cut)

    assert isinstance(got, PauseAir)
    assert got.end < 26.0 or got.start > 26.13
    assert got.end - got.start > 4.0


def test_a_peer_sound_just_before_the_span_still_moves_the_edge() -> None:
    # The guest's word at 19.85 to 19.93 ends a few frames before the span (19.9 to 24)
    # does its start: the guard frame and the average's spread reach into the span.
    from test_breath_detect import _with_guest

    words, host = _long_track(35.0)
    project = _with_guest(_host_project(words))
    project.clips[0].source_end = 40.0
    guest = _gated((_harmonic_tone(1280, _SPEECH_RMS), 19.85))

    with patch(
        "podcast_mcp.edits.session_air.load_mono_window",
        side_effect=_reader(host=host, guest=guest),
    ):
        got = pause_air_span(project, "host", 19.9, 24.0)

    assert isinstance(got, PauseAir) and got.span == pytest.approx((19.96, 24.0))


def test_a_peer_lane_split_into_abutting_clips_is_one_stretch_of_audio() -> None:
    # Clips that abut in the lane and in the source are one stretch of audio: a sound across
    # the split is one sound, not two cut at the join.
    word = _harmonic_tone(4800, _SPEECH_RMS)
    guest = _gated((word, 4.7))
    project = _project(guest_clips=((0.0, 4.9, 0.0), (4.9, 30.0, 4.9)))

    placements = lane_placements(project, project.track_by_id("guest"))
    got = _air(project, "host", (4.9, 5.3), host=_fake_windows(), guest=guest)

    assert [(p.tl_start, p.tl_end, p.src_start) for p in placements] == [(0.0, 30.0, 0.0)]
    assert got == pytest.approx((5.03, 5.3), abs=0.031)


# --- the trim's own lane is read like any other (A1) -------------------------------------


def test_a_hole_in_the_trim_tracks_own_lane_hides_no_peer_sound() -> None:
    # The host's lane has a hole at session 4.6 to 4.9 (its source 4.6 to 4.9 was punched
    # out); the guest's speech-level hum sits in it at 4.7 to 4.9. The ripple removes the
    # whole session window, hum and all, so the hum splits the air whether or not the
    # host's lane plays anything there. Read through the host's lane it vanished.
    hum = _harmonic_tone(3200, _SPEECH_RMS)
    guest = _gated((hum, 4.7))
    project = _project(host_clips=((0.0, 4.6, 0.0), (4.9, 30.0, 4.9)))

    got = _air(project, "host", _CUT, host=_fake_windows(), guest=guest)

    assert got == pytest.approx((4.93, 5.3), abs=0.031)
    assert got[0] >= 4.9 + 0.03 - 1e-6


def test_a_replayed_stretch_of_the_trim_tracks_own_lane_is_read_where_it_plays() -> None:
    # The host's lane replays its own source 3.5 to 4.5 at session 4.5 to 5.5, so the words
    # at 3.5 and 4.0 sound again at 4.5 and 5.0. A trim of source 4.4 to 5.3 removes session
    # 4.4 to 6.3, which holds both replayed words and not just air: no span of this lane's
    # source removes only air there.
    project = _project(host_clips=((0.0, 4.5, 0.0), (3.5, 30.0, 4.5)))

    got = _air(project, "host", _CUT, host=_fake_windows(), guest=_gated())

    assert got == PauseAirSkip.NO_AIR


# --- a clip plays the recording the render plays (A2) ------------------------------------


def _workspace_project(tmp_path):
    project = EpisodeProject.create("sources", str(tmp_path))
    (tmp_path / "raw").mkdir()
    for name in ("host", "guest", "take2"):
        (tmp_path / "raw" / f"{name}.wav").touch()
    words = [TranscriptWord(text=t, start=a, end=b) for t, a, b in _fixture_words()]
    project.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=30.0),
        )
        for tid in ("host", "guest")
    ]
    project.transcripts = [Transcript(track_id="host", words=words)]
    project.clips = [
        Clip(id="h", track_id="host", source_start=0.0, source_end=30.0, timeline_start=0.0),
        Clip(id="g0", track_id="guest", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(
            id="g1",
            track_id="guest",
            source_id="take2",
            source_start=3.0,
            source_end=15.0,
            timeline_start=4.0,
        ),
    ]
    project.sources = [
        SourceRecording(id="take2", path="raw/take2.wav", speaker="guest", duration_sec=30.0)
    ]
    return project


def test_a_clip_from_an_extra_source_recording_is_read_from_that_recording(tmp_path) -> None:
    # The guest's second clip plays sources['take2'] from 3.0 s at session 4.0 s; take2
    # holds a speech-level word at 3.9 to 4.2 of its own seconds, session 4.9 to 5.2. The
    # guest's own media holds nothing there. The render plays take2, so that word splits the
    # air at session 4.9: the trim's end stops before it. Read from guest.wav it was missed.
    project = _workspace_project(tmp_path)
    word = _harmonic_tone(4800, _SPEECH_RMS)
    reader = _reader(host=_fake_windows(), guest=_gated(), take2=_gated((word, 3.9)))

    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=reader):
        got = pause_air_span(project, "host", *_CUT)

    assert isinstance(got, PauseAir)
    assert got.start == pytest.approx(_CUT[0]) and 4.8 < got.end < 4.9


def test_an_extra_source_is_read_from_its_own_file_not_the_decode_the_run_holds_for_the_track(
    tmp_path,
) -> None:
    # The run holds a decode of the guest's own media (digital silence here). The clip that
    # plays take2 is a different file: its word at session 4.9 must still be read from it.
    from podcast_mcp.edits.audio_cache import TrackAudioCache
    from podcast_mcp.engines.audio_audit import TrackRmsCache

    project = _workspace_project(tmp_path)
    silence = np.zeros(30 * RATE, dtype=np.float32)
    guest_decode = TrackAudioCache(
        jump=TrackRmsCache(silence[::2], sample_rate=RATE // 2),
        waveform=TrackRmsCache(silence, sample_rate=RATE),
    )
    word = _harmonic_tone(4800, _SPEECH_RMS)
    reader = _reader(host=_fake_windows(), guest=_gated(), take2=_gated((word, 3.9)))

    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=reader):
        got = pause_air_span(project, "host", *_CUT, audio_caches={"guest": guest_decode})

    assert isinstance(got, PauseAir)
    assert 4.8 < got.end < 4.9


def test_an_extra_source_has_the_speech_level_of_its_own_transcript(tmp_path) -> None:
    # take2 has its own transcript: three speech-level words at its 12 s, so a breath 47 dB
    # under them at its 3.7 s (session 4.7 to 4.95, inside the trim) may go whole. Read with
    # the guest's track-level words (none) it would have no speech level, every sound on it
    # would stay whole, and the trim would shrink to the longer stretch after the breath.
    project = _workspace_project(tmp_path)
    spoken = [("a", 12.0, 12.3), ("b", 12.4, 12.7), ("c", 12.8, 13.1)]
    project.transcripts.append(
        Transcript(track_id="guest", words=[TranscriptWord(text="p", start=0.5, end=0.8)])
    )
    project.transcripts.append(
        Transcript(
            track_id="guest",
            source_id="take2",
            words=[TranscriptWord(text=t, start=a, end=b) for t, a, b in spoken],
        )
    )
    word = _harmonic_tone(4800, _SPEECH_RMS)
    breath = _shaped_noise(4000, _dbfs(-62.0))
    take2 = _gated((breath, 3.7), *((word, a) for _, a, _ in spoken))
    reader = _reader(host=_fake_windows(), guest=_gated(), take2=take2)

    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=reader):
        got = pause_air_span(project, "host", *_CUT)

    assert isinstance(got, PauseAir)
    assert got.span == pytest.approx(_CUT, abs=0.02)


def test_an_extra_source_that_cannot_be_found_is_no_room(tmp_path) -> None:
    project = _workspace_project(tmp_path)
    (tmp_path / "raw" / "take2.wav").unlink()
    reader = _reader(host=_fake_windows(), guest=_gated(), take2=_gated())

    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=reader):
        got = pause_air_span(project, "host", *_CUT)

    assert got == PauseAirSkip.NO_ROOM


# --- what a track's levels say does not depend on who asks (A5) -------------------------


def _ringing_track(seed: int):
    """30 s of natural -70 dBFS room tone: words every 0.5 s to 9.8 s, the last ringing out
    at 0.5 dB per 10 ms (to the room at 11.0 s), then none until 20.5 s: words and signal."""
    rate = 16000
    signal = _natural_room(-70.0, seed, 30.0)
    tone = _harmonic_tone(round(0.3 * rate), _SPEECH_RMS)
    starts = [*np.arange(0.0, 10.0, 0.5), *np.arange(20.5, 29.5, 0.5)]
    for at in starts:
        i = round(at * rate)
        signal[i : i + tone.size] += tone
    tail = _frames_at([-15.0 - 0.5 * k for k in range(120)], voiced=True)
    i = round(9.8 * rate)
    signal[i : i + tail.size] += tail
    return [(f"w{k}", float(at), float(at) + 0.3) for k, at in enumerate(starts)], signal


@pytest.mark.parametrize("seed", [0, 8, 41, 42, 49])
def test_the_same_decay_gets_the_same_air_whichever_pause_asks_about_it(seed) -> None:
    # A trim asked for over 1.5 s, 3.8 s and 9.8 s, all beginning inside the word's ringing:
    # where the air starts is a fact about the recording, not about how much silence the
    # question holds. A room read from the pause asked about moved the line with the pause.
    words, signal = _ringing_track(seed)
    project = _host_project(words)

    def read(path, start_sec, duration_sec, sample_rate=16000):
        i = round(start_sec * sample_rate)
        return signal[i : i + round(duration_sec * sample_rate)]

    starts = {}
    with patch("podcast_mcp.edits.session_air.load_mono_window", side_effect=read):
        for name, end in {"short": 11.7, "mid": 14.0, "long": 20.0}.items():
            got = pause_air_span(project, "host", 10.2, end)
            assert isinstance(got, PauseAir)
            starts[name] = got.start

    assert max(starts.values()) - min(starts.values()) < 1e-6, starts


# --- a track's room is read where nobody speaks (L2) ------------------------------------


def _conversation(*, murmur_db: float | None = -50.0):
    """30 s of two people who never overlap: the host says a word at each whole second and
    the guest talks through the 600 ms between (so every gap between the host's own words
    is the guest bleeding into the host's mic, 30 dB down), except 14 to 16 s, which is
    quiet in the session. Room tone is -75 dBFS on both. The host mic alone holds an
    untranscribed 400 ms murmur at 14.8 s, 35 dB under the host's speech.

    Returns the project, the host's and the guest's signals."""
    seconds = 30
    host = _natural_room(-75.0, 11, seconds)
    guest = _natural_room(-75.0, 12, seconds)
    host_words, guest_words = [], []
    word = _harmonic_tone(round(0.3 * RATE), _SPEECH_RMS)
    talk = _harmonic_tone(round(0.6 * RATE), _SPEECH_RMS, hz=210.0)
    bleed = _harmonic_tone(round(0.6 * RATE), _dbfs(-45.0), hz=210.0)
    for k in range(seconds):
        if 14 <= k < 16:
            continue
        host[round(k * RATE) : round(k * RATE) + word.size] += word
        host[round((k + 0.35) * RATE) : round((k + 0.35) * RATE) + bleed.size] += bleed
        guest[round((k + 0.35) * RATE) : round((k + 0.35) * RATE) + talk.size] += talk
        host_words.append((f"h{k}", float(k), k + 0.3))
        guest_words.append((f"g{k}", k + 0.35, k + 0.95))
    if murmur_db is not None:
        murmur = _harmonic_tone(round(0.4 * RATE), _dbfs(murmur_db))
        host[round(14.8 * RATE) : round(14.8 * RATE) + murmur.size] += murmur
    project = _host_project(host_words)
    project.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/guest.wav", duration_sec=30.0),
        )
    )
    project.clips.append(
        Clip(id="cg", track_id="guest", source_start=0.0, source_end=30.0, timeline_start=0.0)
    )
    project.transcripts.append(
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text=t, start=a, end=b) for t, a, b in guest_words],
        )
    )

    def reader(signal):
        def read(path, start_sec, duration_sec, sample_rate=16000):
            i = round(start_sec * sample_rate)
            return signal[i : i + round(duration_sec * sample_rate)]

        return read

    return project, reader(host), reader(guest)


def test_a_track_whose_gaps_are_its_peers_bleed_still_hears_a_murmur_in_the_quiet() -> None:
    # Between the host's own words the guest is always talking, so the host's own gaps sit
    # 30 dB over its room tone: read as the room, they hide a murmur 25 dB over the true
    # room (35 dB under the speech) in the one stretch where nobody speaks. The room is read
    # where the whole session is quiet, so the murmur is a sound and the trim stops short of it.
    project, host, guest = _conversation()

    with patch(
        "podcast_mcp.edits.session_air.load_mono_window",
        side_effect=_reader(host=host, guest=guest),
    ):
        got = pause_air_span(project, "host", 13.4, 15.9)

    assert isinstance(got, PauseAir)
    assert not (14.8 < got.start < 15.2) and not (14.8 < got.end < 15.2)
    assert got.end < 14.8 or got.start > 15.2
    assert got.end - got.start > 0.5


def test_a_track_that_speaks_seven_percent_of_the_time_has_a_speech_level_from_its_words() -> None:
    # The guest says seven words in 30 s. Its speech level is read from the frames inside
    # those words, not from the 90th percentile of all its frames (which lands on the quietest
    # frames of its words when 7% of them are speech: 40 dB under the real level), so the
    # ceiling is 40 dB under its speech and its room is air: the host's trim stands.
    signal = _natural_room(-70.0, 5, 30.0)
    word = _harmonic_tone(round(0.3 * RATE), _SPEECH_RMS, hz=210.0)
    starts = [0.5, 1.5, 2.5, 20.5, 21.5, 22.5, 23.5]
    tail = _frames_at([-15.0 - 3.0 * k for k in range(20)], voiced=True)
    for at in starts:
        signal[round(at * RATE) : round(at * RATE) + word.size] += word
        i = round((at + 0.3) * RATE)
        signal[i : i + tail.size] += tail
    project = _project()
    project.transcripts.append(
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="g", start=a, end=a + 0.3) for a in starts],
        )
    )

    def guest(path, start_sec, duration_sec, sample_rate=16000):
        return signal[
            round(start_sec * sample_rate) : round((start_sec + duration_sec) * sample_rate)
        ]

    assert _air(project, "host", _CUT, host=_fake_windows(), guest=guest) == pytest.approx(_CUT)
