"""Neural join-quality graceful fallback (no torch required in CI)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from podcast_mcp.edits import join_neural
from podcast_mcp.edits.join_continuity import (
    JoinContinuityConfig,
    assess_existing_join,
)
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)


def test_joinqc_unavailable_returns_none() -> None:
    with patch.object(join_neural, "joinqc_available", return_value=False):
        assert join_neural.nisqa_discontinuity_delta(None, "t", 1.0) is None  # type: ignore[arg-type]
        assert join_neural.wavlm_continuity_z(None, "t", 1.0) is None  # type: ignore[arg-type]


def test_assess_existing_join_without_neural(minimal_project: Path, sample_wav: Path) -> None:
    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    save_project(project, minimal_project)
    project = load_project(minimal_project)
    cfg = JoinContinuityConfig(neural=True, calibrate=False)
    with (
        patch(
            "podcast_mcp.edits.join_neural.nisqa_discontinuity_delta",
            return_value=None,
        ),
        patch(
            "podcast_mcp.edits.join_neural.wavlm_continuity_z",
            return_value=None,
        ),
    ):
        rep = assess_existing_join(project, "host", 1.0, timebase="source", config=cfg)
    assert rep.neural is not None
    assert rep.neural.get("available") is False
    assert "disclaimer" in rep.to_dict()


def test_neural_hits_elevate_when_monkeypatched(minimal_project: Path, sample_wav: Path) -> None:
    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.clips = [
        Clip(
            id="full",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    save_project(project, minimal_project)
    project = load_project(minimal_project)
    cfg = JoinContinuityConfig(neural=True, calibrate=False)
    with (
        patch(
            "podcast_mcp.edits.join_neural.nisqa_discontinuity_delta",
            return_value={"discontinuity_delta": 0.9, "mos_delta": -0.5},
        ),
        patch(
            "podcast_mcp.edits.join_neural.wavlm_continuity_z",
            return_value={"z": 6.0},
        ),
    ):
        rep = assess_existing_join(project, "host", 1.0, timebase="source", config=cfg)
    names = {h.name for h in rep.detectors}
    assert "nisqa_discontinuity" in names
    assert "wavlm_continuity" in names
    assert rep.neural and rep.neural.get("available") is True
