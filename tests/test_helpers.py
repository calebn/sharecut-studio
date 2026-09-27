from __future__ import annotations

from podcast_mcp.models import EpisodeProject, MediaAsset, ProcessingEffect, Track, TrackRole
from podcast_mcp.pipeline.helpers import (
    artifact,
    ensure_dialogue_clips,
    replace_effect,
    set_or_replace_chain,
)


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


def test_replace_effect_appends_when_absent():
    effects = [ProcessingEffect(effect="highpass", params={"frequency": 90})]
    new = ProcessingEffect(effect="acompressor", params={"ratio": 3})
    result = replace_effect(effects, new)
    assert [e.effect for e in result] == ["highpass", "acompressor"]
    assert len(effects) == 1


def test_replace_effect_replaces_in_place_and_keeps_bypass():
    effects = [
        ProcessingEffect(effect="highpass", params={"frequency": 90}),
        ProcessingEffect(effect="acompressor", params={"ratio": 2}, bypass=True),
        ProcessingEffect(effect="agate", params={}),
    ]
    new = ProcessingEffect(effect="acompressor", params={"ratio": 4})
    result = replace_effect(effects, new)
    assert [e.effect for e in result] == ["highpass", "acompressor", "agate"]
    assert result[1].params["ratio"] == 4
    assert result[1].bypass is True
    assert new.bypass is False


def test_replace_effect_collapses_duplicates():
    effects = [
        ProcessingEffect(effect="acompressor", params={"ratio": 2}),
        ProcessingEffect(effect="highpass", params={"frequency": 90}),
        ProcessingEffect(effect="acompressor", params={"ratio": 3}),
    ]
    new = ProcessingEffect(effect="acompressor", params={"ratio": 5})
    result = replace_effect(effects, new)
    assert [e.effect for e in result] == ["acompressor", "highpass"]
    assert result[0].params["ratio"] == 5
