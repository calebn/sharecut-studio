from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import stem_is_fresh
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.pipeline import steps


def _dialogue_project(minimal_project: Path, sample_wav: Path, tmp_workspace: Path):
    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    (tmp_workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)
    return load_project(minimal_project)


def test_render_dialogue_stems_writes_fresh_stem_hash(
    minimal_project: Path, sample_wav: Path, tmp_workspace: Path
):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    steps.render_dialogue_stems(proj, load_defaults())
    assert stem_is_fresh(proj, "host")
    assert (proj.artifacts_dir() / "tracks" / "host.wav").is_file()
    meta = proj.artifacts_dir() / "track_outputs.json"
    assert meta.is_file()
    assert "host" in meta.read_text(encoding="utf-8")


def test_assemble_writes_fresh_stem_hash(
    minimal_project: Path, sample_wav: Path, tmp_workspace: Path
):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    steps.assemble_timeline(proj, load_defaults())
    assert stem_is_fresh(proj, "host")
    assert (proj.artifacts_dir() / "tracks" / "host.wav").is_file()


def test_second_assemble_skips_fresh_stems(
    minimal_project: Path, sample_wav: Path, tmp_workspace: Path
):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    render_calls = {"n": 0}
    original = eng.render_dialogue_track

    def counting_render(*args, **kwargs):
        render_calls["n"] += 1
        return original(*args, **kwargs)

    eng.render_dialogue_track = counting_render  # type: ignore[method-assign]
    with patch("podcast_mcp.pipeline.steps.ffmpeg", return_value=eng):
        steps.assemble_timeline(proj, defaults)
        first_count = render_calls["n"]
        steps.assemble_timeline(proj, defaults)
        second_pass_count = render_calls["n"] - first_count

    assert first_count == 1
    assert second_pass_count == 0


def test_assemble_rerenders_after_edit(
    minimal_project: Path, sample_wav: Path, tmp_workspace: Path
):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.assemble_timeline(proj, defaults)
    assert stem_is_fresh(proj, "host")

    proj.edit_decisions.append(
        EditDecision(
            id="cut1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.5,
            end=1.0,
            applied=True,
        )
    )
    assert not stem_is_fresh(proj, "host")

    render_calls = {"n": 0}
    original = eng.render_dialogue_track

    def counting_render(*args, **kwargs):
        render_calls["n"] += 1
        return original(*args, **kwargs)

    eng.render_dialogue_track = counting_render  # type: ignore[method-assign]
    with patch("podcast_mcp.pipeline.steps.ffmpeg", return_value=eng):
        steps.assemble_timeline(proj, defaults)

    assert render_calls["n"] == 1
    assert stem_is_fresh(proj, "host")
    stem = proj.artifacts_dir() / "tracks" / "host.wav"
    assert eng.probe(stem).duration_sec < 1.8
