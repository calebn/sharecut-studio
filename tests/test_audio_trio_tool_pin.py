"""strip_silence_tool, shorten_gaps_tool and fill_with_room_tone_tool keep their replies,
errors, effects, history and journal shape (#1809)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import Clip, load_project, save_project
from test_edit_modes import DUR, SR, _words, _write_wav
from test_edit_modes import episode as _episode_fixture
from test_ripple_delete_text_tool_pin import _history, _journal_types, _reasons, _registered

episode = _episode_fixture

_STRIP_KEYS = {
    "track_id",
    "silence_intervals",
    "clips_created",
    "removed_sec",
    "timeline_duration_sec",
}
_SHORTEN_KEYS = {
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
_SHORTEN_UNCHANGED_KEYS = {
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "unchanged",
}
_FILL_KEYS = {"operation", "affected_tracks", "clip_count", "timeline_duration_sec", "pad_samples"}
_AGENT_OVERRIDE = {"kind": "owner_override", "actor": "mcp:host", "surface": "agent"}


def _speech_and_room(room: str) -> np.ndarray:
    rng = np.random.default_rng(11)
    t = np.arange(SR) / SR
    speech = 0.1 * np.sqrt(2) * np.sin(2 * np.pi * 180 * t)

    def quiet(seconds: int) -> np.ndarray:
        if room == "silent":
            return np.zeros(seconds * SR)
        return rng.standard_normal(seconds * SR) * 10 ** (-55 / 20)

    parts: list[np.ndarray] = []
    for _ in range(4):
        parts += [speech, quiet(1)]
    parts.append(quiet(12))
    return np.concatenate(parts)


def _prepare(path: Path, room: str) -> Path:
    project = load_project(path)
    _write_wav(project.raw_dir() / "host.wav", _speech_and_room(room))
    _write_wav(project.raw_dir() / "guest.wav", np.zeros(int(DUR * SR)))
    for transcript in project.transcripts:
        transcript.words = (
            _words(
                ("one", 0.0, 1.2, False),
                ("two", 1.8, 3.2, False),
                ("three", 3.8, 5.2, False),
                ("four", 5.8, 7.2, False),
            )
            if transcript.track_id == "host"
            else []
        )
    save_project(project)
    return path


@pytest.fixture
def trio(episode: Path) -> Path:
    return _prepare(episode, "silent")


@pytest.fixture
def breathy(episode: Path) -> Path:
    _prepare(episode, "silent")
    project = load_project(episode)
    host = next(t for t in project.transcripts if t.track_id == "host")
    host.words = _words(
        ("one", 0.0, 1.0, False),
        ("two", 2.0, 3.0, False),
        ("three", 4.0, 5.0, False),
        ("four", 6.0, 7.0, False),
    )
    save_project(project)
    return episode


@pytest.fixture
def noisy(episode: Path) -> Path:
    _prepare(episode, "noise")
    project = load_project(episode)
    project.timeline.clips = [c for c in project.clips if c.track_id != "host"] + [
        Clip(id="a", track_id="host", source_start=0.0, source_end=1.5, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=2.0, source_end=3.5, timeline_start=3.0),
    ]
    save_project(project)
    return episode


def _spans(path: Path, track: str | None = None) -> list[tuple[str, float, float, float]]:
    return sorted(
        (c.track_id, c.timeline_start, c.source_start, c.source_end)
        for c in load_project(path).clips
        if track is None or c.track_id == track
    )


def _guest_remark(path: Path, start: float = 1.3, end: float = 1.7) -> None:
    project = load_project(path)
    guest = np.zeros(int(DUR * SR))
    lo, hi = int(start * SR), int(end * SR)
    guest[lo:hi] = 0.1 * np.sin(2 * np.pi * 330 * np.arange(hi - lo) / SR)
    _write_wav(project.raw_dir() / "guest.wav", guest)


def _untouched(path: Path, before: bytes) -> None:
    assert path.read_bytes() == before
    assert load_project(path).editorial.edit_log == []
    assert _history(path) == []


def _strip(path: Path, **kwargs) -> dict:
    return json.loads(mcp_timeline.strip_silence_tool(str(path), **kwargs))


def _shorten(path: Path, *args, **kwargs) -> dict:
    return json.loads(mcp_timeline.shorten_gaps_tool(str(path), *args, **kwargs))


def _fill(path: Path, **kwargs) -> dict:
    return json.loads(mcp_timeline.fill_with_room_tone_tool(str(path), **kwargs))


def test_strip_reply_keys_and_values(trio):
    reply = _strip(trio, track_id="host")
    assert set(reply) == _STRIP_KEYS
    assert reply["track_id"] == "host"
    assert reply["silence_intervals"] == 4
    assert reply["clips_created"] == 5
    assert reply["removed_sec"] == pytest.approx(15.6)
    assert reply["timeline_duration_sec"] == pytest.approx(20.0)


def test_strip_rebuilds_the_track_from_speech_islands(trio):
    _strip(trio, track_id="host")
    expected = [
        (0.0, 0.0, 1.05),
        (1.05, 1.95, 3.05),
        (2.15, 3.95, 5.05),
        (3.25, 5.95, 7.05),
        (4.35, 19.95, 20.0),
    ]
    got = _spans(trio, "host")
    assert [track for track, *_ in got] == ["host"] * 5
    assert [row[1:] for row in got] == [tuple(pytest.approx(v) for v in row) for row in expected]
    assert _spans(trio, "guest") == [("guest", 0.0, 0.0, 20.0)]


def test_strip_by_speaker_resolves_to_the_track(trio):
    reply = _strip(trio, speaker="Host")
    assert reply["track_id"] == "host"
    assert _history(trio)[1]["params"]["track_id"] == "host"


def test_strip_history_labels_operation_and_params(trio):
    _strip(trio, track_id="host")
    entries = _history(trio)
    assert [e["label"] for e in entries] == ["before strip silence", "after strip silence"]
    assert entries[0]["operation"] is None
    assert entries[0]["params"] is None
    assert entries[1]["operation"] == "strip_silence"
    assert entries[1]["params"] == {
        "track_id": "host",
        "over_voice_floor_db": 0.0,
        "min_duration_sec": 0.5,
        "use_inaudible_opt": None,
    }


def test_strip_use_inaudible_opt_is_ignored_but_recorded(trio):
    reply = _strip(trio, track_id="host", use_inaudible_opt=True)
    assert set(reply) == _STRIP_KEYS
    assert reply["silence_intervals"] == 4
    assert reply["clips_created"] == 5
    assert reply["removed_sec"] == pytest.approx(15.6)
    assert _spans(trio, "host")[1][2:] == pytest.approx((1.95, 3.05))
    assert _history(trio)[1]["params"]["use_inaudible_opt"] is True


def test_strip_arguments_reach_the_history_params(trio):
    _strip(trio, track_id="host", over_voice_floor_db=3.0, min_duration_sec=1.5)
    assert _history(trio)[1]["params"] == {
        "track_id": "host",
        "over_voice_floor_db": 3.0,
        "min_duration_sec": 1.5,
        "use_inaudible_opt": None,
    }


def test_strip_min_duration_sec_keeps_shorter_silences(trio):
    reply = _strip(trio, track_id="host", min_duration_sec=1.5)
    assert reply["silence_intervals"] == 1
    assert reply["clips_created"] == 2
    assert reply["removed_sec"] == pytest.approx(12.9)


def test_strip_over_voice_floor_db_raises_the_silence_threshold(trio):
    reply = _strip(trio, track_id="host", over_voice_floor_db=40.0)
    assert reply["silence_intervals"] == 1
    assert reply["clips_created"] == 2
    assert reply["removed_sec"] == pytest.approx(19.9)


def test_strip_on_a_track_with_no_live_audio_removes_it_end_to_end(trio):
    reply = _strip(trio, track_id="guest")
    assert reply["silence_intervals"] == 1
    assert reply["clips_created"] == 2
    assert reply["removed_sec"] == pytest.approx(29.9)


def test_strip_writes_no_edit_log_record(trio):
    _strip(trio, track_id="host")
    assert load_project(trio).editorial.edit_log == []


def test_strip_records_a_cut_render_invalidation(trio):
    _strip(trio, track_id="host")
    assert _reasons(trio) == {"cut"}


def test_strip_unknown_track_raises_track_not_found_and_writes_nothing(trio):
    before = trio.read_bytes()
    with pytest.raises(ValueError) as raised:
        _strip(trio, track_id="nope")
    assert raised.value.code == "track_not_found"
    _untouched(trio, before)


def test_strip_unknown_speaker_raises_track_not_found(trio):
    with pytest.raises(ValueError) as raised:
        _strip(trio, speaker="Nobody")
    assert raised.value.code == "track_not_found"


def test_strip_without_track_or_speaker_raises_missing_argument(trio):
    with pytest.raises(ValueError) as raised:
        _strip(trio)
    assert raised.value.code == "missing_argument"


def test_strip_track_without_media_raises_track_has_no_media_and_writes_nothing(trio):
    project = load_project(trio)
    project.track_by_id("guest").media = None
    save_project(project)
    before = trio.read_bytes()
    with pytest.raises(ValueError) as raised:
        _strip(trio, track_id="guest")
    assert raised.value.code == "track_has_no_media"
    _untouched(trio, before)


def test_shorten_reply_keys_and_values(trio):
    reply = _shorten(trio, use_inaudible_opt=False)
    assert set(reply) == _SHORTEN_KEYS
    assert reply["operation"] == "shorten_word_gaps"
    assert reply["affected_tracks"] == ["host", "guest"]
    assert reply["clip_count"] == 9
    assert reply["max_gap_sec"] == 0.35
    assert reply["use_inaudible_opt"] is False
    assert reply["span_count"] == 3
    assert reply["timeline_start"] == pytest.approx(1.2)
    assert reply["timeline_end"] == pytest.approx(1.45)
    assert reply["timeline_duration_sec"] == pytest.approx(19.25)
    assert set(reply["per_track_source"]) == {"host", "guest"}
    for bounds in reply["per_track_source"].values():
        assert bounds == pytest.approx([1.2, 1.45])


def test_shorten_ripples_every_dialogue_track(trio):
    _shorten(trio, use_inaudible_opt=False)
    assert load_project(trio).timeline.duration_sec == pytest.approx(19.25)
    expected = [
        (0.0, 0.0, 1.2),
        (1.2, 1.45, 3.2),
        (2.95, 3.45, 5.2),
        (4.7, 5.45, 8.0),
    ]
    host = _spans(trio, "host")
    assert [(a, b, c) for _t, a, b, c in host[:4]] == [
        tuple(pytest.approx(v) for v in row) for row in expected
    ]
    assert host[4][1:] == pytest.approx((7.25, 8.0, 20.0))
    guest = _spans(trio, "guest")
    assert [(a, b, c) for _t, a, b, c in guest[:3]] == [
        tuple(pytest.approx(v) for v in row) for row in expected[:3]
    ]
    assert guest[3][1:] == pytest.approx((4.7, 5.45, 20.0))


def test_shorten_max_gap_sec_sets_the_kept_pause(trio):
    reply = _shorten(trio, 0.5, use_inaudible_opt=False)
    assert reply["max_gap_sec"] == 0.5
    assert reply["span_count"] == 3
    assert reply["timeline_start"] == pytest.approx(1.2)
    assert reply["timeline_end"] == pytest.approx(1.3)
    assert reply["timeline_duration_sec"] == pytest.approx(19.7)


def test_shorten_history_labels_operation_and_params(trio):
    _shorten(trio, 0.5, use_inaudible_opt=False)
    entries = _history(trio)
    assert [e["label"] for e in entries] == ["before shorten gaps", "after shorten gaps"]
    assert entries[0]["operation"] is None
    assert entries[0]["params"] is None
    assert entries[1]["operation"] == "shorten_word_gaps"
    assert entries[1]["params"] == {"max_gap_sec": 0.5, "use_inaudible_opt": False}


def test_shorten_edit_log_records_one_ripple_delete_per_gap_right_to_left(trio):
    _shorten(trio, use_inaudible_opt=False)
    records = load_project(trio).editorial.edit_log
    assert [r.operation for r in records] == ["ripple_delete"] * 3
    assert [r.timeline_start for r in records] == pytest.approx([5.2, 3.2, 1.2])
    for record in records:
        assert record.track_ids == ["host", "guest"]
        assert set(record.params) == {"max_gap_sec", "use_inaudible_opt", "per_track_source"}
        assert record.params["max_gap_sec"] == 0.35
        assert record.params["use_inaudible_opt"] is False
        assert "audio_check_override" not in record.params


def test_shorten_records_a_cut_render_invalidation(trio):
    _shorten(trio, use_inaudible_opt=False)
    assert _reasons(trio) == {"cut"}


def test_shorten_with_nothing_to_shorten_returns_an_unchanged_summary_and_no_history(trio):
    before = trio.read_bytes()
    reply = _shorten(trio, 5.0, use_inaudible_opt=False)
    assert set(reply) == _SHORTEN_UNCHANGED_KEYS
    assert reply["operation"] == "shorten_word_gaps"
    assert reply["unchanged"] is True
    assert reply["affected_tracks"] == []
    assert reply["clip_count"] == 3
    assert reply["timeline_duration_sec"] == pytest.approx(20.0)
    _untouched(trio, before)
    assert _reasons(trio) == set()


def test_shorten_a_second_run_finds_nothing_more(trio):
    _shorten(trio, use_inaudible_opt=False)
    reply = _shorten(trio, use_inaudible_opt=False)
    assert reply["unchanged"] is True
    assert len(_history(trio)) == 2
    assert len(load_project(trio).editorial.edit_log) == 3


def test_shorten_with_snapped_edges_on_a_breath_holds_the_cut_and_writes_nothing(breathy):
    before = breathy.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as raised:
        _shorten(breathy)
    assert raised.value.code == "cut_scope_changed"
    assert "override_audio_checks=true" in str(raised.value)
    _untouched(breathy, before)


def test_shorten_exact_word_bounds_on_a_breath_are_held_too(breathy):
    with pytest.raises(ScopeChangedAtApproval):
        _shorten(breathy, use_inaudible_opt=False)


def test_shorten_override_applies_a_held_cut_without_reply_markers(breathy):
    reply = _shorten(breathy, override_audio_checks=True)
    assert set(reply) == _SHORTEN_KEYS
    assert reply["use_inaudible_opt"] is None
    assert reply["span_count"] == 3
    assert "unchanged" not in reply
    assert "audio_check_override" not in reply
    assert _reasons(breathy) == {"cut"}


def test_shorten_override_keeps_a_true_use_inaudible_opt(trio):
    reply = _shorten(trio, use_inaudible_opt=True, override_audio_checks=True)
    assert reply["use_inaudible_opt"] is True
    assert _history(trio)[1]["params"]["use_inaudible_opt"] is True


def test_shorten_other_speaker_in_the_pause_replies_needs_confirmation(trio):
    _guest_remark(trio)
    before = trio.read_bytes()
    reply = _shorten(trio, use_inaudible_opt=False)
    assert set(reply) == {"operation", "unchanged", "needs_confirmation", "apply_anyway"}
    assert reply["operation"] == "shorten_word_gaps"
    assert reply["unchanged"] is True
    confirm = reply["needs_confirmation"]
    assert confirm["status"] == "needs_confirmation"
    assert confirm["reason"] == "cuts_other_speech"
    assert [t["track_id"] for t in confirm["speech"]["tracks"]] == ["guest"]
    assert "override_audio_checks=true" in reply["apply_anyway"]
    _untouched(trio, before)


def test_shorten_override_applies_the_other_speaker_cut(trio):
    _guest_remark(trio)
    reply = _shorten(trio, use_inaudible_opt=False, override_audio_checks=True)
    assert reply["operation"] == "shorten_word_gaps"
    assert reply["span_count"] == 3
    assert "unchanged" not in reply
    assert [t["track_id"] for t in reply["cut_speech"]["tracks"]] == ["guest"]
    assert load_project(trio).timeline.duration_sec == pytest.approx(19.25)
    assert len(load_project(trio).editorial.edit_log) == 3
    assert _reasons(trio) == {"cut"}


def test_shorten_does_not_force_use_inaudible_opt_false_on_override(trio):
    _guest_remark(trio)
    reply = _shorten(trio, use_inaudible_opt=True, override_audio_checks=True)
    assert reply["use_inaudible_opt"] is True


def test_fill_reply_keys_and_values(noisy):
    reply = _fill(noisy, track_id="host")
    assert set(reply) == _FILL_KEYS
    assert reply["operation"] == "fill_with_room_tone"
    assert reply["affected_tracks"] == ["host"]
    assert reply["clip_count"] == 9
    assert reply["timeline_duration_sec"] == pytest.approx(20.0)
    assert len(reply["pad_samples"]) == 6
    for sample in reply["pad_samples"]:
        assert set(sample) == {"track_id", "source_id", "source_start", "source_end"}
        assert sample["track_id"] == "host"
        assert sample["source_id"] is None
        assert sample["source_start"] == pytest.approx(1.375)
        assert sample["source_end"] == pytest.approx(1.625)


def test_fill_by_speaker_resolves_to_the_track(noisy):
    assert _fill(noisy, speaker="Host")["affected_tracks"] == ["host"]


def test_fill_inserts_room_tone_clips_across_the_gap(noisy):
    _fill(noisy, track_id="host")
    got = _spans(noisy, "host")
    assert [round(start, 6) for _t, start, _a, _b in got] == [
        0.0,
        1.5,
        1.75,
        2.0,
        2.25,
        2.5,
        2.75,
        3.0,
    ]
    for _t, _start, source_start, source_end in got[1:7]:
        assert (source_start, source_end) == pytest.approx((1.375, 1.625))
    assert got[7][2:] == pytest.approx((2.0, 3.5))
    assert load_project(noisy).timeline.duration_sec == pytest.approx(20.0)
    assert _spans(noisy, "guest") == [("guest", 0.0, 0.0, 20.0)]


def test_fill_pieces_fade_at_the_gap_edges(noisy):
    _fill(noisy, track_id="host")
    pieces = sorted(
        (c for c in load_project(noisy).clips if c.track_id == "host" and c.id not in {"a", "b"}),
        key=lambda c: c.timeline_start,
    )
    assert [c.fade_in_ms for c in pieces] == [10, 0, 0, 0, 0, 0]
    assert [c.fade_out_ms for c in pieces] == [0, 0, 0, 0, 0, 10]
    assert {c.join_in_mode.value for c in pieces} == {"fade"}
    assert {c.source_id for c in pieces} == {None}


def test_fill_history_labels_have_no_operation_and_no_params(noisy):
    _fill(noisy, track_id="host")
    entries = _history(noisy)
    assert [e["label"] for e in entries] == ["before fill room tone", "after fill room tone"]
    for entry in entries:
        assert entry["operation"] is None
        assert entry["params"] is None


def test_fill_edit_log_records_the_inserted_clips(noisy):
    _fill(noisy, track_id="host")
    (record,) = load_project(noisy).editorial.edit_log
    assert record.operation == "fill_with_room_tone"
    assert record.track_ids == ["host"]
    assert set(record.params) == {"pad_samples", "clips"}
    assert len(record.params["pad_samples"]) == 6
    assert len(record.params["clips"]) == 6
    assert {c["track_id"] for c in record.params["clips"]} == {"host"}


def test_fill_records_an_other_render_invalidation(noisy):
    _fill(noisy, track_id="host")
    assert _reasons(noisy) == {"other"}


def test_fill_with_fewer_than_two_clips_returns_an_unchanged_summary_and_only_the_before_history_row(
    noisy,
):
    reply = _fill(noisy, track_id="guest")
    assert set(reply) == _FILL_KEYS
    assert reply["operation"] == "fill_with_room_tone"
    assert reply["affected_tracks"] == ["guest"]
    assert reply["pad_samples"] == []
    assert reply["clip_count"] == 3
    assert "unchanged" not in reply
    assert _spans(noisy, "guest") == [("guest", 0.0, 0.0, 20.0)]
    assert load_project(noisy).editorial.edit_log == []
    (entry,) = _history(noisy)
    assert entry["label"] == "before fill room tone"
    assert entry["operation"] is None
    assert entry["params"] is None
    assert _reasons(noisy) == set()


def test_fill_without_usable_room_tone_leaves_the_gap(trio):
    project = load_project(trio)
    project.timeline.clips = [c for c in project.clips if c.track_id != "host"] + [
        Clip(id="a", track_id="host", source_start=0.0, source_end=1.5, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=2.0, source_end=3.5, timeline_start=3.0),
    ]
    save_project(project)
    reply = _fill(trio, track_id="host")
    assert reply["pad_samples"] == []
    assert len(_spans(trio, "host")) == 2
    assert load_project(trio).editorial.edit_log == []


def test_fill_a_second_run_inserts_nothing_more(noisy):
    _fill(noisy, track_id="host")
    reply = _fill(noisy, track_id="host")
    assert reply["pad_samples"] == []
    assert reply["clip_count"] == 9
    assert len(load_project(noisy).editorial.edit_log) == 1


def test_fill_unknown_track_raises_track_not_found_and_writes_nothing(noisy):
    before = noisy.read_bytes()
    with pytest.raises(ValueError) as raised:
        _fill(noisy, track_id="nope")
    assert raised.value.code == "track_not_found"
    _untouched(noisy, before)


def test_fill_unknown_speaker_raises_track_not_found(noisy):
    with pytest.raises(ValueError) as raised:
        _fill(noisy, speaker="Nobody")
    assert raised.value.code == "track_not_found"


def test_fill_without_track_or_speaker_raises_missing_argument(noisy):
    with pytest.raises(ValueError) as raised:
        _fill(noisy)
    assert raised.value.code == "missing_argument"


def test_fill_track_without_media_raises_track_has_no_media_and_writes_nothing(noisy):
    project = load_project(noisy)
    project.track_by_id("host").media = None
    save_project(project)
    before = noisy.read_bytes()
    with pytest.raises(ValueError) as raised:
        _fill(noisy, track_id="host")
    assert raised.value.code == "track_has_no_media"
    _untouched(noisy, before)


def test_the_registered_strip_tool_matches_the_direct_reply(trio):
    registered = _registered("strip_silence_tool")
    reply = json.loads(registered(str(trio), track_id="host"))
    assert set(reply) == _STRIP_KEYS
    assert reply["clips_created"] == 5
    assert _history(trio)[1]["operation"] == "strip_silence"


def test_the_registered_shorten_tool_matches_the_direct_reply(trio):
    registered = _registered("shorten_gaps_tool")
    reply = json.loads(registered(str(trio), use_inaudible_opt=False))
    assert set(reply) == _SHORTEN_KEYS
    assert reply["operation"] == "shorten_word_gaps"
    assert load_project(trio).timeline.duration_sec == pytest.approx(19.25)


def test_the_registered_fill_tool_matches_the_direct_reply(noisy):
    registered = _registered("fill_with_room_tone_tool")
    reply = json.loads(registered(str(noisy), track_id="host"))
    assert set(reply) == _FILL_KEYS
    assert len(reply["pad_samples"]) == 6


def test_a_failed_call_through_the_registered_tools_journals_nothing(trio):
    for name, kwargs in (
        ("strip_silence_tool", {"track_id": "nope"}),
        ("fill_with_room_tone_tool", {"track_id": "nope"}),
    ):
        with pytest.raises(ValueError):
            _registered(name)(str(trio), **kwargs)
    assert _journal_types(trio) == []


def test_the_trio_commands_validate_with_the_tool_defaults():
    from podcast_mcp.services.document_sync.payloads import validate_payload

    assert validate_payload("ShortenWordGaps", {}) == {
        "max_gap_sec": 0.35,
        "use_inaudible_opt": None,
        "override_audio_checks": False,
    }
    assert validate_payload("FillRoomTone", {}) == {"track_id": None, "speaker": None}


def test_the_trio_commands_are_host_only_for_every_share_role():
    from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
    from podcast_mcp.services.document_sync.capabilities import authorize_document_command

    for command in ("ShortenWordGaps", "FillRoomTone"):
        authorize_document_command(None, command)
        for role in ("viewer", "commenter", "editor"):
            with pytest.raises(PermissionError) as raised:
                authorize_document_command(capabilities_for_role(role, with_mcp=True), command)
            assert raised.value.code == "share_capability_required"


def test_strip_direct_call_journals_nothing_current_journal(trio):
    _strip(trio, track_id="host")
    assert _journal_types(trio) == []


def test_shorten_journals_one_command_row(trio):
    _shorten(trio, use_inaudible_opt=False)
    assert _journal_types(trio) == ["ShortenWordGaps"]


def test_shorten_unchanged_journals_one_command_row(trio):
    _shorten(trio, 5.0, use_inaudible_opt=False)
    assert _journal_types(trio) == ["ShortenWordGaps"]


def test_fill_journals_one_command_row(noisy):
    _fill(noisy, track_id="host")
    assert _journal_types(noisy) == ["FillRoomTone"]


def test_fill_with_fewer_than_two_clips_journals_one_command_row(trio):
    _fill(trio, track_id="host")
    assert _journal_types(trio) == ["FillRoomTone"]


def test_registered_strip_journals_one_external_mutate_row_current_journal(trio):
    _registered("strip_silence_tool")(str(trio), track_id="host")
    assert _journal_types(trio) == ["ExternalMutate"]


def test_registered_shorten_journals_one_command_row(trio):
    _registered("shorten_gaps_tool")(str(trio), use_inaudible_opt=False)
    assert _journal_types(trio) == ["ShortenWordGaps"]


def test_registered_fill_journals_one_command_row(noisy):
    _registered("fill_with_room_tone_tool")(str(noisy), track_id="host")
    assert _journal_types(noisy) == ["FillRoomTone"]


def test_shorten_override_records_the_agent_surface_in_the_edit_log(trio):
    _guest_remark(trio)
    _shorten(trio, use_inaudible_opt=False, override_audio_checks=True)
    records = load_project(trio).editorial.edit_log
    assert len(records) == 3
    for record in records:
        assert record.params["audio_check_override"] == _AGENT_OVERRIDE


def test_shorten_override_records_the_agent_surface_in_history(trio):
    _guest_remark(trio)
    _shorten(trio, use_inaudible_opt=False, override_audio_checks=True)
    assert _history(trio)[1]["params"] == {
        "max_gap_sec": 0.35,
        "use_inaudible_opt": False,
        "audio_check_override": _AGENT_OVERRIDE,
    }


def test_shorten_held_override_records_the_agent_surface(breathy):
    _shorten(breathy, override_audio_checks=True)
    assert _history(breathy)[1]["params"] == {
        "max_gap_sec": 0.35,
        "use_inaudible_opt": None,
        "audio_check_override": _AGENT_OVERRIDE,
    }
