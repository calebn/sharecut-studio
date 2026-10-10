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
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    MediaAsset,
    SourceRecording,
    Track,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services.document import EditService


@pytest.mark.parametrize("delivery", ["saved", "automatic", "suggested"])
@pytest.mark.parametrize(
    "peer_state", ["full-mute", "partial-mute", "faded-mute", "abutting-unmuted", "unmuted-replay"]
)
@pytest.mark.parametrize("parked_source", [False, True])
def test_full_editorial_mute_requires_solo_floor_and_partial_voice_keeps_turn_floor(
    tmp_path, monkeypatch, delivery, peer_state, parked_source
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
        Track(id="peer", label="Peer", media=MediaAsset(path="raw/peer.wav", duration_sec=2))
    )
    result.clips.append(
        Clip(
            id="peer-current-placement",
            track_id="peer",
            source_start=0,
            source_end=2,
            timeline_start=0,
            mute_regions=[
                ClipMuteRegion(
                    start_s=0.21,
                    end_s=0.24 if peer_state == "partial-mute" else 0.27,
                    fade_out_ms=100 if peer_state == "faded-mute" else 0,
                    fade_in_ms=100 if peer_state == "faded-mute" else 0,
                )
            ],
        )
    )
    if peer_state == "abutting-unmuted":
        result.clips[-1].source_end = 0.24
        result.clips.append(
            Clip(
                id="peer-unmuted-continuation",
                track_id="peer",
                source_start=0.24,
                source_end=2,
                timeline_start=0.24,
            )
        )
    elif peer_state == "unmuted-replay":
        result.clips[-1].timeline_start = 8
        result.clips.append(
            Clip(
                id="peer-unmuted-replay",
                track_id="peer",
                source_start=0.2,
                source_end=0.3,
                timeline_start=0.2,
            )
        )
    result.transcripts.append(
        Transcript(
            track_id="peer",
            words=[TranscriptWord(text="peer-word", start=0.22, end=0.26)],
        )
    )
    if parked_source:
        result.sources.append(
            SourceRecording(id="peer-source", path="raw/peer.wav", duration_sec=2)
        )
        result.transcripts[-1].source_id = "peer-source"
        for clip in result.clips:
            if clip.track_id == "peer":
                clip.source_id = "peer-source"
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
    if peer_state in {"full-mute", "faded-mute"}:
        assert kept_original_air >= 0.55 - 1e-6
    else:
        assert 0.18 - 1e-6 <= kept_original_air < 0.55 - 1e-6
    record = edited.editorial.edit_log[0]
    assert record.params["replace_gap_sec"] is None
    assert record.params["pad_samples"] == []
