from __future__ import annotations

from podcast_mcp.edits import apply_tighten_decisions
from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)


def _two_track_project() -> EpisodeProject:
    p = EpisodeProject.create("t", "/tmp/ws")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        ),
    ]
    for tid in ("host", "guest"):
        p.timeline.clips.append(
            Clip(
                id=f"full_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
        )
    return p


def test_apply_tighten_decisions_counts_applied():
    proj = _two_track_project()
    proj.edit_decisions = [
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.5,
            reason="filler:um",
            applied=False,
        ),
        EditDecision(
            id="2",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=5.0,
            end=6.0,
            reason="pause:1.5s",
            applied=False,
            review_required=True,
        ),
    ]
    n = apply_tighten_decisions(proj)
    assert n == 1
    assert all(e.id != "1" for e in proj.edit_decisions)
    assert proj.edit_decisions[0].id == "2"
    host_end = max(c.timeline_end for c in clips_for_track(proj, "host"))
    guest_end = max(c.timeline_end for c in clips_for_track(proj, "guest"))
    assert host_end == guest_end == 9.5
