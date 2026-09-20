from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.transcript_reconcile import audibility_map, overlap_duplicate_report
from podcast_mcp.models import load_project
from podcast_mcp.pipeline import steps as pipeline_steps

pytestmark = pytest.mark.e2e


def _expected_metrics(workspace: Path) -> dict:
    path = workspace.parent / "expected_metrics.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_synthetic_bleed_detects_and_suppresses(synthetic_bleed_workspace: Path) -> None:
    project = load_project(synthetic_bleed_workspace)
    defaults = load_defaults()
    pipeline_steps.ingest_tracks(project, defaults)
    pipeline_steps.render_dialogue_stems(project, defaults)
    pipeline_steps.reconcile_transcript(project, defaults)

    metrics = _expected_metrics(synthetic_bleed_workspace)
    rows = audibility_map(project)
    bleed_total = sum(1 for r in rows if r.get("audibility_status") == "bleed")
    bleed_host = sum(
        1 for r in rows if r.get("track_id") == "host" and r.get("audibility_status") == "bleed"
    )
    suppressed = sum(
        1
        for tr in project.transcripts
        for w in tr.words
        if w.suppressed and w.audibility_status == "bleed"
    )

    assert bleed_total >= metrics["min_bleed_words_total"]
    assert bleed_host >= metrics["min_bleed_words_host"]
    assert suppressed >= metrics["min_bleed_words_total"]

    overlap = overlap_duplicate_report(project)
    assert overlap["pair_count"] >= metrics.get("min_overlap_pairs", 1)
    assert overlap["text_match_count"] <= metrics.get("max_text_match_after_reconcile", 0)

    bleed_window = overlap_duplicate_report(project, start_sec=12.0, end_sec=16.0)
    assert bleed_window["text_match_count"] <= metrics.get("max_text_match_after_reconcile", 0)
