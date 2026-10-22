from __future__ import annotations

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.cut_application import _apply_replace_gap_pad
from podcast_mcp.edits.join_modes import set_clip_join
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    EditDecision,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)


def _three_clip_project() -> EpisodeProject:
    project = EpisodeProject.create("pad_joins", "/tmp/ws")
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.clips = [
        Clip(
            id=clip_id,
            track_id="host",
            source_start=start,
            source_end=start + 2.0,
            timeline_start=start,
        )
        for clip_id, start in (("a", 0.0), ("b", 2.0), ("c", 4.0))
    ]
    return project


def test_a_replacement_pad_leaves_the_join_before_the_clip_it_follows() -> None:
    defaults = load_defaults()
    project = _three_clip_project()
    set_clip_join(project, "a", "b", ClipJoinMode.CROSSFADE, length_ms=90, defaults=defaults)
    before = next(c for c in project.clips if c.id == "b").model_copy()
    edit = EditDecision(id="e1", track_id="host", start=4.0, end=4.3, replace_gap_sec=0.2)

    _apply_replace_gap_pad(project, edit, 4.0, effects=[], defaults=defaults)

    clips = {c.id: c for c in project.clips}
    assert clips["b"].join_in_mode == ClipJoinMode.CROSSFADE
    assert clips["b"].fade_in_ms == before.fade_in_ms
    assert clips["b"].fade_out_ms > 0
    assert clips["c"].join_in_mode == ClipJoinMode.FADE
    assert clips["c"].timeline_start > 4.0
