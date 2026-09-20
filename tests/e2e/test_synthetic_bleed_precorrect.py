from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.transcript_precorrect import run_precorrect_transcript
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.models import load_project
from podcast_mcp.pipeline import steps as pipeline_steps

pytestmark = pytest.mark.e2e


def _expected_metrics(workspace: Path) -> dict:
    path = workspace.parent / "expected_metrics.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_synthetic_bleed_precorrect_report(synthetic_bleed_workspace: Path) -> None:
    project = load_project(synthetic_bleed_workspace)
    defaults = load_defaults()
    pipeline_steps.ingest_tracks(project, defaults)
    pipeline_steps.render_dialogue_stems(project, defaults)
    pipeline_steps.reconcile_transcript(project, defaults)

    policy = AnalysisPolicy.from_defaults(defaults)
    result = run_precorrect_transcript(project, dry_run=False, policy=policy)

    report = result.report
    assert isinstance(report, dict)
    for key in ("glossary", "speaker_attribution", "cross_track", "deferred_queue", "garble_hits"):
        assert key in report

    metrics = _expected_metrics(synthetic_bleed_workspace)
    assert result.cross_track_applied >= metrics["min_cross_track_precorrect"]
    assert report["cross_track"]["count"] >= metrics["min_cross_track_precorrect"]
