from __future__ import annotations

import pytest

from pause_policy_public_helpers import configure, defaults, files, pause, project, workspace
from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
from podcast_mcp.models import ClipMuteRegion, TranscriptWord, load_project
from podcast_mcp.services.document import EditService
from podcast_mcp.util.coded_error import CodedError


@pytest.mark.parametrize("exclusion", ["clip-mute", "ignored-render"])
def test_excluded_original_cannot_supply_the_pause_floor(tmp_path, monkeypatch, exclusion):
    cfg = defaults()
    cfg["tighten"].update(min_retained_solo_pause_sec=1.8, min_retained_pause_sec=1.8)
    configure(monkeypatch, cfg)
    control = project(tmp_path / "control", topology="deleted")
    control.edit_decisions = [pause("original", start=0.3, end=2, gap=None)]
    control_ws = workspace(control)
    assert EditService(control_ws).approve(["original"]) == 1
    control_saved = load_project(control_ws.path)
    assert control_saved.editorial.edit_log[0].params["replace_gap_sec"] is None
    assert control_saved.editorial.edit_log[0].params["loss_sec"] == pytest.approx(0.3)
    assert control_saved.timeline.duration_sec == pytest.approx(3)

    result = project(tmp_path / "excluded", topology="deleted")
    if exclusion == "clip-mute":
        result.clips[0].mute_regions = [
            ClipMuteRegion(start_s=0.7, end_s=1.05, fade_out_ms=0, fade_in_ms=0)
        ]
    else:
        result.transcripts[0].words.append(
            TranscriptWord(text="ignored", start=0.7, end=1.05, ignored=True)
        )
    result.edit_decisions = [pause("excluded", start=0.3, end=2, gap=None)]
    ws = workspace(result)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    snapshot = ws.project.model_copy(deep=True)
    with pytest.raises(CodedError) as suggested:
        apply_for_suggested(snapshot, resolve_pending_preview(snapshot, "excluded"))
    assert [(h.edit_id, h.reason, h.detail) for h in suggested.value.held] == [
        ("excluded", "pause_air", "no_air")
    ]
    assert snapshot.model_dump(mode="json") == before_model
    with pytest.raises(CodedError) as saved:
        EditService(ws).approve(["excluded"])
    assert [(h.edit_id, h.reason, h.detail) for h in saved.value.held] == [
        ("excluded", "pause_air", "no_air")
    ]
    assert ws.project.model_dump(mode="json") == before_model
    assert EditService(ws).apply_auto() == 0
    assert ws.project.model_dump(mode="json") == before_model
    assert files(tmp_path) == before_files
    assert [(e.id, e.applied) for e in load_project(ws.path).edit_decisions] == [
        ("excluded", False)
    ]
