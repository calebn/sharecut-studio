from __future__ import annotations

import json
from pathlib import Path

from podcast_mcp.mcp.tools import timeline
from podcast_mcp.render import rerender_preview
from podcast_mcp.services import EditService, ProjectWorkspace
from test_retained_bleed_alignment import _episode


def _workspace(tmp_path: Path) -> ProjectWorkspace:
    project = _episode(tmp_path)
    rerender_preview(project, reconcile=False)
    ws = ProjectWorkspace(tmp_path / "episode.project.json", project)
    ws.save()
    return ws


def test_gate_service_defaults_to_local_alignment_without_mutating_preview(tmp_path):
    ws = _workspace(tmp_path)
    before = ws.project.model_dump(mode="json")
    preview = EditService(ws).apply_bleed_mute(
        track_id="uncertain", start_sec=0.8, end_sec=3.5, apply=False
    )
    assert preview["alignment"]["proposed_count"] == 1
    assert ws.project.model_dump(mode="json") == before
    result = EditService(ws).apply_bleed_mute(track_id="uncertain", start_sec=0.8, end_sec=3.5)
    assert result["alignment"]["applied_count"] == 1
    reopened = ProjectWorkspace.open(ws.path).project
    assert len(reopened.editorial.retained_bleed_alignments) == 1
    decision = reopened.editorial.retained_bleed_alignments[0]
    assert abs(decision.offset_sec + 0.15) < 0.002


def test_declining_mcp_preview_is_saved_and_respected_on_default_gate(tmp_path):
    ws = _workspace(tmp_path)
    preview = json.loads(
        timeline.align_retained_bleed_tool(
            str(ws.path), track_id="uncertain", start_sec=0.8, end_sec=3.5, apply=False
        )
    )
    decision_id = preview["proposals"][0]["decision_id"]
    timeline.set_retained_bleed_alignment_mode_tool(
        str(ws.path), decision_id, "declined", track_id="uncertain", start_sec=0.8, end_sec=3.5
    )
    reopened = ProjectWorkspace.open(ws.path)
    original = [clip.model_dump() for clip in reopened.project.clips]
    result = EditService(reopened).apply_bleed_mute(
        track_id="uncertain", start_sec=0.8, end_sec=3.5
    )
    assert result["alignment"]["applied_count"] == 0
    assert {row["reason"] for row in result["alignment"]["skipped"]} >= {"saved_declined_decision"}
    assert [clip.model_dump() for clip in reopened.project.clips] == original


def test_alignment_tool_applies_only_requested_region_and_repeat_converges(tmp_path):
    ws = _workspace(tmp_path)
    before = [clip.model_dump() for clip in ws.project.clips if clip.track_id == "uncertain"]
    result = json.loads(
        timeline.align_retained_bleed_tool(
            str(ws.path), track_id="uncertain", start_sec=0.8, end_sec=3.5
        )
    )
    assert result["applied_count"] == 1
    reopened = ProjectWorkspace.open(ws.path)
    assert [
        clip.model_dump() for clip in reopened.project.clips if clip.track_id == "uncertain"
    ] == before
    snapshot = [clip.model_dump() for clip in reopened.project.clips]
    repeated = json.loads(
        timeline.align_retained_bleed_tool(
            str(ws.path), track_id="uncertain", start_sec=0.8, end_sec=3.5
        )
    )
    assert repeated["applied_count"] == 0
    assert [clip.model_dump() for clip in ProjectWorkspace.open(ws.path).project.clips] == snapshot
