"""The archived timeline operations use the same clip geometry as domain ops."""

from __future__ import annotations

import pytest

from podcast_mcp.edits import clips_ops, timeline_ops
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project


@pytest.mark.parametrize("operation", ["trim_clip_edge", "roll_clip_join", "move_clips"])
def test_timeline_wrapper_preserves_domain_geometry_and_archives(minimal_project, operation):
    project = load_project(minimal_project)
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=40.0),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0, source_end=5, timeline_start=0),
        Clip(id="c2", track_id="host", source_start=10, source_end=15, timeline_start=5),
    ]
    domain = project.model_copy(deep=True)
    archived = project.model_copy(deep=True)
    if operation == "trim_clip_edge":
        args = ("c1", "out", 7.0)
    elif operation == "roll_clip_join":
        args = ("c1", "c2", 1.0)
    else:
        args = ([{"clip_id": "c2", "timeline_start": 8.0, "track_id": "host"}],)

    getattr(clips_ops, operation)(domain, *args)
    summary = getattr(timeline_ops, operation)(archived, *args)

    def geometry(clips):
        return [(c.id, c.track_id, c.source_start, c.source_end, c.timeline_start) for c in clips]

    assert geometry(archived.clips) == geometry(domain.clips)
    assert len(archived.editorial.edit_log) == 1
    assert archived.editorial.edit_log[0].operation == operation
    assert domain.editorial.edit_log == []
    assert summary["operation"] == operation
