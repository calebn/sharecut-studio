from __future__ import annotations

from podcast_mcp.models import EpisodeProject, MediaAsset, ProcessingEffect, Track, TrackRole
from podcast_mcp.pipeline.helpers import artifact, ensure_dialogue_clips, set_or_replace_chain


def test_ensure_dialogue_clips_creates_clip():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    )
    ensure_dialogue_clips(proj)
    assert len(proj.clips) == 1
    assert proj.clips[0].source_end == 10.0


def test_set_or_replace_chain():
    proj = EpisodeProject.create("t", "/tmp/ws")
    set_or_replace_chain(
        proj,
        "host",
        [ProcessingEffect(effect="highpass", params={"frequency": 90})],
    )
    assert len(proj.processing_chains) == 1
    set_or_replace_chain(
        proj,
        "host",
        [ProcessingEffect(effect="acompressor", params={})],
    )
    assert len(proj.processing_chains) == 1
    assert proj.processing_chains[0].effects[0].effect == "acompressor"


def test_artifact_path_under_workspace(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()
    p = artifact(proj, "nested/out.json")
    assert "artifacts" in str(p)
