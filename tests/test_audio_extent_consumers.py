from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.strip_silence import strip_silence
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)
from podcast_mcp.pipeline.steps import ingest_tracks
from podcast_mcp.util.coded_error import CodedValueError


@pytest.fixture(scope="module")
def chained_ogg(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("extent-consumers")
    engine = FFmpegEngine()
    parts = []
    for index, seconds in enumerate((2, 3)):
        part = root / f"part{index}.ogg"
        subprocess.run(
            [
                engine.ffmpeg,
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"sine=r=48000:duration={seconds}",
                "-c:a",
                "flac",
                str(part),
            ],
            check=True,
            capture_output=True,
        )
        parts.append(part)
    path = root / "joined.ogg"
    path.write_bytes(b"".join(part.read_bytes() for part in parts))
    decoded = subprocess.run(
        [
            engine.ffmpeg,
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-",
        ],
        check=True,
        capture_output=True,
    )
    assert len(decoded.stdout) / 96000 == pytest.approx(5.0)
    assert engine.probe(path).duration_estimated
    return path


def _project(tmp_path: Path, path: Path) -> EpisodeProject:
    (tmp_path / "joined.ogg").write_bytes(path.read_bytes())
    project = EpisodeProject.create("extent", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="joined.ogg", duration_sec=5, sample_rate=48000, channels=1),
        )
    ]
    project.automation_envelopes = [
        AutomationEnvelope(track_id="host", points=[AutomationPoint(id="gain", time=4, value=0.5)])
    ]
    return project


def test_pipeline_ingest_refuses_uncertain_extent_before_updating_any_track(
    tmp_path, chained_ogg, monkeypatch
):
    project = _project(tmp_path, chained_ogg)
    project.timeline.tracks.insert(
        0,
        Track(
            id="valid",
            label="Valid",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=str(chained_ogg.parent / "part0.ogg"), duration_sec=9),
        ),
    )
    monkeypatch.setattr("podcast_mcp.pipeline.steps.ensure_project_waveforms", lambda *a, **k: 0)
    monkeypatch.setattr("podcast_mcp.pipeline.steps.ensure_room_tone_pools", lambda *a, **k: None)
    before = project.model_dump()

    with pytest.raises(CodedValueError) as error:
        ingest_tracks(project, {})

    assert error.value.code == "invalid_audio"
    assert project.model_dump() == before


def test_strip_silence_refuses_uncertain_extent_without_losing_existing_audio(
    tmp_path, chained_ogg
):
    project = _project(tmp_path, chained_ogg)
    project.timeline.clips = [
        Clip(id="full", track_id="host", source_start=0, source_end=5, timeline_start=0)
    ]
    project.timeline.duration_sec = 5
    before = project.model_dump()

    with pytest.raises(CodedValueError) as error:
        strip_silence(project, "host", defaults=load_defaults())

    assert error.value.code == "invalid_audio"
    assert project.model_dump() == before


@pytest.mark.parametrize("render", ["full", "segment"])
def test_implicit_track_render_refuses_uncertain_extent_before_replacing_output(
    tmp_path, chained_ogg, render
):
    project = _project(tmp_path, chained_ogg)
    before = project.model_dump()
    output = tmp_path / "render.wav"
    output.write_bytes(b"existing render")

    with pytest.raises(CodedValueError) as error:
        if render == "full":
            render_track_from_timeline(project, project.tracks[0], output, {})
        else:
            render_track_segment(project, "host", 0, 5, output, {})

    assert error.value.code == "invalid_audio"
    assert project.model_dump() == before
    assert output.read_bytes() == b"existing render"
