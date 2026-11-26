"""The off-speaker result TypedDicts describe the engine's wire dicts exactly."""

from __future__ import annotations

import json
from typing import Any, get_type_hints

import pytest

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.services.document.off_speaker_results import (
    OffSpeakerApplied,
    OffSpeakerHeld,
    OffSpeakerJudgedWord,
    OffSpeakerKeptGap,
    OffSpeakerKeptGapWord,
    OffSpeakerPreview,
    OffSpeakerRegion,
    OffSpeakerSummary,
)
from test_off_speaker_mute_wire import _build

pytestmark = pytest.mark.unscoped_ok


def _keys(typed: type) -> list[str]:
    return list(get_type_hints(typed))


def _row_keys(rows: list[dict[str, Any]], typed: type) -> None:
    allowed = _keys(typed)
    for row in rows:
        assert list(row) == [k for k in allowed if k in row]
        assert set(allowed) - set(row) <= typed.__optional_keys__


def _engine_summary_keys(ws: ProjectWorkspace, track: str) -> list[str]:
    from podcast_mcp.edits.off_speaker_mute import plan_off_speaker_mutes

    plan = plan_off_speaker_mutes(ws.project, track, defaults=ws.effective_config())
    return list(plan.summary())


def _wire_order(typed: type) -> list[str]:
    return ["dry_run", *(k for k in _keys(typed) if k != "dry_run")]


def test_preview_keys_match_the_engine_summary(tmp_path):
    ws = _build(tmp_path, "gap")
    preview = AnalysisService(ws).preview_off_speaker_mute(track_id="guest")
    assert list(preview) == ["dry_run", *_engine_summary_keys(ws, "guest")]
    assert list(preview) == _wire_order(OffSpeakerPreview)
    assert preview["dry_run"] is True
    assert preview["regions"] and preview["judged_words"] and preview["kept_gaps"]
    _row_keys(preview["regions"], OffSpeakerRegion)
    _row_keys(preview["judged_words"], OffSpeakerJudgedWord)
    _row_keys(preview["kept_gaps"], OffSpeakerKeptGap)
    for gap in preview["kept_gaps"]:
        _row_keys(gap.get("words", []), OffSpeakerKeptGapWord)


def test_apply_keys_match_the_engine_summary_then_apply_keys(tmp_path):
    ws = _build(tmp_path, "gap")
    expected = ["dry_run", *_engine_summary_keys(ws, "guest")]
    result = AnalysisService(ws).mute_off_speaker(track_id="guest")
    assert list(result) == [
        *expected,
        "applied_count",
        "applied_sec",
        "held_count",
        "held_sec",
        "held",
    ]
    assert list(result) == _wire_order(OffSpeakerApplied)
    assert result["dry_run"] is False
    assert result["applied_count"] >= 1


def test_held_rows_follow_the_typed_keys(tmp_path):
    ws = _build(tmp_path, "base", guest_media_sec=8.0)
    result = AnalysisService(ws).mute_off_speaker(track_id="guest")
    assert result["held"]
    _row_keys(result["held"], OffSpeakerHeld)


def test_empty_plan_is_the_summary_shape_with_plain_ints(tmp_path):
    ws = _build(tmp_path, "quiet")
    result = AnalysisService(ws).mute_off_speaker(track_id="guest")
    assert list(result) == _wire_order(OffSpeakerSummary)
    assert result["dry_run"] is False
    for key in ("muted_sec", "audible_muted_sec", "quiet_muted_sec", "own_word_overlap_sec"):
        assert type(result[key]) is int


@pytest.mark.parametrize("kind", ["gap", "quiet", "nocopy"])
def test_results_are_plain_json_dicts(tmp_path, kind):
    ws = _build(tmp_path, kind)
    service = AnalysisService(ws)
    preview = service.preview_off_speaker_mute(track_id="guest")
    result = service.mute_off_speaker(track_id="guest")
    for value in (preview, result):
        assert type(value) is dict
        assert json.loads(json.dumps(value)) == value
