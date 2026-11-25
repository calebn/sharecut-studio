"""mix_with_music merges its fade into the envelope: real audio, byte identity, re-runs."""

from __future__ import annotations

import hashlib
import json
import uuid
import wave
from pathlib import Path

import numpy as np
import pytest

from conftest import _lavfi_wav
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import premix_path, read_stem_hash, track_render_hash
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.pipeline import steps
from podcast_mcp.services.document_sync import submit_host_command_result
from test_pipeline_steps_extended import _dialogue_project

DEPTH_DB = -18.0


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _rms_db(path: Path, start: float, end: float) -> float:
    with wave.open(str(path)) as wav:
        rate, width, channels = wav.getframerate(), wav.getsampwidth(), wav.getnchannels()
        assert width == 2
        wav.setpos(int(start * rate))
        raw = wav.readframes(int((end - start) * rate))
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    samples = samples.reshape(-1, channels)
    return float(20 * np.log10(np.sqrt(np.mean(samples**2)) + 1e-12))


def _points(project, track_id="bed") -> list[tuple[str, float, float]]:
    envelope = project.volume_envelope_for(track_id)
    assert envelope is not None
    return [(p.id, p.time, p.value) for p in envelope.points]


def _stem(project, track_id="bed") -> Path:
    rendered = json.loads((project.artifacts_dir() / "track_outputs.json").read_text())
    return Path(rendered[track_id])


@pytest.fixture
def engine_ready() -> None:
    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")


@pytest.fixture
def bed_wav(tmp_path: Path) -> Path:
    return _lavfi_wav(tmp_path / "bed6.wav", "sine=frequency=440:duration=6")


def _mixed_project(minimal_project, wav, tmp_workspace, defaults, words=True):
    project = _dialogue_project(minimal_project, wav, tmp_workspace)
    if words:
        project.transcripts = [
            Transcript(
                track_id="host",
                words=[
                    TranscriptWord(text="hello", start=3.0, end=3.5),
                    TranscriptWord(text="there", start=3.5, end=4.0),
                ],
            )
        ]
        save_project(project, minimal_project)
        project = load_project(minimal_project)
    steps.ingest_tracks(project, defaults)
    steps.assemble_timeline(project, defaults)
    return project


def test_a_rerun_of_the_mix_keeps_the_dip_in_the_stem_and_the_premix(
    minimal_project, bed_wav, tmp_workspace, engine_ready
) -> None:
    """On develop the second mix rebuilt the envelope and the bed came back flat under speech."""
    defaults = load_defaults()
    defaults["mix"]["fade_in_sec"] = 0.5
    defaults["mix"]["fade_out_sec"] = 0.5
    project = _mixed_project(minimal_project, bed_wav, tmp_workspace, defaults)
    steps.mix_with_music(project, defaults)
    save_project(project, minimal_project)
    result = submit_host_command_result(str(minimal_project), "ApplyDucking", {})
    assert result["applied"] is True
    project = load_project(minimal_project)
    ducked = _points(project)
    assert any(i.startswith("duck:") for i, _, _ in ducked)

    steps.mix_with_music(project, defaults)
    after_first = _points(project)
    stem_first, premix_first = _sha(_stem(project)), _sha(premix_path(project))
    assert after_first == ducked
    outside = _rms_db(_stem(project), 1.0, 2.0)
    under = _rms_db(_stem(project), 3.3, 3.9)
    assert abs((under - outside) - DEPTH_DB) <= 3.0

    steps.mix_with_music(project, defaults)
    assert _points(project) == after_first
    assert _sha(_stem(project)) == stem_first
    assert _sha(premix_path(project)) == premix_first


def test_a_project_without_extra_points_renders_the_same_bytes_as_the_legacy_envelope(
    minimal_project, bed_wav, tmp_workspace, tmp_path, engine_ready
) -> None:
    defaults = load_defaults()
    project = _mixed_project(minimal_project, bed_wav, tmp_workspace, defaults, words=False)
    steps.mix_with_music(project, defaults)
    new_points = _points(project)
    new_hash = track_render_hash(project, "bed", defaults=defaults)
    new_stem, new_premix = _sha(_stem(project)), _sha(premix_path(project))
    assert read_stem_hash(project, "bed") == new_hash

    # The envelope the step wrote before this change: four uuid points, same times and values.
    dur = 6.0
    legacy = [(0.0, 0.0), (2.0, 1.0), (max(2.0, dur - 3.0), 1.0), (dur, 0.0)]
    assert [(t, v) for _, t, v in new_points] == legacy
    project.automation_envelopes = [
        AutomationEnvelope(
            track_id="bed",
            points=[AutomationPoint(id=str(uuid.uuid4()), time=t, value=v) for t, v in legacy],
        )
    ]
    assert track_render_hash(project, "bed", defaults=defaults) == new_hash
    steps.mix_with_music(project, defaults)
    # The legacy-shaped envelope is adopted: same payload, same stem, same premix bytes.
    assert [(t, v) for _, t, v in _points(project)] == legacy
    assert all(i.startswith("mix:fade:") for i, _, _ in _points(project))
    assert _sha(_stem(project)) == new_stem
    assert _sha(premix_path(project)) == new_premix
    eng = FFmpegEngine()
    track = project.track_by_id("bed")
    direct = tmp_path / "legacy-stem.wav"
    eng.render_dialogue_track(project, track, direct, defaults=defaults)
    assert _sha(direct) == new_stem
