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
@pytest.mark.parametrize("peer_kind", ["turn", "shifted", "point"])
@pytest.mark.parametrize("own_shift", [0, 4])
@pytest.mark.parametrize("parked_source", [False, True])
def test_current_peer_placement_selects_literal_original_pause_floor(
    tmp_path, monkeypatch, delivery, peer_kind, own_shift, parked_source
):
    shifted_peer = peer_kind == "shifted"
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
        Track(id="peer", label="Peer", media=MediaAsset(path="raw/peer.wav", duration_sec=2))
    )
    result.clips[0].timeline_start = own_shift
    if parked_source:
        result.sources.append(
            SourceRecording(id="peer-recording", path="raw/peer.wav", duration_sec=2)
        )
    result.clips.append(
        Clip(
            id="peer-current-placement",
            track_id="peer",
            source_id="peer-recording" if parked_source else None,
            source_start=0,
            source_end=2,
            timeline_start=own_shift + (8 if shifted_peer else 0),
        )
    )
    result.transcripts.append(
        Transcript(
            track_id="peer",
            source_id="peer-recording" if parked_source else None,
            words=[
                TranscriptWord(
                    text="peer-word", start=0.22, end=0.22 if peer_kind == "point" else 0.26
                )
            ],
        )
    )
    result.timeline.duration_sec = own_shift + (10 if shifted_peer else 6)
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
    if peer_kind != "turn":
        assert kept_original_air >= 0.55 - 1e-6
    else:
        assert 0.18 - 1e-6 <= kept_original_air < 0.55 - 1e-6
    record = edited.editorial.edit_log[0]
    assert record.params["replace_gap_sec"] is None
    assert record.params["pad_samples"] == []
