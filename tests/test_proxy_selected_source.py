from __future__ import annotations

import subprocess
import wave
from pathlib import Path
from unittest.mock import ANY, Mock

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import timeline_render
from podcast_mcp.engines.bleed_gate import BleedGatePlan
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import EpisodeProject, MediaAsset, ProcessingChain, ProcessingEffect, Track


def _write(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(16000)
        stream.writeframes(samples.astype("<i2").tobytes())


def _read(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as stream:
        return np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2")


def _project(directory: Path) -> tuple[EpisodeProject, Track]:
    project = EpisodeProject.create("Selected source", str(directory))
    track = Track(id="origin", label="Origin", media=MediaAsset(path="primary.wav"))
    project.tracks = [track]
    _write(directory / "primary.wav", np.full(16000, 1000))
    return project, track


@pytest.mark.parametrize("filled", [False, True])
def test_default_and_explicit_primary_keep_legacy_command(
    tmp_path: Path, monkeypatch, filled: bool
) -> None:
    project, track = _project(tmp_path)
    fill = tmp_path / "fill.wav"
    _write(fill, np.full(16000, 300))
    monkeypatch.setattr(
        timeline_render, "current_gate_fill_path", lambda *_: fill if filled else None
    )
    engine = FFmpegEngine()
    run = Mock(wraps=timeline_render.run)
    monkeypatch.setattr(timeline_render, "run", run)
    target = tmp_path / "baseline.wav"
    timeline_render.render_source_with_chain(
        project, track, target, engine=engine, defaults=load_defaults()
    )
    legacy = run.call_args
    timeline_render.render_source_with_chain(
        project,
        track,
        target,
        engine=engine,
        selected_source_path=tmp_path / "primary.wav",
        defaults=load_defaults(),
    )
    assert run.call_args == legacy
    inputs = ["-i", str(tmp_path / "primary.wav")]
    filters = ["-af", "anull"]
    if filled:
        inputs += ["-i", str(fill)]
        filters = [
            "-filter_complex",
            "[0:a][1:a]amix=inputs=2:normalize=0:duration=first,aformat=sample_fmts=s16,anull",
        ]
    assert legacy.args[0] == [
        engine.ffmpeg,
        "-y",
        *inputs,
        *filters,
        "-acodec",
        "pcm_s16le",
        str(target),
    ]
    np.testing.assert_array_equal(_read(target), np.full(16000, 1300 if filled else 1000))


def test_selected_secondary_keeps_origin_fx_gate_and_fill_eligibility(
    tmp_path: Path, monkeypatch
) -> None:
    project, track = _project(tmp_path)
    track.transcript_gate = True
    project.processing_chains = [
        ProcessingChain(
            track_id=track.id,
            effects=[ProcessingEffect(effect="highpass", params={"frequency": 100})],
        )
    ]
    selected = tmp_path / "secondary.wav"
    _write(selected, np.resize(np.array([7000, -3000, 1000, -5000]), 16000))
    fill = tmp_path / "fill.wav"
    _write(fill, np.full(16000, 300))
    monkeypatch.setattr(timeline_render, "current_gate_fill_path", lambda *_: fill)
    plan = BleedGatePlan(attenuation_spans=((0.2, 0.4),), fade_sec=0)
    gate_builder = Mock(return_value=plan)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan", gate_builder
    )
    before = project.model_dump(mode="json")
    engine = FFmpegEngine()
    target = tmp_path / "selected.wav"
    timeline_render.render_source_with_chain(
        project,
        track,
        target,
        engine=engine,
        selected_source_path=selected,
        defaults=load_defaults(),
    )
    expected = tmp_path / "expected.wav"
    subprocess.run(
        [
            engine.ffmpeg,
            "-y",
            "-i",
            str(selected),
            "-af",
            "highpass=f=100",
            "-acodec",
            "pcm_s16le",
            str(expected),
        ],
        check=True,
        capture_output=True,
    )
    samples = _read(expected).copy()
    samples[3200:6400] = 0
    np.testing.assert_array_equal(_read(target), samples)
    gate_builder.assert_called_once_with(project, "origin", source_clock=True, defaults=ANY)
    assert project.track_by_id("origin") is track
    assert project.model_dump(mode="json") == before


def test_selected_source_can_render_without_primary_media(tmp_path: Path) -> None:
    project, track = _project(tmp_path)
    track.media = None
    target = tmp_path / "selected.wav"
    timeline_render.render_source_with_chain(
        project,
        track,
        target,
        selected_source_path=tmp_path / "primary.wav",
        defaults=load_defaults(),
    )
    np.testing.assert_array_equal(_read(target), np.full(16000, 1000))
    with pytest.raises(ValueError, match="has no media"):
        timeline_render.render_source_with_chain(project, track, target, defaults=load_defaults())


@pytest.mark.parametrize("outside", [False, True])
def test_selected_source_still_requires_present_workspace_media(
    tmp_path: Path, outside: bool
) -> None:
    project, track = _project(tmp_path)
    selected = tmp_path.parent / "outside.wav" if outside else tmp_path / "missing.wav"
    error = ValueError if outside else FileNotFoundError
    with pytest.raises(error):
        timeline_render.render_source_with_chain(
            project,
            track,
            tmp_path / "selected.wav",
            selected_source_path=selected,
            defaults=load_defaults(),
        )
    assert not (tmp_path / "selected.wav").exists()
