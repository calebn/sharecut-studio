"""Minting a room while a stopped take is not saved: report it, and land first on request (#2336)."""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.mcp.tools.record import record_state_tool
from podcast_mcp.mcp.tools.review import create_record_room_tool
from podcast_mcp.services.collaboration.share import ShareService, lookup_share
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.record import (
    RecordControlService,
    RecordLandingError,
    RecordSessionService,
    RecordStateError,
)
from podcast_mcp.services.record.landing import RecordLandingService
from podcast_mcp.services.record.preflight import unlanded_takes
from test_record_returning_people import _ack, _clips_by_track, _join_guest, _room, _tracks
from test_record_staging import _cmd, _seed
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
    assert unlanded_takes(ws.project) == 1
    state = json.loads(record_state_tool(str(minimal_project)))
    assert (state["unlanded_take"], state["unlanded_takes"]) == (True, 1)

    new = ShareService(ws).create_record_room()
    assert (new["unlanded_take"], new["unlanded_takes"]) == (True, 1)
    assert "1 stopped take is not saved" in new["warning"]
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


def test_a_staged_session_already_decided_has_nothing_left_to_save(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _episode(ws)
    room = ShareService(ws).create_record_room(target=INSERT)
    svc, guest = _join_as(ws, room, "Sam")
    _take(ws, room, svc, guest, 0, 1.0, 880.0)
    assert _flags(ws) == (True, 1)
    RecordLandingService(ws).land()
    assert _flags(ws) == (False, 0)  # landed as a pending suggestion


def test_cli_and_mcp_carry_the_warning_and_land_first(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"])
    runner = CliRunner()
    base = ["review", "share", "--kind", "record", "--project", str(minimal_project)]
    res = runner.invoke(cli_app, base)
    assert res.exit_code == 0, res.output
    assert "Warning: 1 stopped take is not saved" in res.output

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
