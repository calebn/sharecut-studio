"""SegmentReport: a participant tells the room how many upload segments it opened for a take (#2416)."""

from __future__ import annotations

import pytest

from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.record import RecordSessionService, RecordStateError
from podcast_mcp.services.record.commands import RecordAuthzError
from podcast_mcp.services.record.service import _store_for, apply_record_ws_message
from podcast_mcp.services.record.state import MAX_REPORTED_SEGMENTS, RecordSnapshot
from podcast_mcp.util.coded_error import CodedValueError
from test_record_returning_people import CAPS, _join_guest, _seed
from test_record_staging import _cmd


def _room(minimal_project, sample_wav, *, stop: bool = False):
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    ava = _join_guest(svc, room, "Ava", 0)
    bea = _join_guest(svc, room, "Bea", 1)
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=1_000)
    svc.submit(_cmd("Start"), now_wall_ms=1_000)
    if stop:
        svc.submit(_cmd("Stop"), now_wall_ms=4_000)
    return ws, svc, ava, bea


def _send(svc, pid, payload, *, role="guest", caps=CAPS, seq=10):
    return apply_record_ws_message(
        svc,
        {"type": "Record", "command_type": "SegmentReport", "payload": payload, "client_seq": seq},
        client_id=f"rec-{pid}",
        role=role,
        participant_id=pid,
        seq=seq,
        capabilities=caps,
    )


def _reports(svc, take=0) -> dict:
    return {
        pid: (entry.segments, entry.final)
        for pid, entry in svc._model().takes[take].segment_reports.items()
    }


def test_a_guest_reports_for_itself_and_a_payload_pid_is_ignored(
    minimal_project, sample_wav, tmp_workspace
):
    _ws, svc, ava, bea = _room(minimal_project, sample_wav)
    _send(svc, ava, {"take_index": 0, "segments": 2, "final": False, "participant_id": bea})
    assert _reports(svc) == {ava: (2, False)}


def test_the_host_reports_as_the_host(minimal_project, sample_wav, tmp_workspace):
    _ws, svc, _ava, _bea = _room(minimal_project, sample_wav, stop=True)
    _send(svc, "p_host", {"take_index": 0, "segments": 1, "final": True}, role="host", caps=None)
    assert _reports(svc) == {"p_host": (1, True)}


def test_a_guest_without_the_join_capability_is_refused(minimal_project, sample_wav, tmp_workspace):
    _ws, svc, ava, _bea = _room(minimal_project, sample_wav)
    with pytest.raises(RecordAuthzError, match="join capability required"):
        _send(svc, ava, {"take_index": 0, "segments": 1, "final": False}, caps=["comment"])
    assert _reports(svc) == {}


@pytest.mark.parametrize("take_index", [-1, True, "0", 0.5, None])
def test_a_bad_take_index_is_refused(minimal_project, sample_wav, tmp_workspace, take_index):
    _ws, svc, ava, _bea = _room(minimal_project, sample_wav)
    with pytest.raises(CodedValueError):
        _send(svc, ava, {"take_index": take_index, "segments": 1, "final": False})


@pytest.mark.parametrize("segments", [-1, True, "1", 1.5, None])
def test_a_bad_segment_count_is_refused(minimal_project, sample_wav, tmp_workspace, segments):
    _ws, svc, ava, _bea = _room(minimal_project, sample_wav)
    with pytest.raises(CodedValueError):
        _send(svc, ava, {"take_index": 0, "segments": segments, "final": False})


@pytest.mark.parametrize("final", ["yes", 1, None])
def test_a_bad_final_flag_is_refused(minimal_project, sample_wav, tmp_workspace, final):
    _ws, svc, ava, _bea = _room(minimal_project, sample_wav)
    with pytest.raises(CodedValueError):
        _send(svc, ava, {"take_index": 0, "segments": 1, "final": final})


def test_an_unknown_take_is_refused(minimal_project, sample_wav, tmp_workspace):
    _ws, svc, ava, _bea = _room(minimal_project, sample_wav)
    with pytest.raises(RecordStateError, match="unknown take"):
        _send(svc, ava, {"take_index": 1, "segments": 1, "final": False})


def test_a_removed_participant_cannot_report(minimal_project, sample_wav, tmp_workspace):
    _ws, svc, ava, _bea = _room(minimal_project, sample_wav)
    svc.submit(_cmd("RemoveParticipant", payload={"participant_id": ava}), now_wall_ms=2_000)
    with pytest.raises(RecordStateError):
        _send(svc, ava, {"take_index": 0, "segments": 1, "final": False})


def test_reports_only_grow_and_final_sticks(minimal_project, sample_wav, tmp_workspace):
    _ws, svc, ava, _bea = _room(minimal_project, sample_wav)
    _send(svc, ava, {"take_index": 0, "segments": 2, "final": False})
    _send(svc, ava, {"take_index": 0, "segments": 1, "final": False})
    assert _reports(svc) == {ava: (2, False)}
    _send(svc, ava, {"take_index": 0, "segments": 2, "final": True}, seq=11)
    _send(svc, ava, {"take_index": 0, "segments": 2, "final": True}, seq=12)
    _send(svc, ava, {"take_index": 0, "segments": 3, "final": False}, seq=13)
    assert _reports(svc) == {ava: (3, True)}


def test_a_report_stays_on_its_own_take(minimal_project, sample_wav, tmp_workspace):
    _ws, svc, ava, _bea = _room(minimal_project, sample_wav, stop=True)
    svc.submit(_cmd("Start"), now_wall_ms=5_000)
    _send(svc, ava, {"take_index": 1, "segments": 2, "final": False})
    assert _reports(svc, 0) == {}
    assert _reports(svc, 1) == {ava: (2, False)}


def test_reports_survive_the_snapshot_round_trip_and_old_snapshots_load_empty(
    minimal_project, sample_wav, tmp_workspace
):
    ws, svc, ava, _bea = _room(minimal_project, sample_wav)
    _send(svc, ava, {"take_index": 0, "segments": 2, "final": True})
    stored = _store_for(ws.project).get_snapshot()
    again = RecordSnapshot.model_validate(stored)
    assert again.takes[0].segment_reports[ava].segments == 2
    assert svc.snapshot()["takes"][0]["segment_reports"][ava] == {"segments": 2, "final": True}
    for take in stored["takes"]:
        take.pop("segment_reports", None)
    assert RecordSnapshot.model_validate(stored).takes[0].segment_reports == {}


def test_a_count_above_the_cap_is_clamped_not_dropped(minimal_project, sample_wav, tmp_workspace):
    _ws, svc, ava, _bea = _room(minimal_project, sample_wav)
    _send(svc, ava, {"take_index": 0, "segments": 10**6, "final": False})
    assert _reports(svc) == {ava: (MAX_REPORTED_SEGMENTS, False)}
