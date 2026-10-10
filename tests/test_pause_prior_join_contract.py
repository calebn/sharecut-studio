from __future__ import annotations

import pytest

from pause_policy_public_helpers import (
    configure,
    defaults,
    pause,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.edits.clips_ops import uses_crossfade_join
from podcast_mcp.models import Clip, ClipJoinMode
from podcast_mcp.services.document import EditService


@pytest.mark.parametrize("acoustic", [False, True])
@pytest.mark.parametrize("incoming", [ClipJoinMode.CROSSFADE, ClipJoinMode.CUT])
def test_later_pause_preserves_prior_authored_incoming_join(
    tmp_path, monkeypatch, acoustic, incoming
):
    configure(monkeypatch, defaults(acoustic=acoustic))
    result = project(tmp_path, guest="quiet")
    host_audio = room()
    voice(host_audio, 0, 0.4)
    voice(host_audio, 5, 5.4)
    write_wav(tmp_path / "raw" / "host.wav", host_audio)
    result.transcripts[0].words[0].end = 0.4
    result.transcripts[0].words[1].end = 5.4
    result.clips = [clip for clip in result.clips if clip.track_id != "guest"] + [
        Clip(
            id="guest-prev",
            track_id="guest",
            source_start=0,
            source_end=1,
            timeline_start=0,
            fade_out_ms=40,
        ),
        Clip(
            id="guest-body",
            track_id="guest",
            source_start=1,
            source_end=6,
            timeline_start=1,
            fade_in_ms=40,
            join_in_mode=incoming,
        ),
    ]
    assert uses_crossfade_join(result.clips[-2], result.clips[-1]) == (
        incoming == ClipJoinMode.CROSSFADE
    )
    result.edit_decisions = [pause("later-pause", start=3, end=4, gap=None)]
    ws = workspace(result)
    assert EditService(ws).approve(["later-pause"]) == 1
    guests = sorted(
        (clip for clip in ws.project.clips if clip.track_id == "guest"),
        key=lambda clip: clip.timeline_start,
    )
    assert guests[1].join_in_mode == incoming
    assert uses_crossfade_join(guests[0], guests[1]) == (incoming == ClipJoinMode.CROSSFADE)
    assert (guests[1].source_start, guests[1].source_end, guests[1].fade_in_ms) == (1, 3, 40)


def test_later_pause_preserves_rendered_audio_at_prior_crossfade(tmp_path, monkeypatch):
    import numpy as np

    from pause_policy_public_helpers import room, voice, write_wav
    from podcast_mcp.engines.timeline_render import render_track_from_timeline
    from podcast_mcp.models import Transcript, TranscriptWord
    from podcast_mcp.util.wav import open_wav

    cfg = defaults(acoustic=False)
    configure(monkeypatch, cfg)
    result = project(tmp_path, guest="quiet")
    audio = room(seed=1220)
    voice(audio, 0.8, 1.2)
    voice(audio, 5, 5.2)
    write_wav(tmp_path / "raw" / "guest.wav", audio)
    result.transcripts.append(
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="earlier", start=0.8, end=1.2),
                TranscriptWord(text="later", start=5, end=5.2),
            ],
        )
    )
    result.clips = [clip for clip in result.clips if clip.track_id != "guest"] + [
        Clip(
            id="guest-prev",
            track_id="guest",
            source_start=0,
            source_end=1,
            timeline_start=0,
            fade_out_ms=40,
        ),
        Clip(
            id="guest-body",
            track_id="guest",
            source_start=1,
            source_end=6,
            timeline_start=1,
            fade_in_ms=40,
            join_in_mode=ClipJoinMode.CROSSFADE,
        ),
    ]
    result.edit_decisions = [pause("later-pause", start=3, end=4, gap=None)]
    ws = workspace(result)
    before = render_track_from_timeline(
        ws.project, ws.project.track_by_id("guest"), tmp_path / "before.wav", cfg
    )
    assert EditService(ws).approve(["later-pause"]) == 1
    after = render_track_from_timeline(
        ws.project, ws.project.track_by_id("guest"), tmp_path / "after.wav", cfg
    )

    def samples(path):
        with open_wav(path) as audio_file:
            rate = audio_file.getframerate()
            channels = audio_file.getnchannels()
            width = audio_file.getsampwidth()
            assert width == 2
            return rate, np.frombuffer(
                audio_file.readframes(audio_file.getnframes()), dtype="<i2"
            ).reshape(-1, channels)

    before_rate, original = samples(before)
    after_rate, consumed = samples(after)
    assert before_rate == after_rate
    start, end = round(0.85 * before_rate), round(1.15 * before_rate)
    assert np.max(np.abs(original[start:end].astype(np.int32))) > 1000
    np.testing.assert_array_equal(consumed[start:end], original[start:end])
