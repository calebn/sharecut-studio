"""apply_edit_plan_tool keeps its reply, errors, effects and history steps (#1847)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
from podcast_mcp.mcp.tools.edits import apply_edit_plan_tool
from podcast_mcp.mcp.tools.history import history_list, history_status_tool, history_undo
from podcast_mcp.models import load_project
from podcast_mcp.util.coded_error import CodedValueError
from test_edit_modes import episode as _episode_fixture

episode = _episode_fixture

_REPLY_KEYS = {"operation", "entries_added", "review_required", "use_inaudible_opt"}
_RANGE_ERROR = "end must be greater than start. Pick an end after the start."
_SCOPE_ERROR = (
    "A selected cut was not applied because the selected audio no longer has one complete, "
    "continuous placement. Select the part to cut on the timeline, or reject the held cuts."
)


def _entry(start: float, end: float, **extra) -> dict:
    return {"track_id": "host", "start": start, "end": end, "use_inaudible_opt": False} | extra


def _decisions(path: Path) -> list[tuple]:
    rows = (
        (
            d.track_id,
            round(d.start, 6),
            round(d.end, 6),
            d.crossfade_ms,
            d.reason,
            d.review_required,
            d.applied,
        )
        for d in load_project(path).edit_decisions
    )
    return sorted(rows, key=lambda row: (row[0], row[1]))


def _clips(path: Path) -> list[tuple]:
    return sorted(
        (c.track_id, round(c.source_start, 6), round(c.source_end, 6), round(c.timeline_start, 6))
        for c in load_project(path).clips
    )


def _status(path: Path) -> dict:
    return json.loads(history_status_tool(str(path)))


def _labels(path: Path) -> list[str]:
    return [e["label"] for e in json.loads(history_list(str(path)))["entries"]]


def _untouched(path: Path, before: bytes) -> None:
    assert path.read_bytes() == before
    assert _status(path)["total"] == 0


def test_pending_plan_reply_has_exactly_the_four_keys(episode):
    reply = json.loads(apply_edit_plan_tool(str(episode), [_entry(2, 3)]))
    assert set(reply) == _REPLY_KEYS
    assert reply == {
        "operation": "apply_edit_plan",
        "entries_added": 1,
        "review_required": True,
        "use_inaudible_opt": None,
    }


def test_reply_counts_every_entry_and_echoes_the_flags(episode):
    reply = json.loads(
        apply_edit_plan_tool(
            str(episode),
            [_entry(2, 3), _entry(4, 5)],
            review_required=False,
            use_inaudible_opt=False,
        )
    )
    assert reply == {
        "operation": "apply_edit_plan",
        "entries_added": 2,
        "review_required": False,
        "use_inaudible_opt": False,
    }


def test_an_empty_plan_adds_no_entries_and_records_only_the_baseline_step(episode):
    clips = _clips(episode)
    reply = json.loads(apply_edit_plan_tool(str(episode), []))
    assert reply["entries_added"] == 0
    assert reply["operation"] == "apply_edit_plan"
    assert _status(episode)["total"] == 1
    assert _decisions(episode) == []
    assert _clips(episode) == clips
    apply_edit_plan_tool(str(episode), [])
    assert _status(episode)["total"] == 1


def test_pending_entries_stage_decisions_and_leave_the_clips_alone(episode):
    clips = _clips(episode)
    apply_edit_plan_tool(str(episode), [_entry(2, 3), _entry(4, 5)])
    assert _decisions(episode) == [
        ("host", 2.0, 3.0, 10, "agent:plan", True, False),
        ("host", 4.0, 5.0, 10, "agent:plan", True, False),
    ]
    assert _clips(episode) == clips


def test_default_use_inaudible_opt_snaps_the_staged_bounds(episode):
    apply_edit_plan_tool(str(episode), [{"track_id": "host", "start": 2, "end": 3}])
    assert _decisions(episode) == [("host", 2.0, 2.975, 10, "agent:plan", True, False)]


def test_use_inaudible_opt_false_on_the_tool_keeps_the_requested_bounds(episode):
    reply = json.loads(
        apply_edit_plan_tool(
            str(episode),
            [{"track_id": "host", "start": 2, "end": 3}],
            use_inaudible_opt=False,
        )
    )
    assert reply["use_inaudible_opt"] is False
    assert _decisions(episode) == [("host", 2.0, 3.0, 10, "agent:plan", True, False)]


def test_entry_use_inaudible_opt_overrides_the_tool_flag(episode):
    reply = json.loads(
        apply_edit_plan_tool(
            str(episode),
            [{"track_id": "host", "start": 2, "end": 3, "use_inaudible_opt": False}],
            use_inaudible_opt=True,
        )
    )
    assert reply["use_inaudible_opt"] is True
    assert _decisions(episode) == [("host", 2.0, 3.0, 10, "agent:plan", True, False)]


def test_review_required_false_on_the_tool_stages_unreviewed_decisions(episode):
    reply = json.loads(apply_edit_plan_tool(str(episode), [_entry(2, 3)], review_required=False))
    assert reply["review_required"] is False
    assert _decisions(episode) == [("host", 2.0, 3.0, 10, "agent:plan", False, False)]


def test_entry_review_required_overrides_the_tool_flag(episode):
    apply_edit_plan_tool(
        str(episode),
        [_entry(2, 3, review_required=False), _entry(4, 5)],
        review_required=True,
    )
    assert _decisions(episode) == [
        ("host", 2.0, 3.0, 10, "agent:plan", False, False),
        ("host", 4.0, 5.0, 10, "agent:plan", True, False),
    ]


def test_entry_reason_and_crossfade_ms_are_kept(episode):
    apply_edit_plan_tool(str(episode), [_entry(4, 5, reason="trim", crossfade_ms=25)])
    assert _decisions(episode) == [("host", 4.0, 5.0, 25, "trim", True, False)]


def test_a_cut_over_the_other_speaker_is_forced_to_review_with_a_reason_suffix(episode):
    apply_edit_plan_tool(str(episode), [_entry(12, 13)], review_required=False)
    assert _decisions(episode) == [
        (
            "host",
            12.0,
            13.0,
            10,
            "agent:plan:other_speaking:guest:acoustic_review:breath_edge",
            True,
            False,
        )
    ]


def test_an_applied_entry_runs_the_cut_on_every_lane(episode):
    clips = _clips(episode)
    reply = json.loads(apply_edit_plan_tool(str(episode), [_entry(15, 16, applied=True)]))
    assert reply["entries_added"] == 1
    assert clips == [
        ("guest", 0.0, 20.0, 0.0),
        ("host", 0.0, 8.0, 0.0),
        ("host", 8.0, 20.0, 8.0),
    ]
    assert _clips(episode) == [
        ("guest", 0.0, 15.0, 0.0),
        ("guest", 16.0, 20.0, 15.0),
        ("host", 0.0, 8.0, 0.0),
        ("host", 8.0, 15.0, 8.0),
        ("host", 16.0, 20.0, 15.0),
    ]
    assert _decisions(episode) == []
    assert load_project(episode).timeline.duration_sec == pytest.approx(19.0)


def test_an_applied_entry_cuts_even_when_the_tool_asks_for_review(episode):
    apply_edit_plan_tool(
        str(episode), [_entry(15, 16, applied=True)], review_required=True, use_inaudible_opt=False
    )
    assert ("host", 16.0, 20.0, 15.0) in _clips(episode)


def test_a_mixed_plan_cuts_the_applied_entry_and_stages_the_rest(episode):
    reply = json.loads(
        apply_edit_plan_tool(str(episode), [_entry(2, 3), _entry(15, 16, applied=True)])
    )
    assert reply["entries_added"] == 2
    assert _decisions(episode) == [("host", 2.0, 3.0, 10, "agent:plan", True, False)]
    assert ("host", 16.0, 20.0, 15.0) in _clips(episode)


def test_a_pending_plan_is_one_history_step_and_undo_restores_it(episode):
    clips = _clips(episode)
    apply_edit_plan_tool(str(episode), [_entry(2, 3), _entry(4, 5)])
    status = _status(episode)
    assert status["total"] == 2
    assert status["current_label"] == "after apply edit plan"
    assert _labels(episode) == ["before apply edit plan", "after apply edit plan"]
    assert len(_decisions(episode)) == 2
    history_undo(str(episode))
    assert _decisions(episode) == []
    assert _clips(episode) == clips


def test_an_applied_plan_takes_the_same_two_history_labels_and_undo_restores_the_clips(episode):
    clips = _clips(episode)
    apply_edit_plan_tool(str(episode), [_entry(15, 16, applied=True)])
    status = _status(episode)
    assert status["total"] == 2
    assert status["current_label"] == "after apply edit plan"
    assert _labels(episode) == ["before apply edit plan", "after apply edit plan"]
    assert _clips(episode) != clips
    history_undo(str(episode))
    assert _clips(episode) == clips
    assert _decisions(episode) == []


def test_a_second_call_adds_one_more_history_step(episode):
    apply_edit_plan_tool(str(episode), [_entry(2, 3)])
    assert _status(episode)["total"] == 2
    apply_edit_plan_tool(str(episode), [_entry(15, 16, applied=True)])
    assert _status(episode)["total"] == 3
    assert _labels(episode)[-1] == "after apply edit plan"


@pytest.mark.refine_gate
def test_a_pending_refine_raises_transcript_refine_required_and_writes_nothing(episode):
    before = episode.read_bytes()
    with pytest.raises(TranscriptRefineRequiredError) as raised:
        apply_edit_plan_tool(str(episode), [_entry(2, 3)])
    assert raised.value.code == "transcript_refine_required"
    _untouched(episode, before)


@pytest.mark.parametrize(
    "plan",
    [
        [{"track_id": "nope", "start": 1, "end": 2}],
        [_entry(-1, 2)],
        [_entry(100, 200)],
    ],
)
def test_an_unknown_track_or_out_of_range_cut_raises_cut_scope_changed(episode, plan):
    before = episode.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as raised:
        apply_edit_plan_tool(str(episode), plan)
    assert raised.value.code == "cut_scope_changed"
    assert str(raised.value) == _SCOPE_ERROR
    _untouched(episode, before)


@pytest.mark.parametrize("start,end", [(3, 3), (3, 2)])
def test_an_empty_or_reversed_range_raises_range_end_before_start(episode, start, end):
    before = episode.read_bytes()
    with pytest.raises(CodedValueError) as raised:
        apply_edit_plan_tool(str(episode), [_entry(start, end)])
    assert raised.value.code == "range_end_before_start"
    assert str(raised.value) == _RANGE_ERROR
    _untouched(episode, before)


def test_a_bad_later_entry_discards_the_earlier_ones(episode):
    before = episode.read_bytes()
    with pytest.raises(CodedValueError) as raised:
        apply_edit_plan_tool(
            str(episode), [_entry(2, 3), _entry(15, 16, applied=True), _entry(3, 2)]
        )
    assert raised.value.code == "range_end_before_start"
    _untouched(episode, before)


@pytest.mark.parametrize(
    "entry,missing",
    [
        ({"start": 1, "end": 2}, "track_id"),
        ({"track_id": "host", "end": 2}, "start"),
        ({"track_id": "host", "start": 1}, "end"),
    ],
)
def test_a_missing_key_raises_a_raw_key_error_today(episode, entry, missing):
    before = episode.read_bytes()
    with pytest.raises(KeyError) as raised:
        apply_edit_plan_tool(str(episode), [entry])
    assert type(raised.value) is KeyError
    assert raised.value.args == (missing,)
    assert not hasattr(raised.value, "code")
    _untouched(episode, before)


@pytest.mark.parametrize(
    "entry,message",
    [
        (
            {"track_id": "host", "start": "a", "end": 2},
            "could not convert string to float: 'a'",
        ),
        (
            {"track_id": "host", "start": 1, "end": "b"},
            "could not convert string to float: 'b'",
        ),
        (
            {"track_id": "host", "start": 1, "end": 2, "crossfade_ms": "x"},
            "invalid literal for int() with base 10: 'x'",
        ),
    ],
)
def test_a_non_numeric_value_raises_a_raw_value_error_today(episode, entry, message):
    before = episode.read_bytes()
    with pytest.raises(ValueError) as raised:
        apply_edit_plan_tool(str(episode), [entry])
    assert type(raised.value) is ValueError
    assert str(raised.value) == message
    assert not hasattr(raised.value, "code")
    _untouched(episode, before)
