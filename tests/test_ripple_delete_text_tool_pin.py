"""ripple_delete_text_tool keeps its reply, errors, effects, history and journal shape (#1847)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import TranscriptWord, load_project, save_project
from test_edit_modes import episode as _episode_fixture

episode = _episode_fixture

_APPLIED_KEYS = {
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "query",
    "use_inaudible_opt",
    "timeline_start",
    "timeline_end",
    "span_count",
    "per_track_source",
}
_AGENT_OVERRIDE = {"kind": "owner_override", "actor": "mcp:host", "surface": "agent"}


def _add_host_word(path: Path, text: str, start: float, end: float) -> None:
    project = load_project(path)
    host = next(t for t in project.transcripts if t.track_id == "host")
    host.words.append(TranscriptWord(text=text, start=start, end=end))
    save_project(project)


def _spans(path: Path) -> list[tuple[str, float, float, float]]:
    project = load_project(path)
    return sorted(
        (c.track_id, c.timeline_start, c.source_start, c.source_end) for c in project.clips
    )


def _history(path: Path) -> list[dict]:
    from podcast_mcp.mcp.tools.history import history_list

    return json.loads(history_list(str(path)))["entries"]


def _reasons(path: Path) -> set[str]:
    from podcast_mcp.engines.render_invalidations import invalidations_as_dicts

    return {entry["reason"] for entry in invalidations_as_dicts(load_project(path))}


def _journal_types(path: Path) -> list[str]:
    from podcast_mcp.services.document_sync import DocumentSyncService

    return [r["type"] for r in DocumentSyncService.open(path).store.commands_after(0)]


def _registered(name: str):
    class _Server:
        def __init__(self) -> None:
            self.tools: dict[str, object] = {}

        def tool(self, *_args, **_kwargs):
            def register(fn):
                self.tools[fn.__name__] = fn
                return fn

            return register

    server = _Server()
    mcp_timeline.register(server)
    return server.tools[name]


def _untouched(path: Path, before: bytes) -> None:
    assert path.read_bytes() == before
    assert load_project(path).editorial.edit_log == []
    assert _history(path) == []


def test_reply_keys_and_values_for_a_matched_cut(episode):
    reply = json.loads(mcp_timeline.ripple_delete_text_tool(str(episode), "hello"))
    assert set(reply) == _APPLIED_KEYS
    assert reply["operation"] == "ripple_delete_text"
    assert reply["query"] == "hello"
    assert reply["use_inaudible_opt"] is None
    assert reply["affected_tracks"] == ["host", "guest"]
    assert reply["clip_count"] == 5
    assert reply["span_count"] == 1
    assert reply["timeline_start"] == pytest.approx(1.025875)
    assert reply["timeline_end"] == pytest.approx(1.4046875)
    assert reply["timeline_duration_sec"] == pytest.approx(19.6211875)
    assert set(reply["per_track_source"]) == {"host", "guest"}
    for bounds in reply["per_track_source"].values():
        assert bounds == pytest.approx([1.025875, 1.4046875])


def test_the_matched_word_is_removed_from_every_dialogue_lane(episode):
    mcp_timeline.ripple_delete_text_tool(str(episode), "hello")
    project = load_project(episode)
    assert project.timeline.duration_sec == pytest.approx(19.6211875)
    cut_start, cut_end = 1.025875, 1.4046875
    got = _spans(episode)
    assert [(t, s) for t, s, _a, _b in got] == [
        ("guest", pytest.approx(0.0)),
        ("guest", pytest.approx(cut_start)),
        ("host", pytest.approx(0.0)),
        ("host", pytest.approx(cut_start)),
        ("host", pytest.approx(7.6211875)),
    ]
    by_track = {}
    for track, _start, source_start, source_end in got:
        by_track.setdefault(track, []).append((source_start, source_end))
    assert by_track["host"] == [
        (0.0, pytest.approx(cut_start)),
        (pytest.approx(cut_end), 8.0),
        (8.0, 20.0),
    ]
    assert by_track["guest"] == [(0.0, pytest.approx(cut_start)), (pytest.approx(cut_end), 20.0)]


def test_a_second_word_cut_closes_up_the_timeline(episode):
    mcp_timeline.ripple_delete_text_tool(str(episode), "world")
    assert load_project(episode).timeline.duration_sec == pytest.approx(19.460625)


def test_history_records_before_and_after_labels_and_the_operation(episode):
    mcp_timeline.ripple_delete_text_tool(str(episode), "hello")
    entries = _history(episode)
    assert [e["label"] for e in entries] == [
        "before ripple delete text",
        "after ripple delete text",
    ]
    assert entries[0]["operation"] is None
    assert entries[0]["params"] is None
    assert entries[1]["operation"] == "ripple_delete_text"
    assert entries[1]["params"] == {"query": "hello", "use_inaudible_opt": None}


def test_edit_log_records_one_ripple_delete_with_the_query(episode):
    mcp_timeline.ripple_delete_text_tool(str(episode), "hello")
    (record,) = load_project(episode).editorial.edit_log
    assert record.operation == "ripple_delete"
    assert record.track_ids == ["host", "guest"]
    assert record.timeline_start == pytest.approx(1.025875)
    assert record.timeline_end == pytest.approx(1.4046875)
    assert set(record.params) == {"query", "use_inaudible_opt", "per_track_source"}
    assert record.params["query"] == "hello"
    assert record.params["use_inaudible_opt"] is None
    assert "audio_check_override" not in record.params


def test_the_cut_records_a_cut_render_invalidation(episode):
    mcp_timeline.ripple_delete_text_tool(str(episode), "hello")
    assert "cut" in _reasons(episode)


def test_use_inaudible_opt_none_is_passed_through_and_keeps_the_snapped_bounds(episode):
    reply = json.loads(mcp_timeline.ripple_delete_text_tool(str(episode), "hello"))
    assert reply["use_inaudible_opt"] is None
    assert reply["timeline_start"] != 1.0
    assert _history(episode)[1]["params"]["use_inaudible_opt"] is None


def test_use_inaudible_opt_false_is_passed_through_and_cuts_the_word_bounds(episode):
    reply = json.loads(
        mcp_timeline.ripple_delete_text_tool(str(episode), "hello", use_inaudible_opt=False)
    )
    assert reply["use_inaudible_opt"] is False
    assert reply["timeline_start"] == pytest.approx(1.0)
    assert reply["timeline_end"] == pytest.approx(1.4)
    assert reply["timeline_duration_sec"] == pytest.approx(19.6)
    assert _history(episode)[1]["params"] == {"query": "hello", "use_inaudible_opt": False}
    (record,) = load_project(episode).editorial.edit_log
    assert record.params["use_inaudible_opt"] is False


def test_override_forces_use_inaudible_opt_false_and_records_the_override(episode):
    reply = json.loads(
        mcp_timeline.ripple_delete_text_tool(
            str(episode), "plan", use_inaudible_opt=True, override_audio_checks=True
        )
    )
    assert reply["use_inaudible_opt"] is False
    assert reply["timeline_start"] == pytest.approx(10.1)
    assert reply["timeline_end"] == pytest.approx(10.9)
    assert reply["timeline_duration_sec"] == pytest.approx(19.2)
    assert "audio_check_override" not in reply


def test_a_held_audio_check_cut_raises_cut_scope_changed_and_writes_nothing(episode):
    before = episode.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as raised:
        mcp_timeline.ripple_delete_text_tool(str(episode), "plan")
    assert raised.value.code == "cut_scope_changed"
    assert "override_audio_checks=true" in str(raised.value)
    _untouched(episode, before)
    assert _spans(episode)[0][0] == "guest"
    assert load_project(episode).timeline.duration_sec == pytest.approx(20.0)


def test_other_speaker_speech_replies_needs_confirmation_and_writes_nothing(episode):
    _add_host_word(episode, "um", 10.0, 11.0)
    before = episode.read_bytes()
    reply = json.loads(mcp_timeline.ripple_delete_text_tool(str(episode), "um"))
    assert set(reply) == {"operation", "unchanged", "needs_confirmation", "apply_anyway", "query"}
    assert reply["operation"] == "ripple_delete_text"
    assert reply["unchanged"] is True
    assert reply["query"] == "um"
    confirm = reply["needs_confirmation"]
    assert confirm["status"] == "needs_confirmation"
    assert confirm["reason"] == "cuts_other_speech"
    assert "Guest's speech" in confirm["message"]
    assert [t["track_id"] for t in confirm["speech"]["tracks"]] == ["guest"]
    assert [w["text"] for w in confirm["speech"]["tracks"][0]["words"]] == ["so", "the", "plan"]
    assert "override_audio_checks=true" in reply["apply_anyway"]
    _untouched(episode, before)
    assert _journal_types(episode) == ["RippleDeleteText"]


def test_override_applies_the_other_speaker_cut_and_logs_who_overrode(episode):
    _add_host_word(episode, "um", 10.0, 11.0)
    reply = json.loads(
        mcp_timeline.ripple_delete_text_tool(str(episode), "um", override_audio_checks=True)
    )
    assert reply["operation"] == "ripple_delete_text"
    assert reply["query"] == "um"
    assert reply["use_inaudible_opt"] is False
    assert reply["timeline_start"] == pytest.approx(9.0)
    assert reply["timeline_end"] == pytest.approx(11.0)
    assert reply["timeline_duration_sec"] == pytest.approx(18.0)
    assert [t["track_id"] for t in reply["cut_speech"]["tracks"]] == ["guest"]
    assert "unchanged" not in reply
    assert "cut" in _reasons(episode)
    (record,) = load_project(episode).editorial.edit_log
    assert record.operation == "ripple_delete"
    assert record.params["query"] == "um"
    assert record.params["use_inaudible_opt"] is False


def test_override_applies_a_held_cut_with_the_exact_word_bounds(episode):
    mcp_timeline.ripple_delete_text_tool(str(episode), "plan", override_audio_checks=True)
    project = load_project(episode)
    assert project.timeline.duration_sec == pytest.approx(19.2)
    (record,) = project.editorial.edit_log
    assert (record.timeline_start, record.timeline_end) == pytest.approx((10.1, 10.9))


def test_no_match_raises_no_transcript_match_and_writes_nothing(episode):
    before = episode.read_bytes()
    with pytest.raises(ValueError) as raised:
        mcp_timeline.ripple_delete_text_tool(str(episode), "zzz")
    assert raised.value.code == "no_transcript_match"
    assert "zzz" in str(raised.value)
    _untouched(episode, before)


def test_a_word_cut_twice_no_longer_matches(episode):
    mcp_timeline.ripple_delete_text_tool(str(episode), "hello")
    with pytest.raises(ValueError) as raised:
        mcp_timeline.ripple_delete_text_tool(str(episode), "hello")
    assert raised.value.code == "no_transcript_match"
    assert len(load_project(episode).editorial.edit_log) == 1


def test_a_match_on_removed_material_raises_transcript_match_removed(episode):
    project = load_project(episode)
    project.clips = [c for c in project.clips if c.id != "h2"]
    save_project(project)
    before = episode.read_bytes()
    with pytest.raises(ValueError) as raised:
        mcp_timeline.ripple_delete_text_tool(str(episode), "world")
    assert raised.value.code == "transcript_match_removed"
    _untouched(episode, before)


@pytest.mark.refine_gate
def test_a_pending_refine_raises_transcript_refine_required_and_writes_nothing(episode):
    before = episode.read_bytes()
    with pytest.raises(TranscriptRefineRequiredError) as raised:
        mcp_timeline.ripple_delete_text_tool(str(episode), "hello")
    assert raised.value.code == "transcript_refine_required"
    _untouched(episode, before)


def test_a_failed_call_through_the_registered_tool_journals_nothing(episode):
    registered = _registered("ripple_delete_text_tool")
    with pytest.raises(ValueError):
        registered(str(episode), "zzz")
    assert _journal_types(episode) == []


def test_the_registered_tool_applies_the_same_cut(episode):
    registered = _registered("ripple_delete_text_tool")
    reply = json.loads(registered(str(episode), "hello", use_inaudible_opt=False))
    assert set(reply) == _APPLIED_KEYS
    assert reply["operation"] == "ripple_delete_text"
    assert load_project(episode).timeline.duration_sec == pytest.approx(19.6)


def test_the_registered_tool_journals_one_ripple_delete_text_row(episode):
    registered = _registered("ripple_delete_text_tool")
    registered(str(episode), "hello")
    assert _journal_types(episode) == ["RippleDeleteText"]


def test_the_direct_tool_journals_one_ripple_delete_text_row(episode):
    mcp_timeline.ripple_delete_text_tool(str(episode), "hello")
    assert _journal_types(episode) == ["RippleDeleteText"]


def test_override_records_the_agent_surface_in_the_edit_log(episode):
    _add_host_word(episode, "um", 10.0, 11.0)
    mcp_timeline.ripple_delete_text_tool(str(episode), "um", override_audio_checks=True)
    (record,) = load_project(episode).editorial.edit_log
    assert record.params["audio_check_override"] == _AGENT_OVERRIDE


def test_override_records_the_agent_surface_in_history(episode):
    _add_host_word(episode, "um", 10.0, 11.0)
    mcp_timeline.ripple_delete_text_tool(str(episode), "um", override_audio_checks=True)
    assert _history(episode)[1]["params"] == {
        "query": "um",
        "use_inaudible_opt": False,
        "audio_check_override": _AGENT_OVERRIDE,
    }


def test_the_command_is_host_only_for_every_share_role():
    from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
    from podcast_mcp.services.document_sync.capabilities import authorize_document_command

    authorize_document_command(None, "RippleDeleteText")
    for role in ("viewer", "commenter", "editor"):
        with pytest.raises(PermissionError) as raised:
            authorize_document_command(
                capabilities_for_role(role, with_mcp=True), "RippleDeleteText"
            )
        assert raised.value.code == "share_capability_required"


def test_the_payload_requires_a_query():
    from podcast_mcp.services.document_sync.payloads import validate_payload

    validate_payload("RippleDeleteText", {"query": "hello"})
    with pytest.raises(ValueError):
        validate_payload("RippleDeleteText", {})


def test_an_empty_query_raises_no_transcript_match(episode):
    with pytest.raises(ValueError) as caught:
        mcp_timeline.ripple_delete_text_tool(str(episode), "")
    assert caught.value.code == "no_transcript_match"
