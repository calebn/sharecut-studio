from __future__ import annotations

import os

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
from podcast_mcp.edits.audio_cache import build_track_audio_caches
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.session_air import SessionAir
from podcast_mcp.models import Clip, MediaAsset, SourceRecording, Track, Transcript, TranscriptWord
from podcast_mcp.services.document import EditService


def _disjoint_primaries(tmp_path):
    result = project(tmp_path)
    samples = room()
    for start, end in [(0, 0.2), (3, 3.2), (5, 5.2)]:
        voice(samples, start, end)
    write_wav(tmp_path / "raw/peer.wav", samples)
    os.link(tmp_path / "raw/peer.wav", tmp_path / "raw/peer-alias.wav")
    result.tracks += [
        Track(id="peer-a", label="Peer A", media=MediaAsset(path="raw/peer.wav", duration_sec=6)),
        Track(
            id="peer-b", label="Peer B", media=MediaAsset(path="raw/peer-alias.wav", duration_sec=6)
        ),
    ]
    result.clips += [
        Clip(id="a-before", track_id="peer-a", source_start=0, source_end=1, timeline_start=0),
        Clip(id="a-after", track_id="peer-a", source_start=5, source_end=6, timeline_start=5),
        Clip(id="b-word", track_id="peer-b", source_start=2, source_end=4, timeline_start=2),
    ]
    result.transcripts += [
        Transcript(
            track_id="peer-a",
            words=[
                TranscriptWord(text="before", start=0, end=0.2),
                TranscriptWord(text="after", start=5, end=5.2),
            ],
        ),
        Transcript(track_id="peer-b", words=[TranscriptWord(text="retained", start=3, end=3.2)]),
    ]
    return result


@pytest.mark.parametrize("explicit_first", [False, True])
def test_primary_alias_observation_retains_own_transcript(tmp_path, explicit_first):
    result = _disjoint_primaries(tmp_path)
    if explicit_first:
        result.sources.append(SourceRecording(id="other", path="raw/host.wav", duration_sec=6))
        result.transcripts.insert(
            0,
            Transcript(
                track_id="peer-b",
                source_id="other",
                words=[TranscriptWord(text="other", start=0, end=0.2)],
            ),
        )
    caches = build_track_audio_caches(result, [track.id for track in result.tracks])
    indexes = {track.id: CutWordIndex.build(result, track.id) for track in result.tracks}
    observation = SessionAir(result, audio_caches=caches, word_indexes=indexes).pause_observation(
        2.9, 3.4, acoustic=False
    )
    lane = next(item for item in observation.activity if item.track_id == "peer-b")
    assert lane.hi == pytest.approx(3.2)


def test_pause_fade_preserves_disjoint_primary_alias_word(tmp_path, monkeypatch):
    import numpy as np

    from podcast_mcp.engines.timeline_render import render_track_from_timeline
    from podcast_mcp.util.wav import open_wav

    cfg = defaults(acoustic=False)
    configure(monkeypatch, cfg)
    result = _disjoint_primaries(tmp_path)
    result.edit_decisions = [pause("later-pause", start=3.3, end=4, gap=None)]
    ws = workspace(result)
    before = render_track_from_timeline(
        ws.project, ws.project.track_by_id("peer-b"), tmp_path / "before.wav", cfg
    )
    assert EditService(ws).approve(["later-pause"]) == 1
    after = render_track_from_timeline(
        ws.project, ws.project.track_by_id("peer-b"), tmp_path / "after.wav", cfg
    )

    def samples(path):
        with open_wav(path) as stream:
            assert stream.getsampwidth() == 2
            return stream.getframerate(), np.frombuffer(
                stream.readframes(stream.getnframes()), dtype="<i2"
            ).reshape(-1, stream.getnchannels())

    before_rate, original = samples(before)
    after_rate, consumed = samples(after)
    assert before_rate == after_rate
    start, end = round(3.05 * before_rate), round(3.19 * before_rate)
    assert np.max(np.abs(original[start:end].astype(np.int32))) > 1000
    np.testing.assert_array_equal(consumed[start:end], original[start:end])
    left = next(clip for clip in ws.project.clips if clip.track_id == "peer-b")
    assert left.source_end == pytest.approx(3.3)
    assert left.fade_out_ms <= 100
    edge = next(
        edge
        for edge in ws.project.editorial.edit_log[0].params["edge_fades"]
        if edge["track_id"] == "peer-b"
    )
    assert edge["source_start"] >= 3.2 - 1e-9
