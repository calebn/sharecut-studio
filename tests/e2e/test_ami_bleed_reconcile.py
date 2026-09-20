from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.transcript_reconcile import audibility_map, overlap_duplicate_report
from podcast_mcp.models import load_project
from podcast_mcp.pipeline import steps as pipeline_steps

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_real]


def _expected_metrics(workspace: Path) -> dict:
    path = workspace.parent / "expected_metrics.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_ami_bleed_reconcile(ami_bleed_workspace: Path) -> None:
    project = load_project(ami_bleed_workspace)
    defaults = load_defaults()
    pipeline_steps.ingest_tracks(project, defaults)
    pipeline_steps.assemble_timeline(project, defaults)
    pipeline_steps.reconcile_transcript(project, defaults)

    metrics = _expected_metrics(ami_bleed_workspace)
    rows = audibility_map(project)
    bleed_total = sum(1 for r in rows if r.get("audibility_status") == "bleed")

    assert bleed_total >= metrics["min_bleed_words_total"]

    overlap = overlap_duplicate_report(project)
    assert overlap["pair_count"] >= 1
    assert metrics.get("overlap_windows", 0) >= 1
