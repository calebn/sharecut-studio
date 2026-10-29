from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
from podcast_mcp.mcp.tools.edits import apply_edit_plan_tool
from podcast_mcp.mcp.tools.history import history_list, history_status_tool, history_undo
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.util.coded_error import CodedValueError
from test_apply_edit_plan_tool_pin import _clips, _decisions, _entry
from test_edit_modes import episode as _episode_fixture

episode = _episode_fixture


def _rows(path: Path) -> list[dict]:
    return DocumentSyncService.open(path).store.commands_after(0)


def _types(path: Path) -> list[str]:
    return [row["type"] for row in _rows(path)]


def _total(path: Path) -> int:
    return json.loads(history_status_tool(str(path)))["total"]


def _labels(path: Path) -> list[str]:
    return [e["label"] for e in json.loads(history_list(str(path)))["entries"]]


def _refused(path: Path, plan: list) -> CodedValueError:
    before = path.read_bytes()
    with pytest.raises(CodedValueError) as raised:
        apply_edit_plan_tool(str(path), plan)
    assert raised.value.code == "invalid_payload"
    assert path.read_bytes() == before
    assert _types(path) == []
    assert _total(path) == 0
    return raised.value


def test_a_pending_plan_journals_one_apply_edit_plan_row(episode):
    reply = json.loads(apply_edit_plan_tool(str(episode), [_entry(2, 3), _entry(4, 5)]))
    assert reply["entries_added"] == 2
    rows = _rows(episode)
    assert [row["type"] for row in rows] == ["ApplyEditPlan"]
    assert rows[0]["payload"]["result"]["entries_added"] == 2


def test_an_applied_plan_journals_one_row_and_keeps_its_history_steps(episode):
    clips = _clips(episode)
    apply_edit_plan_tool(str(episode), [_entry(15, 16, applied=True)])
    assert _types(episode) == ["ApplyEditPlan"]
    assert _labels(episode) == ["before apply edit plan", "after apply edit plan"]
    assert _clips(episode) != clips
    history_undo(str(episode))
    assert _clips(episode) == clips


def test_an_empty_plan_journals_one_row_and_the_baseline_step(episode):
    reply = json.loads(apply_edit_plan_tool(str(episode), []))
    assert reply["entries_added"] == 0
    assert _types(episode) == ["ApplyEditPlan"]
    assert _total(episode) == 1
    apply_edit_plan_tool(str(episode), [])
    assert _types(episode) == ["ApplyEditPlan", "ApplyEditPlan"]
    assert _total(episode) == 1


def test_the_reply_keys_are_unchanged(episode):
    reply = json.loads(apply_edit_plan_tool(str(episode), [_entry(2, 3)], review_required=False))
    assert reply == {
        "operation": "apply_edit_plan",
        "entries_added": 1,
        "review_required": False,
        "use_inaudible_opt": None,
    }


def test_a_bad_later_entry_writes_no_row_and_no_history_step(episode):
    before = episode.read_bytes()
    plan = [_entry(2, 3), _entry(4, 5), {"track_id": "host", "start": 6}]
    with pytest.raises(CodedValueError) as raised:
        apply_edit_plan_tool(str(episode), plan)
    assert raised.value.code == "invalid_payload"
    assert "edits.2.end" in str(raised.value)
    assert episode.read_bytes() == before
    assert _types(episode) == []
    assert _total(episode) == 0


def test_a_semantically_bad_later_entry_writes_no_row_either(episode):
    before = episode.read_bytes()
    with pytest.raises(CodedValueError) as raised:
        apply_edit_plan_tool(str(episode), [_entry(2, 3), _entry(3, 2)])
    assert raised.value.code == "range_end_before_start"
    assert episode.read_bytes() == before
    assert _types(episode) == []
    assert _total(episode) == 0


@pytest.mark.refine_gate
def test_a_pending_refine_writes_no_row(episode):
    before = episode.read_bytes()
    with pytest.raises(TranscriptRefineRequiredError):
        apply_edit_plan_tool(str(episode), [_entry(2, 3)])
    assert episode.read_bytes() == before
    assert _types(episode) == []


def test_an_entry_without_flags_falls_back_to_the_tool_flags(episode):
    apply_edit_plan_tool(
        str(episode),
        [{"track_id": "host", "start": 2, "end": 3}],
        review_required=False,
        use_inaudible_opt=False,
    )
    assert _decisions(episode) == [("host", 2.0, 3.0, 10, "agent:plan", False, False)]


def test_an_explicit_null_use_inaudible_opt_overrides_the_tool_flag(episode):
    apply_edit_plan_tool(
        str(episode),
        [{"track_id": "host", "start": 2, "end": 3, "use_inaudible_opt": None}],
        use_inaudible_opt=False,
    )
    assert _decisions(episode) == [("host", 2.0, 2.975, 10, "agent:plan", True, False)]


def test_extra_keys_on_an_entry_are_ignored(episode):
    apply_edit_plan_tool(str(episode), [_entry(2, 3, label="x", suggested_action="remove")])
    assert len(_decisions(episode)) == 1


def test_numeric_strings_and_a_float_crossfade_still_coerce(episode):
    apply_edit_plan_tool(
        str(episode),
        [{"track_id": "host", "start": "2", "end": "3.0", "crossfade_ms": 10.7}],
        use_inaudible_opt=False,
    )
    assert _decisions(episode) == [("host", 2.0, 3.0, 10, "agent:plan", True, False)]


def test_a_false_string_on_review_required_is_false(episode):
    apply_edit_plan_tool(str(episode), [_entry(2, 3, review_required="false")])
    assert _decisions(episode) == [("host", 2.0, 3.0, 10, "agent:plan", False, False)]


@pytest.mark.parametrize("plan_flag", [True, False])
def test_a_null_review_required_takes_the_plan_value(episode, plan_flag):
    apply_edit_plan_tool(
        str(episode), [_entry(2, 3, review_required=None)], review_required=plan_flag
    )
    assert _decisions(episode) == [("host", 2.0, 3.0, 10, "agent:plan", plan_flag, False)]


def test_a_false_string_on_applied_stages_instead_of_cutting(episode):
    clips = _clips(episode)
    apply_edit_plan_tool(str(episode), [_entry(15, 16, applied="false")])
    assert _clips(episode) == clips
    assert len(_decisions(episode)) == 1


@pytest.mark.parametrize(
    "entry,field",
    [
        ({"start": 1, "end": 2}, "track_id"),
        ({"track_id": "host", "end": 2}, "start"),
        ({"track_id": "host", "start": 1}, "end"),
    ],
)
def test_a_missing_key_is_invalid_payload(episode, entry, field):
    assert f"edits.0.{field}" in str(_refused(episode, [entry]))


@pytest.mark.parametrize(
    "entry,field",
    [
        ({"track_id": "host", "start": "a", "end": 2}, "start"),
        ({"track_id": "host", "start": 1, "end": "b"}, "end"),
        ({"track_id": "host", "start": 1, "end": 2, "crossfade_ms": "x"}, "crossfade_ms"),
    ],
)
def test_a_non_numeric_value_is_invalid_payload(episode, entry, field):
    message = str(_refused(episode, [entry]))
    assert f"edits.0.{field}" in message
    assert "'a'" not in message


@pytest.mark.parametrize("crossfade_ms", ["abc", "10.5", "1e3"])
def test_a_text_crossfade_ms_is_refused_without_int_raw_text(episode, crossfade_ms):
    message = str(_refused(episode, [_entry(2, 3, crossfade_ms=crossfade_ms)]))
    assert "edits.0.crossfade_ms" in message
    assert "invalid literal" not in message
    assert crossfade_ms not in message


@pytest.mark.parametrize(
    "entry",
    [
        _entry(2, 3, applied=None),
        _entry(2, 3, reason=None),
        {"track_id": None, "start": 2, "end": 3},
        _entry(2, 3, review_required="maybe"),
        _entry(float("nan"), 3),
        _entry(2, float("inf")),
        _entry(2, 3, crossfade_ms=float("inf")),
    ],
    ids=["applied-none", "reason-none", "track-none", "bad-bool", "nan", "inf", "crossfade-inf"],
)
def test_other_malformed_entries_are_invalid_payload(episode, entry):
    _refused(episode, [entry])


def test_a_plan_entry_that_is_not_an_object_is_invalid_payload(episode):
    _refused(episode, ["nope"])
