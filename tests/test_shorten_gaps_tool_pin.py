from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from mcp.client import Client

from pause_policy_public_helpers import configure, defaults, project, workspace
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.mcp.tools.history import history_list, history_status_tool, history_undo
from podcast_mcp.models import Transcript, TranscriptWord, load_project
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.util.coded_error import CodedError, CodedPermissionError, CodedValueError

_APPLIED_KEYS = {
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "max_gap_sec",
    "use_inaudible_opt",
    "timeline_start",
    "timeline_end",
    "span_count",
    "per_track_source",
}
_HELD_KEYS = {"operation", "unchanged", "needs_confirmation", "apply_anyway"}
_HOST_GAP = ([(0, 0.2), (1.0, 1.2), (1.3, 1.5)], [(3.0, 3.2), (3.3, 3.5)])
_GUEST_GAP = ([(3.0, 3.2), (3.3, 3.5)], [(0, 0.2), (1.0, 1.2), (1.3, 1.5)])
_HELD_WORDS = ([(0, 0.2), (1.0, 1.2)], [(0.5, 0.7), (0.8, 0.9)])
_OVERRIDE = {"kind": "owner_override", "actor": "mcp:host", "surface": "host_mcp"}
_APPLY_ANYWAY = (
    "To apply it as is, repeat the call with override_audio_checks=true "
    "(CLI --override-audio-checks)."
)
_SHORTENED = [(0.0, 0.0, 0.2), (0.2, 0.65, 6.0)]
_WHOLE = [(0.0, 0.0, 6.0)]


def _path(tmp_path: Path, words=_HOST_GAP, name: str = "ws") -> str:
    root = tmp_path / name
    root.mkdir()
    result = project(root, guest="quiet")
    host_words, guest_words = words
    result.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text=f"h{i}", start=a, end=b) for i, (a, b) in enumerate(host_words)
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text=f"g{i}", start=a, end=b) for i, (a, b) in enumerate(guest_words)
            ],
        ),
    ]
    return str(workspace(result).path)


def _spans(path: str, track_id: str) -> list[tuple[float, float, float]]:
    rows = (
        (round(c.timeline_start, 6), round(c.source_start, 6), round(c.source_end, 6))
        for c in load_project(Path(path)).clips
        if c.track_id == track_id
    )
    return sorted(rows)


def _state(path: str) -> tuple:
    saved = load_project(Path(path))
    return saved.clips, saved.timeline, saved.transcripts


def _history(path: str) -> dict:
    return json.loads(history_status_tool(path))


def _entries(path: str) -> list[dict]:
    return json.loads(history_list(path))["entries"]


def _journal(path: str) -> list[str]:
    return [r["type"] for r in DocumentSyncService.open(path).store.commands_after(0)]


def _run(path: str, *args, **kwargs) -> dict:
    return json.loads(mcp_timeline.shorten_gaps_tool(path, *args, **kwargs))


def _registered(args: dict):
    async def call():
        async with Client(mcp_server.mcp) as client:
            return await client.call_tool("shorten_gaps_tool", args)

    return asyncio.run(call())


@pytest.fixture(autouse=True)
def _config(monkeypatch):
    configure(monkeypatch, defaults())


def test_reply_keys_and_values_for_a_project_with_a_qualifying_gap(tmp_path):
    path = _path(tmp_path)
    reply = _run(path)
    assert set(reply) == _APPLIED_KEYS
    assert reply["operation"] == "shorten_word_gaps"
    assert reply["affected_tracks"] == ["host", "guest"]
    assert reply["clip_count"] == 4
    assert reply["max_gap_sec"] == 0.35
    assert reply["use_inaudible_opt"] is None
    assert reply["span_count"] == 1
    assert "unchanged" not in reply
    assert reply["timeline_start"] == pytest.approx(0.2, abs=0.05)
    assert reply["timeline_end"] == pytest.approx(0.65, abs=0.05)
    assert reply["timeline_duration_sec"] == pytest.approx(5.55, abs=0.05)
    assert set(reply["per_track_source"]) == {"host", "guest"}
    assert reply["per_track_source"]["host"] == reply["per_track_source"]["guest"]
    assert reply["per_track_source"]["host"] == [reply["timeline_start"], reply["timeline_end"]]


def test_exact_reply_values_without_inaudible_optimisation(tmp_path):
    path = _path(tmp_path)
    reply = _run(path, use_inaudible_opt=False)
    assert reply["timeline_start"] == pytest.approx(0.2)
    assert reply["timeline_end"] == pytest.approx(0.65)
    assert reply["timeline_duration_sec"] == pytest.approx(5.55)
    assert reply["per_track_source"] == {
        "host": [pytest.approx(0.2), pytest.approx(0.65)],
        "guest": [pytest.approx(0.2), pytest.approx(0.65)],
    }
    assert load_project(Path(path)).timeline.duration_sec == pytest.approx(5.55)


@pytest.mark.parametrize("words", [_HOST_GAP, _GUEST_GAP], ids=["host-gap", "guest-gap"])
def test_every_dialogue_track_is_rippled_by_the_same_span(tmp_path, words):
    path = _path(tmp_path, words)
    assert _spans(path, "host") == _WHOLE
    assert _spans(path, "guest") == _WHOLE
    reply = _run(path, use_inaudible_opt=False)
    assert reply["affected_tracks"] == ["host", "guest"]
    assert _spans(path, "host") == [pytest.approx(row) for row in _SHORTENED]
    assert _spans(path, "guest") == [pytest.approx(row) for row in _SHORTENED]


def test_no_qualifying_gap_is_unchanged_and_leaves_the_project_file_untouched(tmp_path):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    reply = _run(path, 5.0)
    assert reply == {
        "operation": "shorten_word_gaps",
        "affected_tracks": [],
        "clip_count": 2,
        "timeline_duration_sec": 6.0,
        "unchanged": True,
    }
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0


def test_one_call_adds_a_before_and_after_history_step_and_undo_restores_the_project(tmp_path):
    path = _path(tmp_path)
    before = _state(path)
    _run(path)
    status = _history(path)
    assert status["total"] == 2
    assert status["current_label"] == "after shorten gaps"
    assert [e["label"] for e in _entries(path)] == ["before shorten gaps", "after shorten gaps"]
    assert _state(path) != before
    history_undo(path)
    assert _state(path) == before


def test_history_and_edit_log_record_no_override_without_the_flag(tmp_path):
    path = _path(tmp_path)
    _run(path, 0.35, False)
    after = _entries(path)[1]
    assert after["operation"] == "shorten_word_gaps"
    assert after["params"] == {"max_gap_sec": 0.35, "use_inaudible_opt": False}
    (record,) = load_project(Path(path)).editorial.edit_log
    assert record.operation == "ripple_delete"
    assert "audio_check_override" not in record.params


def test_override_flag_records_the_mcp_host_actor_in_history_and_the_edit_log(tmp_path):
    path = _path(tmp_path, _HELD_WORDS)
    reply = _run(path, use_inaudible_opt=False, override_audio_checks=True)
    assert reply["operation"] == "shorten_word_gaps"
    assert "needs_confirmation" not in reply
    after = _entries(path)[1]
    assert after["params"] == {
        "max_gap_sec": 0.35,
        "use_inaudible_opt": False,
        "audio_check_override": _OVERRIDE,
    }
    (record,) = load_project(Path(path)).editorial.edit_log
    assert record.operation == "ripple_delete"
    assert record.params["audio_check_override"] == _OVERRIDE
    assert record.params["audio_check_override"]["actor"] == "mcp:host"
    assert record.params["audio_check_override"]["surface"] == "host_mcp"
    assert [c["track_id"] for c in record.params["cut_speech"]["tracks"]] == ["guest"]


def test_override_flag_applies_the_cut_the_checks_held_and_undo_restores_it(tmp_path):
    path = _path(tmp_path, _HELD_WORDS)
    before = _state(path)
    _run(path, use_inaudible_opt=False, override_audio_checks=True)
    assert _spans(path, "host") == [pytest.approx(row) for row in _SHORTENED]
    assert _spans(path, "guest") == [pytest.approx(row) for row in _SHORTENED]
    history_undo(path)
    assert _state(path) == before
    assert load_project(Path(path)).editorial.edit_log == []


def test_speech_in_the_pause_returns_needs_confirmation_and_changes_nothing(tmp_path):
    path = _path(tmp_path, _HELD_WORDS)
    before = Path(path).read_bytes()
    reply = _run(path, use_inaudible_opt=False)
    assert set(reply) == _HELD_KEYS
    assert reply["operation"] == "shorten_word_gaps"
    assert reply["unchanged"] is True
    assert reply["apply_anyway"] == _APPLY_ANYWAY
    held = reply["needs_confirmation"]
    assert set(held) == {"status", "reason", "message", "speech"}
    assert held["status"] == "needs_confirmation"
    assert held["reason"] == "cuts_other_speech"
    assert held["message"] == (
        'This also cuts Guest\'s speech at 0:00.5 ("g0"). '
        "Review this cut in Studio, or leave a gap to keep it."
    )
    assert held["speech"]["spans"] == [{"start": pytest.approx(0.2), "end": pytest.approx(0.65)}]
    (track,) = held["speech"]["tracks"]
    assert track["track_id"] == "guest"
    assert track["speaker"] == "Guest"
    assert [w["text"] for w in track["words"]] == ["g0"]
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0
    assert load_project(Path(path)).editorial.edit_log == []
    assert _journal(path) == ["ShortenWordGaps"]


def test_needs_confirmation_is_returned_not_raised_and_repeats_identically(tmp_path):
    path = _path(tmp_path, _HELD_WORDS)
    first = _run(path, use_inaudible_opt=False)
    second = _run(path, use_inaudible_opt=False)
    assert first == second
    assert _spans(path, "host") == _WHOLE


def test_needs_confirmation_with_the_default_optimisation_also_changes_nothing(tmp_path):
    path = _path(tmp_path, _HELD_WORDS)
    before = Path(path).read_bytes()
    reply = _run(path)
    assert set(reply) == _HELD_KEYS
    assert reply["needs_confirmation"]["reason"] == "cuts_other_speech"
    assert Path(path).read_bytes() == before


def test_override_flag_false_is_the_same_as_leaving_it_out(tmp_path):
    left_out = _path(tmp_path, _HELD_WORDS, "a")
    explicit = _path(tmp_path, _HELD_WORDS, "b")
    assert _run(explicit, 0.35, False, False) == _run(left_out, 0.35, False)


def test_inaudible_optimisation_true_and_default_agree_and_false_is_exact(tmp_path):
    default = _run(_path(tmp_path, name="a"))
    enabled = _run(_path(tmp_path, name="b"), use_inaudible_opt=True)
    disabled = _run(_path(tmp_path, name="c"), use_inaudible_opt=False)
    assert default["use_inaudible_opt"] is None
    assert enabled["use_inaudible_opt"] is True
    assert disabled["use_inaudible_opt"] is False
    assert enabled["per_track_source"] == default["per_track_source"]
    assert enabled["timeline_start"] > disabled["timeline_start"] + 1e-6
    assert disabled["timeline_start"] == pytest.approx(0.2)
    assert enabled["span_count"] == disabled["span_count"] == 1


def test_default_max_gap_is_a_third_of_a_second_and_a_bit(tmp_path):
    default = _run(_path(tmp_path, name="a"), use_inaudible_opt=False)
    explicit = _run(_path(tmp_path, name="b"), 0.35, use_inaudible_opt=False)
    assert default["max_gap_sec"] == 0.35
    assert default == explicit


def test_small_max_gap_cuts_more_of_the_pause(tmp_path):
    path = _path(tmp_path)
    reply = _run(path, 0.25, use_inaudible_opt=False)
    assert reply["max_gap_sec"] == 0.25
    assert reply["span_count"] == 1
    assert reply["timeline_end"] == pytest.approx(0.75)
    assert reply["timeline_duration_sec"] == pytest.approx(5.45)
    assert _spans(path, "host") == [
        pytest.approx((0.0, 0.0, 0.2)),
        pytest.approx((0.2, 0.75, 6.0)),
    ]


def test_zero_max_gap_removes_every_pause_and_the_short_gap_between_words(tmp_path):
    path = _path(tmp_path)
    reply = _run(path, 0, use_inaudible_opt=False)
    assert reply["max_gap_sec"] == 0
    assert reply["span_count"] == 3
    assert reply["clip_count"] == 8
    assert reply["affected_tracks"] == ["host", "guest"]
    assert reply["timeline_end"] == pytest.approx(1.0)
    assert reply["timeline_duration_sec"] == pytest.approx(5.0)
    expected = [
        pytest.approx(row)
        for row in [(0.0, 0.0, 0.2), (0.2, 1.0, 1.2), (0.4, 1.3, 3.2), (2.3, 3.3, 6.0)]
    ]
    assert _spans(path, "host") == expected
    assert _spans(path, "guest") == expected


def test_negative_max_gap_is_accepted_and_removes_more_than_the_pauses(tmp_path):
    path = _path(tmp_path)
    reply = _run(path, -1, use_inaudible_opt=False)
    assert reply["max_gap_sec"] == -1
    assert reply["span_count"] == 2
    assert reply["clip_count"] == 6
    assert reply["timeline_end"] == pytest.approx(2.3)
    assert reply["timeline_duration_sec"] == pytest.approx(2.8)
    expected = [pytest.approx(row) for row in [(0.0, 0.0, 0.2), (0.2, 2.3, 3.2), (1.1, 4.3, 6.0)]]
    assert _spans(path, "host") == expected
    assert _spans(path, "guest") == expected


@pytest.mark.parametrize("bad", ["abc", None])
def test_non_numeric_max_gap_is_a_coded_invalid_payload_and_changes_nothing(tmp_path, bad):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(CodedValueError) as raised:
        mcp_timeline.shorten_gaps_tool(path, bad)
    assert raised.value.code == "invalid_payload"
    assert "max_gap_sec" in str(raised.value)
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0
    assert _journal(path) == []


def test_non_numeric_max_gap_is_refused_even_when_no_words_pair_up(tmp_path):
    path = _path(tmp_path, ([(0, 0.2)], []))
    with pytest.raises(CodedValueError) as raised:
        mcp_timeline.shorten_gaps_tool(path, "abc")
    assert raised.value.code == "invalid_payload"


def test_registered_tool_rejects_a_non_numeric_max_gap_before_the_service(tmp_path):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    result = _registered({"project_path": path, "max_gap_sec": "abc"})
    assert result.is_error
    text = result.content[0].text
    assert "max_gap_sec" in text
    assert "Input should be a valid number" in text
    assert Path(path).read_bytes() == before
    assert _journal(path) == []


def test_missing_project_file_raises_project_not_found(tmp_path):
    missing = str(tmp_path / "nope" / "episode.project.json")
    with pytest.raises(FileNotFoundError) as raised:
        mcp_timeline.shorten_gaps_tool(missing)
    assert isinstance(raised.value, CodedError)
    assert raised.value.code == "project_not_found"
    assert str(raised.value) == f"Project not found: {missing}"


def test_directory_without_a_project_raises_project_not_found(tmp_path):
    with pytest.raises(FileNotFoundError) as raised:
        mcp_timeline.shorten_gaps_tool(str(tmp_path))
    assert raised.value.code == "project_not_found"
    assert str(raised.value) == f"Project not found: {tmp_path / 'episode.project.json'}"


def test_registered_tool_reports_a_missing_project_as_an_error(tmp_path):
    missing = str(tmp_path / "nope")
    result = _registered({"project_path": missing})
    assert result.is_error
    assert result.content[0].text == f"Project not found: {missing}"


def test_project_without_a_transcript_is_unchanged(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    result = project(root)
    result.transcripts = []
    path = str(workspace(result).path)
    before = Path(path).read_bytes()
    reply = _run(path)
    assert reply == {
        "operation": "shorten_word_gaps",
        "affected_tracks": [],
        "clip_count": 1,
        "timeline_duration_sec": 6.0,
        "unchanged": True,
    }
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0


@pytest.mark.parametrize("words", [([], []), ([(0, 0.2)], [(0, 0.2)])], ids=["empty", "one-word"])
def test_transcripts_without_word_pairs_are_unchanged(tmp_path, words):
    path = _path(tmp_path, words)
    before = Path(path).read_bytes()
    reply = _run(path)
    assert reply["unchanged"] is True
    assert reply["affected_tracks"] == []
    assert reply["clip_count"] == 2
    assert Path(path).read_bytes() == before


@pytest.mark.parametrize("role", ["viewer", "commenter", "editor"])
def test_a_guest_role_submitting_shorten_word_gaps_is_refused_as_not_allowed(tmp_path, role):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    command = DocumentCommand(
        type="ShortenWordGaps",
        payload={"max_gap_sec": 0.35},
        client_id="guest",
        client_seq=None,
        role="guest",
    )
    with pytest.raises(PermissionError, match="ShortenWordGaps") as raised:
        DocumentSyncService.open(path).submit(command, capabilities=capabilities_for_role(role))
    assert isinstance(raised.value, CodedPermissionError)
    assert raised.value.code == "share_capability_required"
    assert str(raised.value) == "share capabilities do not allow document command: ShortenWordGaps"
    assert Path(path).read_bytes() == before
    assert _journal(path) == []


@pytest.mark.parametrize("override", [True, False])
def test_a_guest_editor_is_refused_whatever_the_override_flag(tmp_path, override):
    path = _path(tmp_path, _HELD_WORDS)
    before = Path(path).read_bytes()
    command = DocumentCommand(
        type="ShortenWordGaps",
        payload={"use_inaudible_opt": False, "override_audio_checks": override},
        client_id="guest",
        client_seq=None,
        role="guest",
    )
    with pytest.raises(CodedPermissionError) as raised:
        DocumentSyncService.open(path).submit(command, capabilities=capabilities_for_role("editor"))
    assert raised.value.code == "share_capability_required"
    assert Path(path).read_bytes() == before
    assert _journal(path) == []


def test_a_raw_submit_with_a_non_numeric_max_gap_is_a_coded_invalid_payload(tmp_path):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    command = DocumentCommand(
        type="ShortenWordGaps",
        payload={"max_gap_sec": "abc"},
        client_id="mcp-agent",
        client_seq=None,
        role="host",
    )
    with pytest.raises(CodedValueError) as raised:
        DocumentSyncService.open(path).submit(command)
    assert raised.value.code == "invalid_payload"
    assert Path(path).read_bytes() == before
    assert _journal(path) == []


def test_editor_with_the_mcp_capability_is_also_refused(tmp_path):
    path = _path(tmp_path)
    command = DocumentCommand(
        type="ShortenWordGaps",
        payload={},
        client_id="mcp-agent",
        client_seq=None,
        role="guest",
    )
    caps = [*capabilities_for_role("editor"), "mcp"]
    with pytest.raises(CodedPermissionError) as raised:
        DocumentSyncService.open(path).submit(command, capabilities=caps)
    assert raised.value.code == "share_capability_required"


def test_direct_tool_call_journals_one_shorten_row_on_the_document_plane(tmp_path):
    path = _path(tmp_path)
    _run(path)
    assert _journal(path) == ["ShortenWordGaps"]


def test_registered_tool_journals_one_shorten_row_after_an_applying_call(tmp_path):
    path = _path(tmp_path)
    result = _registered({"project_path": path})
    assert not result.is_error
    assert _journal(path) == ["ShortenWordGaps"]
    rows = DocumentSyncService.open(path).store.commands_after(0)
    assert [r["client_id"] for r in rows] == ["mcp-agent"]


def test_registered_tool_journals_one_shorten_row_even_when_the_cut_is_held(tmp_path):
    path = _path(tmp_path, _HELD_WORDS)
    before = Path(path).read_bytes()
    result = _registered({"project_path": path, "use_inaudible_opt": False})
    assert not result.is_error
    assert (
        json.loads(result.content[0].text)["needs_confirmation"]["status"] == "needs_confirmation"
    )
    assert Path(path).read_bytes() == before
    assert _journal(path) == ["ShortenWordGaps"]


def test_registered_tool_journals_one_shorten_row_when_nothing_qualifies(tmp_path):
    path = _path(tmp_path)
    result = _registered({"project_path": path, "max_gap_sec": 5.0})
    assert not result.is_error
    assert json.loads(result.content[0].text)["unchanged"] is True
    assert _journal(path) == ["ShortenWordGaps"]


def test_registered_tool_override_records_the_same_actor(tmp_path):
    path = _path(tmp_path, _HELD_WORDS)
    result = _registered(
        {"project_path": path, "use_inaudible_opt": False, "override_audio_checks": True}
    )
    assert not result.is_error
    assert _entries(path)[1]["params"]["audio_check_override"] == _OVERRIDE
