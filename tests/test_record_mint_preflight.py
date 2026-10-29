"""Minting a room while a stopped take is not saved: report it, and land first on request (#2336)."""

from __future__ import annotations

import json
import time

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.mcp.tools.record import record_state_tool
from podcast_mcp.mcp.tools.review import create_record_room_tool
from podcast_mcp.services.collaboration.share import ShareService, lookup_share
from podcast_mcp.services.document import HistoryService, SessionSuggestionService
from podcast_mcp.services.record import (
    RecordControlService,
    RecordLandingError,
    RecordSessionService,
    RecordStateError,
    preflight,
    unsaved_takes,
)
from podcast_mcp.services.record.landing import RecordLandingService
from podcast_mcp.services.record.state import MAX_REPORTED_SEGMENTS
from podcast_mcp.services.record.upload import RecordUploadService, sha256_hex
from podcast_mcp.util.wav import pcm_wav_header
from test_record_returning_people import _ack, _clips_by_track, _join_guest, _room, _tracks
from test_record_staging import _cmd, _seed, _suggestion
from test_record_start_target import (
    START,
    _clips,
    _episode,
    _join_as,
    _take,
)

INSERT = {"kind": "insert", "at_sec": 1.0}


def _flags(ws) -> tuple[bool, int]:
    snap = RecordControlService(ws).snapshot()
    return snap["unlanded_take"], snap["unlanded_takes"]


def _revoked(token: str) -> bool:
    with pytest.raises(KeyError):
        lookup_share(token, kind="record")
    return True


def test_no_take_means_no_flag(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    first = ShareService(ws).create_record_room()
    assert (first["unlanded_take"], first["unlanded_takes"]) == (False, 0)
    assert "warning" not in first
    assert _flags(ws) == (False, 0)
    second = ShareService(ws).create_record_room()
    assert second["unlanded_take"] is False
    assert "warning" not in second


def test_a_stopped_unlanded_take_is_reported_and_the_mint_still_happens(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    old, _pids = _room(ws, ["Ava"])
    assert _flags(ws) == (True, 1)
    assert unsaved_takes(ws.project).takes == 1
    state = json.loads(record_state_tool(str(minimal_project)))
    assert (state["unlanded_take"], state["unlanded_takes"]) == (True, 1)

    new = ShareService(ws).create_record_room()
    assert (new["unlanded_take"], new["unlanded_takes"]) == (True, 1)
    assert "1 stopped take in this room is not saved" in new["warning"]
    assert "landed_first" not in new
    assert _revoked(old["guest"]["token"])
    assert RecordSessionService.active_session_id(ws.project) == new["session_id"]
    # Start anyway is today's behaviour: the take is left under the old room, unlanded.
    ws.reload()
    assert not ws.project.clips
    assert _flags(ws) == (False, 0)


def test_land_first_lands_the_take_then_mints_and_revokes(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    old, [pid] = _room(ws, ["Ava"])
    new = ShareService(ws).create_record_room(land_first=True)
    assert (new["unlanded_take"], new["unlanded_takes"]) == (False, 0)
    assert "warning" not in new
    assert len(new["landed_first"]["clips"]) == 1
    ws.reload()
    [clip] = ws.project.clips
    assert clip.track_id == pid
    assert clip.timeline_start == 0.0
    assert HistoryService(ws).list_entries().groups[-1].title.startswith("Added Session 1")
    assert _revoked(old["guest"]["token"]) and _revoked(old["producer"]["token"])
    assert lookup_share(new["guest"]["token"], kind="record")["session_id"] == new["session_id"]


def test_land_first_with_two_people(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava", "Bea"])
    assert _flags(ws) == (True, 1)  # one take, however many people recorded it
    new = ShareService(ws).create_record_room(land_first=True)
    assert len(new["landed_first"]["clips"]) == 2
    ws.reload()
    assert len({c.track_id for c in ws.project.clips}) == 2


def test_land_first_with_nothing_to_save_just_mints(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    new = ShareService(ws).create_record_room(land_first=True)
    assert "landed_first" not in new
    again = ShareService(ws).create_record_room(land_first=True)
    assert "landed_first" not in again


def test_no_flag_once_landed_or_discarded(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    assert _flags(ws) == (False, 0)
    assert ShareService(ws).create_record_room()["unlanded_take"] is False

    _room(ws, ["Bea"])
    assert _flags(ws) == (True, 1)
    RecordControlService(ws).discard_take(0)
    assert _flags(ws) == (False, 0)
    assert ShareService(ws).create_record_room()["unlanded_take"] is False


def test_an_open_take_still_blocks_the_mint(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    _join_guest(svc, room, "Ava", 0)
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    with pytest.raises(RecordStateError):
        ShareService(ws).create_record_room(land_first=True)
    assert _flags(ws) == (False, 0)


def test_a_land_refusal_stops_the_mint_and_keeps_the_old_links(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, _ = _room(ws, ["Ava"])

    def refuse(self, **_k):
        raise RecordLandingError("nope")

    monkeypatch.setattr(RecordLandingService, "land", refuse)
    with pytest.raises(RecordLandingError):
        ShareService(ws).create_record_room(land_first=True)
    assert lookup_share(old["guest"]["token"], kind="record")
    assert RecordSessionService.active_session_id(ws.project) == old["session_id"]
    assert _flags(ws) == (True, 1)


def test_land_first_matches_returning_people_by_name(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava", "Bea"], land=True)
    tracks = _tracks(ws)
    # Second session: the same two people, recorded but not saved.
    room = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    pids = [_join_guest(svc, room, n, i) for i, n in enumerate(["bea", "AVA"])]
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    for pid in pids:
        _ack(ws, room, pid, 0)
    new = ShareService(ws).create_record_room(land_first=True)
    assert len(new["landed_first"]["clips"]) == 2
    assert _tracks(ws) == tracks  # nobody got a second track
    assert sorted(_clips_by_track(ws).values()) == [2, 2]


def test_land_first_in_a_start_room_shifts_the_earlier_session(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _episode(ws)
    before = _clips(ws)
    room = ShareService(ws).create_record_room(target=START)
    svc, guest = _join_as(ws, room, "Sam")
    _take(ws, room, svc, guest, 0, 2.5, 880.0)
    assert _flags(ws) == (True, 1)
    new = ShareService(ws).create_record_room(land_first=True, target=START)
    [placed] = new["landed_first"]["clips"]
    assert placed["timeline_start"] == 0.0
    after = _clips(ws)
    for clip_id, start in before.items():
        assert after[clip_id] == pytest.approx(start + 2.5)
    assert HistoryService(ws).list_entries().groups[-1].title == "Added Session 2 at the start"


def _decided_room(ws, how: str):
    """An insert room whose first take became a suggestion that was then accepted or skipped."""
    _episode(ws)
    room = ShareService(ws).create_record_room(target=INSERT)
    svc, guest = _join_as(ws, room, "Sam")
    _take(ws, room, svc, guest, 0, 1.0, 880.0)
    assert _flags(ws) == (True, 1)
    RecordLandingService(ws).land()
    assert _flags(ws) == (False, 0)  # turned into a pending suggestion
    sid = _suggestion(ws, room["session_id"]).id
    getattr(SessionSuggestionService(ws), how)(sid)
    assert _flags(ws) == (False, 0)  # still nothing left to save
    return room, svc, guest


@pytest.mark.parametrize("how", ["accept", "skip"])
def test_a_take_recorded_after_the_decision_is_unsaved_and_land_first_refuses(
    minimal_project, sample_wav, tmp_workspace, how
):
    ws = _seed(minimal_project, sample_wav)
    room, svc, guest = _decided_room(ws, how)
    _take(ws, room, svc, guest, 1, 1.0, 660.0)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_take"], snap["unlanded_takes"]) == (True, 1)
    with pytest.raises(RecordLandingError, match="accepted or skipped"):
        ShareService(ws).create_record_room(land_first=True)
    assert lookup_share(room["guest"]["token"], kind="record")
    new = ShareService(ws).create_record_room()
    assert "cannot be saved" in new["warning"]
    assert _revoked(room["guest"]["token"])


def test_a_take_still_uploading_is_counted_and_land_first_asks_to_wait(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    old, [pid] = _room(ws, ["Ava"], land=True)
    svc = RecordSessionService(ws.project, session_id=old["session_id"])
    svc.submit(_cmd("Start"), now_wall_ms=20_000)
    svc.submit(_cmd("Stop"), now_wall_ms=23_000)
    pcm = bytes(48_000)
    RecordUploadService(ws.project).ingest_part(
        session_id=old["session_id"],
        take_index=1,
        participant_id=pid,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=sha256_hex(pcm),
        final=False,
    )
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_takes"], snap["unlanded_saving"]) == (1, 1)
    with pytest.raises(
        RecordLandingError, match=r"still saving\. Uploads can take up to 10 minutes"
    ):
        ShareService(ws).create_record_room(land_first=True)
    assert lookup_share(old["guest"]["token"], kind="record")
    new = ShareService(ws).create_record_room()
    assert "still saving" in new["warning"]


STOP_AT = 0  # set per test by ``_fresh_stop_time``: a take that stopped just now


@pytest.fixture(autouse=True)
def _fresh_stop_time():
    """Read the wall clock when each test starts, not when the module is imported.

    Under a long xdist run, collection can happen more than ``UPLOAD_GRACE_MS`` before a test
    runs, which would make every "just stopped" take read as stalled.
    """
    global STOP_AT
    STOP_AT = int(time.time() * 1000)
    yield


GRACE = preflight.UPLOAD_GRACE_MS


def _at(monkeypatch, wall_ms: int) -> None:
    monkeypatch.setattr(preflight, "_now_ms", lambda: wall_ms)


def _consented_before_start(svc, pids) -> None:
    for pid in pids:
        svc.submit(
            _cmd("Consent", pid=pid, role="guest", payload={"accepted": True}),
            now_wall_ms=STOP_AT - 3_100,
            capabilities=["join"],
        )


def _stopped_room(ws, names, *, pause: bool = False, resumes: int = 0):
    """A room whose take stopped at ``STOP_AT`` with no uploads at all (the gap right after Stop)."""
    room = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    pids = [_join_guest(svc, room, name, i) for i, name in enumerate(names)]
    _consented_before_start(svc, pids)
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=STOP_AT - 3_000)
    svc.submit(_cmd("Start"), now_wall_ms=STOP_AT - 3_000)
    for n in range(resumes):
        svc.submit(_cmd("Pause"), now_wall_ms=STOP_AT - 2_500 + n * 100)
        svc.submit(_cmd("Resume"), now_wall_ms=STOP_AT - 2_450 + n * 100)
    if pause:
        svc.submit(_cmd("Pause"), now_wall_ms=STOP_AT - 2_000)
    svc.submit(_cmd("Stop"), now_wall_ms=STOP_AT)
    return room, pids, svc


def _partial(ws, room, pid: str, take: int = 0) -> None:
    pcm = bytes(48_000)
    RecordUploadService(ws.project).ingest_part(
        session_id=room["session_id"],
        take_index=take,
        participant_id=pid,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=sha256_hex(pcm),
        final=False,
    )


def test_a_guest_who_has_not_started_uploading_is_saving_inside_the_grace_window(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, _, _ = _stopped_room(ws, ["Ava"])
    _at(monkeypatch, STOP_AT + 60_000)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_takes"], snap["unlanded_saving"], snap["unlanded_stalled"]) == (1, 1, 0)
    assert snap["land_first_possible"] is False
    with pytest.raises(
        RecordLandingError, match=r"still saving\. Uploads can take up to 10 minutes"
    ):
        ShareService(ws).create_record_room(land_first=True)
    assert lookup_share(old["guest"]["token"], kind="record")
    new = ShareService(ws).create_record_room()
    assert "still saving" in new["warning"] and "Start anyway" in new["warning"]


def test_a_guest_who_never_uploads_is_stalled_after_the_window_and_land_first_goes_ahead(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava, _bea], _ = _stopped_room(ws, ["Ava", "Bea"])
    _ack(ws, old, ava, 0)
    _at(monkeypatch, STOP_AT + 60_000)
    assert RecordControlService(ws).snapshot()["unlanded_saving"] == 1
    with pytest.raises(RecordLandingError, match="still saving"):
        ShareService(ws).create_record_room(land_first=True)
    ws.reload()
    assert not ws.project.clips  # refused before landing anything

    _at(monkeypatch, STOP_AT + GRACE + 1)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_takes"], snap["unlanded_saving"], snap["unlanded_stalled"]) == (1, 0, 1)
    assert snap["land_first_possible"] is True  # Ava's finished recording can be saved
    new = ShareService(ws).create_record_room(land_first=True)
    assert len(new["landed_first"]["clips"]) == 1
    assert new["left_behind"] == 1 and "left behind" in new["left_behind_message"]
    assert "never finished uploading" in new["warning"]
    assert new["land_first_possible"] is False  # nothing left a land could save
    assert _revoked(old["guest"]["token"])


def test_a_stalled_partial_upload_stops_blocking_and_is_reported(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava, bea], _ = _stopped_room(ws, ["Ava", "Bea"])
    _ack(ws, old, ava, 0)
    _partial(ws, old, bea)
    assert RecordControlService(ws).snapshot()["unlanded_saving"] == 1  # chunk just arrived
    _at(monkeypatch, int(time.time() * 1000) + GRACE + 1_000)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 1)
    new = ShareService(ws).create_record_room(land_first=True)
    assert len(new["landed_first"]["clips"]) == 1 and new["left_behind"] == 1


@pytest.mark.parametrize("future_part", [False, True], ids=["old-part", "future-part"])
def test_a_partial_upload_gets_the_full_grace_window_after_stop(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, future_part
):
    import os

    started = STOP_AT - 15 * 60 * 1_000
    wall = started - 1_000
    monkeypatch.setattr(time, "time_ns", lambda: wall * 1_000_000)
    monkeypatch.setattr(time, "time", lambda: wall / 1_000)
    ws = _seed(minimal_project, sample_wav)
    old = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=old["session_id"])
    ava = _join_guest(svc, old, "Ava", 0)
    svc.submit(_cmd("Join", payload={"display_name": "Host"}))
    wall = started
    svc.submit(_cmd("Start"))
    _partial(ws, old, ava)
    part = next(tmp_workspace.rglob("0.part"))
    part_ms = STOP_AT + 86_400_000 if future_part else started
    os.utime(part, (part_ms / 1_000, part_ms / 1_000))
    wall = STOP_AT
    svc.submit(_cmd("Stop"))

    for elapsed in (1_000, GRACE):
        _at(monkeypatch, STOP_AT + elapsed)
        snap = RecordControlService(ws).snapshot()
        assert (snap["unlanded_takes"], snap["unlanded_saving"], snap["unlanded_stalled"]) == (
            1,
            1,
            0,
        )
        assert snap["land_first_possible"] is False
        with pytest.raises(RecordLandingError, match="still saving"):
            ShareService(ws).create_record_room(land_first=True)
        assert lookup_share(old["guest"]["token"], kind="record")
        assert lookup_share(old["producer"]["token"], kind="record")
        assert RecordSessionService.active_session_id(ws.project) == old["session_id"]

    _at(monkeypatch, STOP_AT + GRACE + 1)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 1)


def test_a_later_partial_chunk_extends_saving_beyond_the_stop_grace_window(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import os

    wall = STOP_AT - 4_000
    monkeypatch.setattr(time, "time_ns", lambda: wall * 1_000_000)
    monkeypatch.setattr(time, "time", lambda: wall / 1_000)
    ws = _seed(minimal_project, sample_wav)
    old, [ava], _ = _stopped_room(ws, ["Ava"])
    wall = STOP_AT
    _partial(ws, old, ava)
    part = next(tmp_workspace.rglob("0.part"))
    os.utime(part, (wall / 1_000, wall / 1_000))
    wall = ((STOP_AT + GRACE // 2) // 1_000) * 1_000
    pcm = bytes(48_000)
    RecordUploadService(ws.project).ingest_part(
        session_id=old["session_id"],
        take_index=0,
        participant_id=ava,
        segment_index=0,
        part_seq=1,
        data=pcm,
        digest=sha256_hex(pcm),
        final=False,
    )
    part = next(tmp_workspace.rglob("1.part"))
    os.utime(part, (wall / 1_000, wall / 1_000))

    for now in (STOP_AT + GRACE + 1, wall + GRACE):
        _at(monkeypatch, now)
        snap = RecordControlService(ws).snapshot()
        assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (1, 0)
    _at(monkeypatch, wall + GRACE + 1)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 1)


def test_stalled_audio_only_means_nothing_to_land_and_the_mint_just_reports_it(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, _, _ = _stopped_room(ws, ["Ava"])
    _at(monkeypatch, STOP_AT + GRACE + 1)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_stalled"], snap["land_first_possible"]) == (1, False)
    new = ShareService(ws).create_record_room(land_first=True)
    assert "landed_first" not in new and new["left_behind"] == 1
    assert _revoked(old["guest"]["token"])


def test_a_removed_guest_with_an_unfinished_upload_is_reported_not_cleared(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava, bea], svc = _stopped_room(ws, ["Ava", "Bea"])
    _ack(ws, old, ava, 0)
    _partial(ws, old, bea)
    svc.submit(_cmd("RemoveParticipant", payload={"participant_id": bea}), now_wall_ms=STOP_AT + 1)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 1)  # cannot finish, now
    new = ShareService(ws).create_record_room(land_first=True)
    assert len(new["landed_first"]["clips"]) == 1 and new["left_behind"] == 1


def test_without_a_report_stop_while_paused_does_not_wait_for_a_segment_that_never_records(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava], _ = _stopped_room(ws, ["Ava"], pause=True)
    _ack(ws, old, ava, 0)
    RecordLandingService(ws).land()
    assert _flags(ws) == (False, 0)
    assert RecordControlService(ws).snapshot()["land_first_possible"] is False


def _ack_segment(ws, room, pid: str, segment: int) -> None:
    pcm = bytes(48_000)
    RecordUploadService(ws.project).ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=pid,
        segment_index=segment,
        part_seq=0,
        data=pcm,
        digest=sha256_hex(pcm),
        file_sha256=sha256_hex(pcm_wav_header(len(pcm)) + pcm),
        final=True,
        expected_parts=1,
    )


@pytest.mark.parametrize("resumes", [1, 2])
def test_without_a_report_a_resumed_take_waits_for_each_later_segment_then_reports_it_stalled(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, resumes
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava], _ = _stopped_room(ws, ["Ava"], resumes=resumes)
    for segment in range(resumes):  # the last segment never arrives
        _ack_segment(ws, old, ava, segment)
    _at(monkeypatch, STOP_AT + 60_000)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (1, 0)
    with pytest.raises(RecordLandingError, match="still saving"):
        ShareService(ws).create_record_room(land_first=True)
    _at(monkeypatch, STOP_AT + GRACE + 1)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 1)
    assert snap["land_first_possible"] is True
    new = ShareService(ws).create_record_room(land_first=True)
    assert len(new["landed_first"]["clips"]) == resumes
    assert new["left_behind"] == 1 and "1 recording never finished" in new["left_behind_message"]
    assert "was left behind" in new["left_behind_message"]


def test_without_a_report_a_resumed_take_with_every_segment_in_is_not_flagged(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava], _ = _stopped_room(ws, ["Ava"], resumes=2)
    for segment in range(3):
        _ack_segment(ws, old, ava, segment)
    RecordLandingService(ws).land()
    assert _flags(ws) == (False, 0)


def _report(svc, pid: str, segments: int, *, take: int = 0) -> None:
    host = pid == "p_host"
    svc.submit(
        _cmd(
            "SegmentReport",
            pid=pid,
            role="host" if host else "guest",
            payload={"take_index": take, "segments": segments},
        ),
        capabilities=None if host else ["join"],
    )


def _stalled_after_grace(ws, monkeypatch) -> dict:
    _at(monkeypatch, STOP_AT + GRACE + 1)
    return RecordControlService(ws).snapshot()


def test_a_reported_segment_that_never_uploaded_is_saving_then_stalled_after_a_consent_flip(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava], svc = _stopped_room(ws, ["Ava"])
    _ack_segment(ws, old, ava, 0)
    _report(svc, ava, 2)
    _at(monkeypatch, STOP_AT + 60_000)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (1, 0)
    with pytest.raises(RecordLandingError, match="still saving"):
        ShareService(ws).create_record_room(land_first=True)
    snap = _stalled_after_grace(ws, monkeypatch)
    assert (snap["unlanded_takes"], snap["unlanded_saving"], snap["unlanded_stalled"]) == (1, 0, 1)
    new = ShareService(ws).create_record_room(land_first=True)
    assert len(new["landed_first"]["clips"]) == 1
    assert new["left_behind"] == 1 and "left behind" in new["left_behind_message"]


def test_a_report_below_the_rows_never_shrinks_what_is_owed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava], svc = _stopped_room(ws, ["Ava"])
    _ack_segment(ws, old, ava, 0)
    _ack_segment(ws, old, ava, 2)
    _report(svc, ava, 1)
    snap = _stalled_after_grace(ws, monkeypatch)
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 1)


def test_a_report_above_the_rows_counts_each_missing_index(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava], svc = _stopped_room(ws, ["Ava"])
    _ack_segment(ws, old, ava, 1)
    _report(svc, ava, 4)
    snap = _stalled_after_grace(ws, monkeypatch)
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 3)


def test_a_final_report_of_zero_owes_nothing(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava, bea], svc = _stopped_room(ws, ["Ava", "Bea"], resumes=1)
    _ack_segment(ws, old, ava, 0)
    _ack_segment(ws, old, ava, 1)
    _report(svc, bea, 0)
    snap = _stalled_after_grace(ws, monkeypatch)
    assert (snap["unlanded_takes"], snap["unlanded_saving"], snap["unlanded_stalled"]) == (1, 0, 0)
    assert snap["land_first_possible"] is True


def test_a_removed_guest_with_a_report_is_still_skipped(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava, bea], svc = _stopped_room(ws, ["Ava", "Bea"])
    _ack_segment(ws, old, ava, 0)
    _report(svc, bea, 2)
    svc.submit(_cmd("RemoveParticipant", payload={"participant_id": bea}), now_wall_ms=STOP_AT + 1)
    snap = _stalled_after_grace(ws, monkeypatch)
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 0)


def test_the_host_owes_the_segments_it_reports(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava], svc = _stopped_room(ws, ["Ava"], resumes=1)
    _ack_segment(ws, old, ava, 0)
    _ack_segment(ws, old, ava, 1)
    _ack_segment(ws, old, "p_host", 0)
    _report(svc, "p_host", 2)
    snap = _stalled_after_grace(ws, monkeypatch)
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 1)
    new = ShareService(ws).create_record_room(land_first=True)
    assert new["left_behind"] == 1


def test_a_host_who_never_reported_stays_silent(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava], _ = _stopped_room(ws, ["Ava"], resumes=1)
    _ack_segment(ws, old, ava, 0)
    _ack_segment(ws, old, ava, 1)
    snap = _stalled_after_grace(ws, monkeypatch)
    assert (snap["unlanded_takes"], snap["unlanded_saving"], snap["unlanded_stalled"]) == (1, 0, 0)


@pytest.mark.parametrize("reported", [None, 1], ids=["no-report", "reported"])
def test_a_guest_who_consented_after_the_resume_owes_only_what_they_recorded(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, reported
):
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    ava = _join_guest(svc, room, "Ava", 0)
    _consented_before_start(svc, [ava])
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=STOP_AT - 3_000)
    svc.submit(_cmd("Start"), now_wall_ms=STOP_AT - 3_000)
    svc.submit(_cmd("Pause"), now_wall_ms=STOP_AT - 2_500)
    svc.submit(_cmd("Resume"), now_wall_ms=STOP_AT - 2_450)
    bea = _join_guest(svc, room, "Bea", 1)
    svc.submit(_cmd("Stop"), now_wall_ms=STOP_AT + 1_000)
    _ack_segment(ws, room, ava, 0)
    _ack_segment(ws, room, ava, 1)
    _ack_segment(ws, room, bea, 0)
    if reported is not None:
        _report(svc, bea, reported)
    _at(monkeypatch, STOP_AT + 1_000 + GRACE + 1)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_takes"], snap["unlanded_saving"], snap["unlanded_stalled"]) == (1, 0, 0)
    assert ShareService(ws).create_record_room(land_first=True)["landed_first"]


def test_a_room_with_only_stalled_recordings_is_not_closed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    _old, svc, _guest = _decided_room(ws, "accept")
    svc.submit(_cmd("Start"), now_wall_ms=STOP_AT - 3_000)
    svc.submit(_cmd("Stop"), now_wall_ms=STOP_AT)
    _at(monkeypatch, STOP_AT + GRACE + 1)
    unsaved = unsaved_takes(ws.project, now_wall_ms=STOP_AT + GRACE + 1)
    assert (unsaved.stalled, unsaved.landable, unsaved.saving) == (1, 0, 0)
    assert unsaved.closed is False


def test_a_report_matching_every_acked_row_neither_blocks_nor_warns(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava], svc = _stopped_room(ws, ["Ava"])
    _ack_segment(ws, old, ava, 0)
    _report(svc, ava, 1)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 0)
    assert snap["land_first_possible"] is True
    snap = _stalled_after_grace(ws, monkeypatch)
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 0)
    new = ShareService(ws).create_record_room(land_first=True)
    assert len(new["landed_first"]["clips"]) == 1 and "left_behind" not in new


def test_a_count_above_the_cap_still_owes_the_trailing_segment(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    old, [ava], svc = _stopped_room(ws, ["Ava"])
    _ack_segment(ws, old, ava, 0)
    _report(svc, ava, 10**6)
    snap = _stalled_after_grace(ws, monkeypatch)
    assert snap["unlanded_stalled"] == MAX_REPORTED_SEGMENTS - 1


def test_a_part_that_disappears_between_listing_and_stat_does_not_stall_a_live_upload(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from pathlib import Path

    ws = _seed(minimal_project, sample_wav)
    old, [ava], _ = _stopped_room(ws, ["Ava"])
    _partial(ws, old, ava)
    _partial_more = RecordUploadService(ws.project)
    pcm = bytes(48_000)
    _partial_more.ingest_part(
        session_id=old["session_id"],
        take_index=0,
        participant_id=ava,
        segment_index=0,
        part_seq=1,
        data=pcm,
        digest=sha256_hex(pcm),
        final=False,
    )
    real_stat = Path.stat
    gone: list[Path] = []

    def flaky(self, *a, **k):
        if self.suffix == ".part" and self.stem == "0" and not gone:
            gone.append(self)
            raise FileNotFoundError(self)
        return real_stat(self, *a, **k)

    monkeypatch.setattr(Path, "stat", flaky)
    last = _partial_more.segment_last_activity_ms(old["session_id"], 0, ava, 0)
    assert gone and last is not None  # the other part still counts


def test_a_future_part_time_cannot_keep_an_upload_saving(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import os

    ws = _seed(minimal_project, sample_wav)
    old, [ava], _ = _stopped_room(ws, ["Ava"])
    _partial(ws, old, ava)
    part = next((tmp_workspace / "artifacts").rglob("0.part"), None) or next(
        tmp_workspace.rglob("0.part")
    )
    future = time.time() + 86_400
    os.utime(part, (future, future))
    _at(monkeypatch, STOP_AT + GRACE + 1)
    snap = RecordControlService(ws).snapshot()
    assert (snap["unlanded_saving"], snap["unlanded_stalled"]) == (0, 1)
    # A stop time in the future is not trusted either.
    assert preflight._quiet_ms(1_000, 1_000 + preflight.CLOCK_SKEW_MS + 1) is None
    assert preflight._quiet_ms(1_000, 5_000_000, 400) == 600


def test_land_first_possible_values(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    ShareService(ws).create_record_room()
    assert RecordControlService(ws).snapshot()["land_first_possible"] is False  # nothing to save
    _room(ws, ["Ava"])
    assert RecordControlService(ws).snapshot()["land_first_possible"] is True
    RecordLandingService(ws).land()
    assert RecordControlService(ws).snapshot()["land_first_possible"] is False


def test_bad_target_or_expiry_fails_before_land_first_lands_anything(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    old, _ = _room(ws, ["Ava"])
    for bad in ({"target": "bogus"}, {"expires_at": "not-a-date"}):
        with pytest.raises(ValueError):
            ShareService(ws).create_record_room(land_first=True, **bad)
        ws.reload()
        assert not ws.project.clips
        assert _flags(ws) == (True, 1)
        assert lookup_share(old["guest"]["token"], kind="record")


def test_land_first_refuses_when_the_land_leaves_a_take_unsaved(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    old, [pid] = _room(ws, ["Ava"])
    RecordUploadService(ws.project).acked_wav(old["session_id"], 0, pid, 0).unlink()
    with pytest.raises(RecordLandingError, match="could not be saved"):
        ShareService(ws).create_record_room(land_first=True)
    assert lookup_share(old["guest"]["token"], kind="record")
    assert RecordSessionService.active_session_id(ws.project) == old["session_id"]
    assert ShareService(ws).create_record_room()["unlanded_take"] is True  # start anyway


def test_cli_and_mcp_carry_the_warning_and_land_first(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"])
    runner = CliRunner()
    base = ["review", "share", "--kind", "record", "--project", str(minimal_project)]
    res = runner.invoke(cli_app, base)
    assert res.exit_code == 0, res.output
    assert "Warning: 1 stopped take in this room is not saved" in res.output
    assert "Add --land-first" in res.output
    _stopped_room(ws, ["Ava"])
    _at(monkeypatch, STOP_AT + 1_000)  # the CLI reads the same injected clock
    res = runner.invoke(cli_app, base)
    assert "still saving" in res.output and "Add --land-first" not in res.output
    _room(ws, ["Ava"])

    _room(ws, ["Bea"])
    out = json.loads(create_record_room_tool(str(minimal_project)))
    assert out["unlanded_take"] is True and "warning" in out

    _room(ws, ["Cy"])
    res = runner.invoke(cli_app, [*base, "--land-first"])
    assert res.exit_code == 0, res.output
    assert "Warning" not in res.output
    assert "landed_first" in res.output
    ws.reload()
    assert len(ws.project.clips) == 1

    _room(ws, ["Di"])
    out = json.loads(create_record_room_tool(str(minimal_project), land_first=True))
    assert out["unlanded_takes"] == 0 and out["landed_first"]["clips"]

    bad = runner.invoke(
        cli_app, ["review", "share", "--project", str(minimal_project), "--land-first"]
    )
    assert bad.exit_code == 2


def test_host_routes_report_and_land_first(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    ws = _seed(minimal_project, sample_wav)
    old, _ = _room(ws, ["Ava"])
    client = TestClient(create_app())
    path = str(ws.path)
    state = client.get("/api/record/state", params={"path": path}).json()
    assert (state["unlanded_take"], state["unlanded_takes"]) == (True, 1)

    res = client.post("/api/shares/record", json={"path": path, "land_first": True})
    assert res.status_code == 200, res.text
    room = res.json()["room"]
    assert room["unlanded_takes"] == 0 and room["landed_first"]["clips"]
    assert _revoked(old["guest"]["token"])
    state = client.get("/api/record/state", params={"path": path}).json()
    assert state["unlanded_take"] is False


def test_route_land_first_refusal_is_a_coded_400(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    ws = _seed(minimal_project, sample_wav)
    old, [pid] = _room(ws, ["Ava"])
    RecordUploadService(ws.project).acked_wav(old["session_id"], 0, pid, 0).unlink()
    res = TestClient(create_app()).post(
        "/api/shares/record", json={"path": str(ws.path), "land_first": True}
    )
    assert res.status_code == 400, res.text
    assert res.headers["X-Sharecut-Error-Code"] == "record_land_refused"
    assert "could not be saved" in res.text
    assert lookup_share(old["guest"]["token"], kind="record")
