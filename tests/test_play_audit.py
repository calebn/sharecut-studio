from __future__ import annotations

import pytest

from podcast_mcp.engines.play_audit import (
    expected_stem_duration_sec,
    stem_duration_matches_timeline,
    stem_is_fresh,
    track_render_hash,
    write_stem_hash,
)
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)


def test_track_render_hash_changes_with_edit(tmp_path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    project = EpisodeProject.create("h", str(ws))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    )
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    h1 = track_render_hash(project, "host")
    project.edit_decisions.append(
        EditDecision(
            id="e1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            applied=True,
        )
    )
    h2 = track_render_hash(project, "host")
    assert h1 != h2


def test_track_render_hash_changes_with_join_mode(tmp_path) -> None:
    from podcast_mcp.models import ClipJoinMode

    ws = tmp_path / "ws_join"
    ws.mkdir()
    project = EpisodeProject.create("join", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
            fade_out_ms=10,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=5.0,
            source_end=10.0,
            timeline_start=5.0,
            fade_in_ms=10,
            join_in_mode=ClipJoinMode.FADE,
        ),
    ]
    h1 = track_render_hash(project, "host")
    project.clips[1].join_in_mode = ClipJoinMode.CROSSFADE
    h2 = track_render_hash(project, "host")
    assert h1 != h2


def test_track_render_hash_changes_with_effect_bypass(tmp_path) -> None:
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    ws = tmp_path / "ws_bypass"
    ws.mkdir()
    project = EpisodeProject.create("bypass", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.mix.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[
                ProcessingEffect(effect="highpass", params={"frequency": 80}),
            ],
        )
    ]
    h1 = track_render_hash(project, "host")
    project.processing_chains[0].effects[0].bypass = True
    h2 = track_render_hash(project, "host")
    assert h1 != h2


def test_stem_fresh_after_write(tmp_path, sample_wav) -> None:
    ws = tmp_path / "ws2"
    ws.mkdir()
    (ws / "artifacts" / "tracks").mkdir(parents=True)
    project = EpisodeProject.create("h2", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    stem = ws / "artifacts" / "tracks" / "host.wav"
    stem.write_bytes(sample_wav.read_bytes())
    write_stem_hash(project, "host")
    assert stem_is_fresh(project, "host")


def test_stem_not_fresh_when_duration_mismatches(tmp_path, sample_wav) -> None:
    ws = tmp_path / "ws3"
    ws.mkdir()
    (ws / "artifacts" / "tracks").mkdir(parents=True)
    project = EpisodeProject.create("h3", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    # Timeline extent ~1s, stem is ~2s (source-length bug).
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
        )
    ]
    stem = ws / "artifacts" / "tracks" / "host.wav"
    stem.write_bytes(sample_wav.read_bytes())
    write_stem_hash(project, "host")
    assert not stem_is_fresh(project, "host")
    assert expected_stem_duration_sec(project, "host") == pytest.approx(1.0)
    assert not stem_duration_matches_timeline(project, "host")
