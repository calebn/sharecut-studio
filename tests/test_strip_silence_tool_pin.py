from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from mcp.client import Client

from pause_policy_public_helpers import (
    configure,
    defaults,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.mcp.tools.history import history_list, history_status_tool, history_undo
from podcast_mcp.models import (
    Clip,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
)
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.util.coded_error import CodedError, CodedPermissionError, CodedValueError

_REPLY_KEYS = {
    "track_id",
    "silence_intervals",
    "clips_created",
    "removed_sec",
    "timeline_duration_sec",
}
_SPEECH = ((0.0, 1.0), (2.5, 3.5), (5.0, 6.0))
_WORDS = [(0.1, 0.4), (1.4, 1.6), (2.6, 2.9), (5.1, 5.4)]
_ISLANDS = [(0.0, 0.0, 1.05), (1.05, 2.45, 3.55), (2.15, 4.95, 6.0)]
_WHOLE = [(0.0, 0.0, 6.0)]


def _path(tmp_path: Path, *, guest: str | None = None, clips=None, words=_WORDS) -> str:
    root = tmp_path / "ws"
    root.mkdir(parents=True)
    result = project(root, guest=guest)
    audio = room()
    for start, end in _SPEECH:
        voice(audio, start, end)
    write_wav(root / "raw" / "host.wav", audio)
    result.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text=f"h{i}", start=a, end=b) for i, (a, b) in enumerate(words)],
        )
    ]
    if clips is not None:
        result.clips = [
            Clip(id=f"host-{i}", track_id="host", source_start=a, source_end=b, timeline_start=t)
            for i, (a, b, t) in enumerate(clips)
        ]
        result.timeline.duration_sec = sum(b - a for a, b, _ in clips)
    return str(workspace(result).path)


def _spans(path: str, track_id: str = "host") -> list[tuple[float, float, float]]:
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


def _run(path: str, **kwargs) -> dict:
    return json.loads(mcp_timeline.strip_silence_tool(path, **kwargs))


def _registered(args: dict):
    async def call():
        async with Client(mcp_server.mcp) as client:
            return await client.call_tool("strip_silence_tool", args)

    return asyncio.run(call())


@pytest.fixture(autouse=True)
def _config(monkeypatch):
    configure(monkeypatch, defaults())


def test_reply_keys_and_values(tmp_path):
    path = _path(tmp_path)
    reply = _run(path, track_id="host")
    assert set(reply) == _REPLY_KEYS
    assert reply["track_id"] == "host"
    assert reply["silence_intervals"] == 2
    assert reply["clips_created"] == 3
    assert reply["removed_sec"] == pytest.approx(2.8)
    assert reply["timeline_duration_sec"] == pytest.approx(3.2)
    assert "operation" not in reply


def test_the_track_is_rebuilt_as_speech_islands_with_micro_fades(tmp_path):
    path = _path(tmp_path)
    assert _spans(path) == _WHOLE
    _run(path, track_id="host")
    assert _spans(path) == [pytest.approx(row) for row in _ISLANDS]
    clips = sorted(
        (c for c in load_project(Path(path)).clips if c.track_id == "host"),
        key=lambda c: c.timeline_start,
    )
    assert [c.fade_in_ms for c in clips] == [0, 10, 10]
    assert [c.fade_out_ms for c in clips] == [10, 10, 10]
    assert {c.join_in_mode.value for c in clips} == {"fade"}
    assert len({c.id for c in clips}) == 3
    assert "host-0" not in {c.id for c in clips}
    assert load_project(Path(path)).timeline.duration_sec == pytest.approx(3.2)


def test_the_rebuild_starts_from_the_source_not_from_earlier_cuts(tmp_path):
    path = _path(tmp_path, clips=[(0.0, 2.0, 0.0), (4.7, 6.0, 2.0)])
    reply = _run(path, track_id="host")
    assert reply["clips_created"] == 3
    assert reply["removed_sec"] == pytest.approx(2.8)
    assert _spans(path) == [pytest.approx(row) for row in _ISLANDS]
    assert load_project(Path(path)).timeline.duration_sec == pytest.approx(3.2)


def test_words_in_removed_source_ranges_are_dropped_and_the_rest_stay_in_source_time(tmp_path):
    path = _path(tmp_path)
    _run(path, track_id="host")
    (transcript,) = load_project(Path(path)).transcripts
    assert [(w.text, w.start, w.end) for w in transcript.words] == [
        ("h0", 0.1, 0.4),
        ("h2", 2.6, 2.9),
        ("h3", 5.1, 5.4),
    ]


def test_only_the_named_track_is_rebuilt(tmp_path):
    path = _path(tmp_path, guest="quiet")
    guest_before = _spans(path, "guest")
    _run(path, track_id="host")
    assert _spans(path, "guest") == guest_before
    assert len(_spans(path, "host")) == 3


def test_speaker_resolves_the_track(tmp_path):
    path = _path(tmp_path, guest="quiet")
    reply = _run(path, speaker="Host")
    assert reply["track_id"] == "host"
    assert len(_spans(path, "host")) == 3


def test_track_id_wins_over_speaker(tmp_path):
    path = _path(tmp_path, guest="quiet")
    reply = _run(path, track_id="host", speaker="Guest")
    assert reply["track_id"] == "host"


def test_a_track_without_contrast_has_no_silence_to_strip(tmp_path):
    path = _path(tmp_path, guest="quiet")
    reply = _run(path, track_id="guest")
    assert reply["silence_intervals"] == 0
    assert reply["clips_created"] == 1
    assert reply["removed_sec"] == pytest.approx(0.0)
    assert _spans(path, "guest") == [pytest.approx((0.0, 0.0, 6.0))]


def test_a_track_of_digital_silence_is_silence_end_to_end(tmp_path):
    path = _path(tmp_path, guest="digital")
    reply = _run(path, track_id="guest")
    assert reply["silence_intervals"] == 1
    assert reply["clips_created"] == 2
    assert reply["removed_sec"] == pytest.approx(5.9)
    assert _spans(path, "guest") == [
        pytest.approx((0.0, 0.0, 0.05)),
        pytest.approx((0.05, 5.95, 6.0)),
    ]


def test_a_whole_track_without_silence_still_rebuilds_and_records_history(tmp_path):
    path = _path(tmp_path)
    reply = _run(path, track_id="host", min_duration_sec=2.0)
    assert reply["silence_intervals"] == 0
    assert reply["clips_created"] == 1
    assert reply["removed_sec"] == pytest.approx(0.0)
    assert reply["timeline_duration_sec"] == pytest.approx(6.0)
    assert _history(path)["total"] == 2


def test_min_duration_sec_decides_which_silences_count(tmp_path):
    path = _path(tmp_path)
    assert _run(path, track_id="host", min_duration_sec=1.4)["silence_intervals"] == 2
    again = _path(tmp_path / "again")
    assert _run(again, track_id="host", min_duration_sec=1.6)["silence_intervals"] == 0


def test_over_voice_floor_db_moves_the_silence_threshold(tmp_path):
    path = _path(tmp_path)
    assert _run(path, track_id="host", over_voice_floor_db=-200.0)["silence_intervals"] == 0
    other = _path(tmp_path / "other")
    assert _run(other, track_id="host", over_voice_floor_db=0.0)["silence_intervals"] == 2


@pytest.mark.parametrize(
    ("kwargs", "intervals", "clips"),
    [
        ({"min_duration_sec": 0.0}, 2, 3),
        ({"min_duration_sec": -1.0}, 2, 3),
    ],
    ids=["min-0", "min-negative"],
)
def test_finite_and_negative_numbers_are_accepted_as_given(tmp_path, kwargs, intervals, clips):
    path = _path(tmp_path)
    reply = _run(path, track_id="host", **kwargs)
    assert reply["silence_intervals"] == intervals
    assert reply["clips_created"] == clips
    assert _history(path)["total"] == 2


@pytest.mark.parametrize("name", ["over_voice_floor_db", "min_duration_sec"])
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), None])
def test_a_non_finite_or_null_number_is_a_coded_invalid_payload_and_changes_nothing(
    tmp_path, name, bad
):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(CodedValueError) as raised:
        _run(path, track_id="host", **{name: bad})
    assert raised.value.code == "invalid_payload"
    assert name in str(raised.value)
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0
    assert _journal(path) == []


@pytest.mark.parametrize("flag", [None, True, False])
def test_use_inaudible_opt_is_ignored(tmp_path, flag):
    path = _path(tmp_path / str(flag))
    reply = _run(path, track_id="host", use_inaudible_opt=flag)
    assert reply["clips_created"] == 3
    assert _spans(path) == [pytest.approx(row) for row in _ISLANDS]
    after = _entries(path)[1]
    assert after["params"]["use_inaudible_opt"] is flag


def test_one_call_adds_a_before_and_after_history_step_and_undo_restores_the_project(tmp_path):
    path = _path(tmp_path)
    before = _state(path)
    _run(path, track_id="host")
    status = _history(path)
    assert status["total"] == 2
    assert status["current_label"] == "after strip silence"
    assert [e["label"] for e in _entries(path)] == ["before strip silence", "after strip silence"]
    assert _state(path) != before
    history_undo(path)
    assert _state(path) == before


def test_history_records_the_resolved_track_and_arguments(tmp_path):
    path = _path(tmp_path)
    _run(path, speaker="Host", over_voice_floor_db=3.0, min_duration_sec=0.4)
    after = _entries(path)[1]
    assert after["operation"] == "strip_silence"
    assert after["params"] == {
        "track_id": "host",
        "over_voice_floor_db": 3.0,
        "min_duration_sec": 0.4,
        "use_inaudible_opt": None,
    }
    assert load_project(Path(path)).editorial.edit_log == []


def test_the_applying_run_records_a_clip_render_invalidation(tmp_path):
    from podcast_mcp.engines.render_invalidations import invalidations_as_dicts

    path = _path(tmp_path)
    _run(path, track_id="host")
    reasons = {entry["reason"] for entry in invalidations_as_dicts(load_project(Path(path)))}
    assert reasons == {"cut"}


def test_neither_track_nor_speaker_is_missing_argument(tmp_path):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(CodedValueError) as raised:
        _run(path)
    assert raised.value.code == "missing_argument"
    assert str(raised.value) == "track_id or speaker is required"
    assert Path(path).read_bytes() == before
    assert _journal(path) == []


def test_unknown_track_id_is_track_not_found(tmp_path):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(CodedError) as raised:
        _run(path, track_id="nope")
    assert isinstance(raised.value, ValueError)
    assert raised.value.conflict is True
    assert raised.value.code == "track_not_found"
    assert str(raised.value) == "unknown track_id: 'nope'"
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0
    assert _journal(path) == []


def test_unknown_speaker_is_track_not_found(tmp_path):
    path = _path(tmp_path)
    with pytest.raises(CodedError) as raised:
        _run(path, speaker="Nobody")
    assert isinstance(raised.value, ValueError)
    assert raised.value.conflict is True
    assert raised.value.code == "track_not_found"
    assert str(raised.value).startswith("no track for speaker 'Nobody'; available: host (")


def test_ambiguous_speaker_is_coded(tmp_path):
    path = _path(tmp_path, guest="quiet")
    with pytest.raises(CodedValueError) as raised:
        _run(path, speaker="s")
    assert raised.value.code == "ambiguous_speaker"
    assert "host" in str(raised.value)
    assert "guest" in str(raised.value)


def test_a_track_without_media_is_track_has_no_media(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    result = project(root)
    result.tracks.append(Track(id="bare", label="Bare", role=TrackRole.DIALOGUE, media=None))
    path = str(workspace(result).path)
    before = Path(path).read_bytes()
    with pytest.raises(CodedError) as raised:
        _run(path, track_id="bare")
    assert isinstance(raised.value, ValueError)
    assert raised.value.conflict is True
    assert raised.value.code == "track_has_no_media"
    assert str(raised.value) == "track 'bare' not found or has no media"
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0
    assert _journal(path) == []


def test_a_missing_media_file_fails_and_changes_nothing(tmp_path):
    path = _path(tmp_path)
    (Path(path).parent / "raw" / "host.wav").unlink()
    before = Path(path).read_bytes()
    with pytest.raises(subprocess.CalledProcessError) as raised:
        _run(path, track_id="host")
    assert not isinstance(raised.value, CodedError)
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0
    assert _journal(path) == []


def test_an_unreadable_media_file_fails_and_changes_nothing(tmp_path):
    path = _path(tmp_path)
    (Path(path).parent / "raw" / "host.wav").write_bytes(b"this is not an audio container")
    before = Path(path).read_bytes()
    with pytest.raises(subprocess.CalledProcessError) as raised:
        _run(path, track_id="host")
    assert not isinstance(raised.value, CodedError)
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0
    assert _journal(path) == []


def test_missing_project_is_project_not_found(tmp_path):
    missing = tmp_path / "nope" / "episode.sharecut"
    with pytest.raises(FileNotFoundError) as raised:
        _run(str(missing), track_id="host")
    assert isinstance(raised.value, CodedError)
    assert raised.value.code == "project_not_found"
    assert str(raised.value) == f"Project not found: {missing}"


def test_registered_tool_reports_a_missing_project_as_an_error(tmp_path):
    missing = str(tmp_path / "nope")
    result = _registered({"project_path": missing, "track_id": "host"})
    assert result.is_error
    assert result.content[0].text == f"Project not found: {missing}"


def test_registered_tool_returns_the_same_reply(tmp_path):
    path = _path(tmp_path)
    result = _registered({"project_path": path, "track_id": "host"})
    assert not result.is_error
    reply = json.loads(result.content[0].text)
    assert set(reply) == _REPLY_KEYS
    assert reply["clips_created"] == 3
    assert _spans(path) == [pytest.approx(row) for row in _ISLANDS]


def test_registered_tool_reports_a_coded_error_with_its_code(tmp_path):
    path = _path(tmp_path)
    result = _registered({"project_path": path, "track_id": "nope"})
    assert result.is_error
    assert result.structured_content == {
        "ok": False,
        "error": "unknown track_id: 'nope'",
        "error_code": "track_not_found",
    }
    assert _journal(path) == []


def test_registered_tool_rejects_a_non_numeric_floor_before_the_service(tmp_path):
    path = _path(tmp_path)
    result = _registered({"project_path": path, "track_id": "host", "over_voice_floor_db": "loud"})
    assert result.is_error
    assert "over_voice_floor_db" in result.content[0].text
    assert _journal(path) == []
    assert _history(path)["total"] == 0


@pytest.mark.parametrize("role", ["viewer", "commenter", "editor"])
def test_a_guest_role_submitting_strip_silence_is_refused_as_not_allowed(tmp_path, role):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    command = DocumentCommand(
        type="StripSilence",
        payload={"track_id": "host"},
        client_id="guest",
        client_seq=None,
        role="guest",
    )
    with pytest.raises(PermissionError, match="StripSilence") as raised:
        DocumentSyncService.open(path).submit(command, capabilities=capabilities_for_role(role))
    assert isinstance(raised.value, CodedPermissionError)
    assert raised.value.code == "share_capability_required"
    assert str(raised.value) == "share capabilities do not allow document command: StripSilence"
    assert Path(path).read_bytes() == before
    assert _journal(path) == []


def test_editor_with_the_mcp_capability_is_also_refused(tmp_path):
    path = _path(tmp_path)
    command = DocumentCommand(
        type="StripSilence",
        payload={},
        client_id="mcp-agent",
        client_seq=None,
        role="guest",
    )
    caps = [*capabilities_for_role("editor"), "mcp"]
    with pytest.raises(CodedPermissionError) as raised:
        DocumentSyncService.open(path).submit(command, capabilities=caps)
    assert raised.value.code == "share_capability_required"


def test_direct_tool_call_journals_one_strip_silence_row(tmp_path):
    path = _path(tmp_path)
    _run(path, track_id="host")
    assert _journal(path) == ["StripSilence"]


def test_registered_tool_journals_one_strip_silence_row_per_applying_call(tmp_path):
    path = _path(tmp_path)
    result = _registered({"project_path": path, "track_id": "host"})
    assert not result.is_error
    assert _journal(path) == ["StripSilence"]
    rows = DocumentSyncService.open(path).store.commands_after(0)
    assert [r["client_id"] for r in rows] == ["mcp-agent"]


def test_registered_tool_journals_one_row_even_when_no_silence_is_found(tmp_path):
    path = _path(tmp_path)
    result = _registered({"project_path": path, "track_id": "host", "min_duration_sec": 2.0})
    assert not result.is_error
    assert json.loads(result.content[0].text)["silence_intervals"] == 0
    assert _journal(path) == ["StripSilence"]


def test_registered_tool_second_call_journals_a_second_row(tmp_path):
    path = _path(tmp_path)
    _registered({"project_path": path, "track_id": "host"})
    _registered({"project_path": path, "track_id": "host"})
    assert _journal(path) == ["StripSilence", "StripSilence"]
    assert _history(path)["total"] == 3
