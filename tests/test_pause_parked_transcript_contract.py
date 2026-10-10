from __future__ import annotations

import os

import numpy as np
import pytest

from pause_policy_public_helpers import (
    configure,
    defaults,
    files,
    pause,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    SourceRecording,
    Track,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services.document import EditService
from podcast_mcp.util.wav import open_wav


def _parked_recording(tmp_path, *, explicit_words: bool, unique_owner: bool):
    result = project(tmp_path)
    samples = room()
    for start, end in [(0, 0.2), (3, 3.2), (5, 5.2)]:
        voice(samples, start, end)
    write_wav(tmp_path / "raw/peer.wav", samples)
    os.link(tmp_path / "raw/peer.wav", tmp_path / "raw/peer-alias.wav")
    write_wav(tmp_path / "raw/parking.wav", room(seed=1230))
    result.tracks += [
        Track(
            id="peer-a",
            label="Peer A",
            media=MediaAsset(path="raw/peer.wav", duration_sec=6),
        ),
        Track(
            id="peer-b",
            label="Peer B",
            media=MediaAsset(path="raw/peer-alias.wav", duration_sec=6),
            timeline_empty=True,
        ),
        Track(
            id="parking",
            label="Parking",
            media=MediaAsset(path="raw/parking.wav", duration_sec=6),
        ),
    ]
    result.sources.append(
        SourceRecording(id="peer-recording", path="raw/peer-alias.wav", duration_sec=6)
    )
    result.clips += [
        Clip(id="a-before", track_id="peer-a", source_start=0, source_end=1, timeline_start=0),
        Clip(id="a-after", track_id="peer-a", source_start=5, source_end=6, timeline_start=5),
        Clip(
            id="parked-word",
            track_id="parking",
            source_id="peer-recording",
            source_start=2,
            source_end=4,
            timeline_start=2,
        ),
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
    if unique_owner:
        result.track_by_id("peer-a").media = MediaAsset(path="raw/parking.wav", duration_sec=6)
        result.sources.append(SourceRecording(id="unrelated", path="raw/host.wav", duration_sec=6))
        result.transcripts.insert(
            0,
            Transcript(
                track_id="peer-b",
                source_id="unrelated",
                words=[TranscriptWord(text="other", start=0, end=0.2)],
            ),
        )
    if explicit_words:
        result.transcripts.append(
            Transcript(
                track_id="parking",
                source_id="peer-recording",
                words=[TranscriptWord(text="retained", start=3, end=3.2)],
            )
        )
    result.edit_decisions = [pause("later-pause", start=3.3, end=4, gap=None)]
    return result


def _samples(path):
    with open_wav(path) as stream:
        assert stream.getsampwidth() == 2
        return stream.getframerate(), np.frombuffer(
            stream.readframes(stream.getnframes()), dtype="<i2"
        ).reshape(-1, stream.getnchannels())


def _render(ws, tmp_path, name, cfg):
    return _samples(
        render_track_from_timeline(
            ws.project, ws.project.track_by_id("parking"), tmp_path / name, cfg
        )
    )


def _assert_kept_pcm(original, consumed, rate):
    start, end = round(3.05 * rate), round(3.19 * rate)
    assert np.max(np.abs(original[start:end].astype(np.int32))) > 1000
    np.testing.assert_array_equal(consumed[start:end], original[start:end])


@pytest.mark.parametrize("unique_owner", [False, True])
def test_parked_explicit_recording_with_resolved_words_preserves_actual_kept_pcm(
    tmp_path, monkeypatch, unique_owner
):
    cfg = defaults(acoustic=False)
    configure(monkeypatch, cfg)
    ws = workspace(
        _parked_recording(tmp_path, explicit_words=not unique_owner, unique_owner=unique_owner)
    )
    rate, original = _render(ws, tmp_path, "before.wav", cfg)
    assert EditService(ws).approve(["later-pause"]) == 1
    consumed_rate, consumed = _render(ws, tmp_path, "after.wav", cfg)
    assert consumed_rate == rate
    _assert_kept_pcm(original, consumed, rate)
    left = next(clip for clip in ws.project.clips if clip.track_id == "parking")
    assert left.source_end == pytest.approx(3.3)
    assert left.fade_out_ms <= 100


def test_parked_explicit_recording_with_ambiguous_primary_words_holds_atomically(
    tmp_path, monkeypatch
):
    cfg = defaults(acoustic=False)
    configure(monkeypatch, cfg)
    ws = workspace(_parked_recording(tmp_path, explicit_words=False, unique_owner=False))
    rate, original = _render(ws, tmp_path, "before.wav", cfg)
    saved_bytes = ws.path.read_bytes()
    before_model = ws.project.model_dump(mode="json")
    before_files = files(tmp_path)
    with pytest.raises(ValueError, match="ambiguous primary transcript ownership"):
        EditService(ws).approve(["later-pause"])
    assert ws.path.read_bytes() == saved_bytes
    assert ws.project.model_dump(mode="json") == before_model
    assert files(tmp_path) == before_files
    consumed_rate, consumed = _render(ws, tmp_path, "after.wav", cfg)
    assert consumed_rate == rate
    _assert_kept_pcm(original, consumed, rate)
