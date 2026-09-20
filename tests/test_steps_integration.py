from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.pipeline import steps


def _dialogue_project(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    (tmp_workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    return load_project(minimal_project)


def test_balance_tracks_with_mock_loudness(minimal_project, sample_wav, tmp_workspace):
    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    steps.ingest_tracks(proj, load_defaults())
    with patch.object(FFmpegEngine, "measure_loudness", return_value=-24.0):
        steps.balance_tracks(proj, load_defaults())
    assert proj.track_by_id("host").gain_db != 0.0


def test_assemble_and_export_chain(minimal_project, sample_wav, tmp_workspace):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    proj = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(proj, defaults)
    steps.clean_audio(proj, defaults)
    steps.compress_tracks(proj, defaults)
    steps.assemble_timeline(proj, defaults)
    meta = proj.artifacts_dir() / "track_outputs.json"
    assert meta.is_file()

    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="test line",
            )
        ]
    )
    steps.mix_with_music(proj, defaults)
    steps.master_loudness(proj, defaults)
    steps.export_deliverables(proj, defaults)
    assert (proj.export_dir() / f"{proj.name}.wav").is_file()
    assert (proj.export_dir() / f"{proj.name}.mp3").is_file()
    assert (proj.export_dir() / f"{proj.name}.md").is_file()
