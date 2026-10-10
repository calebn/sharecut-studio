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
from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
from podcast_mcp.models import Clip, MediaAsset, SourceRecording, Track, Transcript, TranscriptWord
from podcast_mcp.services.document import EditService


@pytest.mark.parametrize("delivery", ["saved", "automatic", "suggested"])
@pytest.mark.parametrize("peer_state", ["ignored", "mix-muted"])
@pytest.mark.parametrize("source_kind", ["primary", "parked", "implicit", "primary-fallback"])
def test_editorial_ignore_requires_solo_floor_and_mix_mute_keeps_turn_floor(
    tmp_path, monkeypatch, delivery, peer_state, source_kind
):
    cfg = defaults(acoustic=False)
    configure(monkeypatch, cfg)
    result = project(tmp_path)
    host = room()
    for start, end in [(0, 0.2), (1, 1.2), (5, 5.2)]:
        voice(host, start, end)
    write_wav(tmp_path / "raw/host.wav", host)
    result.transcripts[0].words = [
        TranscriptWord(text="host-before", start=0, end=0.2),
        TranscriptWord(text="host-after", start=1, end=1.2),
        TranscriptWord(text="host-later", start=5, end=5.2),
    ]
    peer = room(seconds=2, seed=1940)
    voice(peer, 0.22, 0.26)
    write_wav(tmp_path / "raw/peer.wav", peer)
    result.tracks.append(
        Track(
            id="peer",
            label="Peer",
            muted=peer_state == "mix-muted",
            media=MediaAsset(path="raw/peer.wav", duration_sec=2),
        )
    )
    result.clips.append(
        Clip(
            id="peer-current-placement",
            track_id="peer",
            source_start=0,
            source_end=2,
            timeline_start=0,
        )
    )
    result.transcripts.append(
        Transcript(
            track_id="peer",
            words=[
                TranscriptWord(
                    text="peer-word",
                    start=0.22,
                    end=0.26,
                    ignored=peer_state == "ignored",
                )
            ],
        )
    )
    if source_kind == "implicit":
        result.clips.pop()
    elif source_kind in {"parked", "primary-fallback"}:
        result.sources.append(
            SourceRecording(id="peer-source", path="raw/peer.wav", duration_sec=2)
        )
        result.clips[-1].source_id = "peer-source"
        if source_kind == "parked":
            result.transcripts[-1].source_id = "peer-source"
        else:
            result.track_by_id("peer").timeline_empty = True
            write_wav(tmp_path / "raw/parking.wav", room(seconds=2, seed=1941))
            result.tracks.append(
                Track(
                    id="parking",
                    label="Parking",
                    media=MediaAsset(path="raw/parking.wav", duration_sec=2),
                )
            )
            result.clips[-1].track_id = "parking"
    result.edit_decisions = [pause("current-floor", start=0.35, end=0.9, gap=None)]
    ws = workspace(result)
    if delivery == "suggested":
        edited = ws.project.model_copy(deep=True)
        apply_for_suggested(edited, resolve_pending_preview(edited, "current-floor"))
    else:
        service = EditService(ws)
        count = service.approve(["current-floor"]) if delivery == "saved" else service.apply_auto()
        assert count == 1
        edited = ws.project
    kept_original_air = sum(
        max(0.0, min(clip.source_end, 1.0) - max(clip.source_start, 0.2))
        for clip in edited.clips
        if clip.track_id == "host" and clip.source_id is None
    )
    if peer_state == "ignored" and source_kind != "primary-fallback":
        assert kept_original_air >= 0.55 - 1e-6
    else:
        assert 0.18 - 1e-6 <= kept_original_air < 0.55 - 1e-6
    record = edited.editorial.edit_log[0]
    assert record.params["replace_gap_sec"] is None
    assert record.params["pad_samples"] == []
