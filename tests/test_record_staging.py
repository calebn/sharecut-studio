"""Insert and replace sessions stage their takes as suggestions and leave the timeline alone."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.mcp.tools.review import list_session_suggestions_tool, skip_session_suggestion_tool
from podcast_mcp.models import EpisodeProject, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document import HistoryService, SessionSuggestionService
from podcast_mcp.services.record.commands import RecordCommand
from podcast_mcp.services.record.landing import RecordLandingService
from podcast_mcp.services.record.landing_math import (
    record_session_number,
    session_take_offsets_s,
    staged_span_s,
)
from podcast_mcp.services.record.service import (
    RecordSessionService,
    apply_record_ws_message,
    next_record_client_seq,
    reset_record_runtime_for_tests,
)
from podcast_mcp.services.record.state import InsertTarget, ReplaceTarget, TakeState
from podcast_mcp.services.record.upload import RecordUploadService, sha256_hex
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.wav import pcm_wav_header

CAPS = ["join", "monitor", "comment"]


def _seed(minimal_project, sample_wav):
    reset_record_runtime_for_tests()
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _cmd(ctype: str, *, pid: str = "p_host", role: str = "host", payload: dict | None = None):
    return RecordCommand.parse(
        command_type=ctype,
        payload=payload or {},
        client_id=f"c-{pid}",
        role=role,  # type: ignore[arg-type]
        participant_id=pid,
        client_seq=next_record_client_seq(),
    )


def _join(ws, room):
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        client_id="rec-guest",
        connection_id="c1",
        capabilities=CAPS,
        client_seq=1,
    )
    apply_record_ws_message(
        svc,
        {
            "type": "Record",
            "command_type": "Consent",
            "payload": {"accepted": True},
            "client_seq": 2,
        },
        client_id="rec-guest",
        role="guest",
        participant_id=echo["participant_id"],
        seq=2,
        capabilities=CAPS,
        connection_id="c1",
    )
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    return svc, echo["participant_id"]


def _ack(ws, room, guest: str, take: int, *, seconds: float = 0.5) -> None:
    pcm = bytes(int(48_000 * 2 * seconds))
    wav = pcm_wav_header(len(pcm)) + pcm
    RecordUploadService(ws.project).ingest_part(
        session_id=room["session_id"],
        take_index=take,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=sha256_hex(pcm),
        file_sha256=sha256_hex(wav),
        final=True,
        expected_parts=1,
        join_offset_ms=0,
    )


def _record(ws, room, svc, guest: str, takes: int, *, comment_in_take: int | None = None) -> None:
    clock = 0
    for take in range(takes):
        svc.submit(_cmd("Start"), now_wall_ms=clock)
        if take == comment_in_take:
            svc.submit(
                _cmd(
                    "Comment",
                    pid=guest,
                    role="guest",
                    payload={
                        "id": "live-note",
                        "take_index": 99,
                        "recording_ms": 99,
                        "pressed_wall_ms": clock + 1_500,
                        "body": "Fix this",
                    },
                ),
                now_wall_ms=clock + 1_500,
                capabilities=CAPS,
            )
        svc.submit(_cmd("Stop"), now_wall_ms=clock + 3_000)
        _ack(ws, room, guest, take)
        clock += 10_000


def _land_end_session(ws):
    room = ShareService(ws).create_record_room()
    svc, guest = _join(ws, room)
    _record(ws, room, svc, guest, 1)
    RecordLandingService(ws).land(align=lambda _p: None)
    return room


def _stage(ws, target, *, takes: int = 1, comment_in_take: int | None = None, land: bool = True):
    room = ShareService(ws).create_record_room(target=target)
    svc, guest = _join(ws, room)
    _record(ws, room, svc, guest, takes, comment_in_take=comment_in_take)
    landed = RecordLandingService(ws).land(align=lambda _p: None) if land else None
    return room, guest, svc, landed


def _timeline(ws) -> str:
    project = ws.project
    return json.dumps(
        {
            "clips": [c.model_dump() for c in project.clips],
            "tracks": [t.model_dump() for t in project.tracks],
            "comments": [c.model_dump() for c in project.comments],
            "chapters": [c.model_dump() for c in project.editorial.chapters],
            "edit_decisions": [e.model_dump() for e in project.editorial.edit_decisions],
        },
        sort_keys=True,
        default=str,
    )


def _suggestion(ws, session_id: str):
    ws.reload()
    return next(s for s in ws.project.editorial.session_suggestions if s.session_id == session_id)


INSERT = {"kind": "insert", "at_sec": 1.0}
REPLACE = {"kind": "replace", "from_sec": 0.5, "to_sec": 2.0, "track_ids": ["ava"]}


def test_staging_an_insert_registers_sources_and_leaves_the_timeline_alone(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _land_end_session(ws)
    before = _timeline(ws)
    sources_before = {s.id for s in ws.project.sources}

    room, guest, _svc, landed = _stage(ws, INSERT, comment_in_take=0)

    assert landed["clips"] == []
    assert [item["take_index"] for item in landed["staged"]] == [0]
    ws.reload()
    assert _timeline(ws) == before
    new_sources = {s.id for s in ws.project.sources} - sources_before
    assert new_sources == {f"rec-{room['session_id']}-0-{guest}-0"}
    row = _suggestion(ws, room["session_id"])
    assert (row.kind, row.status, row.session_number, row.at_sec) == ("insert", "pending", 2, 1.0)
    [take] = row.takes
    assert take.source_id in new_sources
    assert take.track_id == guest
    assert take.offset_s == 0.0
    assert [(c.id, c.body, c.author) for c in take.comments] == [("live-note", "Fix this", guest)]
    assert ws.project.comments == []
    assert [(r.number, r.target_kind) for r in ws.project.editorial.record_sessions] == [
        (1, "end"),
        (2, "insert"),
    ]
    titles = [g.title for g in HistoryService(ws).list_entries().groups]
    assert titles[-1] == "Staged Session 2"


def test_staged_comments_are_not_marked_landed_and_hold_once(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    room, _guest, _svc, _landed = _stage(ws, INSERT, comment_in_take=0)
    from podcast_mcp.services.record.live_comments import live_comment_store_for

    store = live_comment_store_for(ws.project)
    assert [row["comment_id"] for row in store.list_unlanded(room["session_id"])] == ["live-note"]
    RecordLandingService(ws).land(align=lambda _p: None)
    [take] = _suggestion(ws, room["session_id"]).takes
    assert len(take.comments) == 1


def test_insert_takes_concatenate_without_a_gap(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    room, _guest, _svc, landed = _stage(ws, INSERT, takes=2)
    assert [item["offset_s"] for item in landed["staged"]] == pytest.approx([0.0, 3.0])
    row = _suggestion(ws, room["session_id"])
    assert [t.take_index for t in row.takes] == [0, 1]
    assert staged_span_s((t.offset_s, t.duration_s) for t in row.takes) == pytest.approx(3.5)


def test_replace_takes_are_alternatives_at_the_range_start(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _land_end_session(ws)
    before = _timeline(ws)
    room, _guest, _svc, landed = _stage(ws, REPLACE, takes=2)
    assert [item["offset_s"] for item in landed["staged"]] == [0.0, 0.0]
    ws.reload()
    assert _timeline(ws) == before
    row = _suggestion(ws, room["session_id"])
    assert (row.kind, row.from_sec, row.to_sec, row.track_ids) == ("replace", 0.5, 2.0, ["ava"])
    assert [(t.take_index, t.offset_s) for t in row.takes] == [(0, 0.0), (1, 0.0)]


def test_live_clock_places_insert_and_replace_takes_like_landing() -> None:
    def take(index: int, start: int, stop: int) -> TakeState:
        return TakeState(
            take_index=index,
            session_start_wall_ms=start,
            session_start_iso="t",
            stopped_wall_ms=stop,
            consented_participant_ids=[],
        )

    takes = [take(0, 0, 3_000), take(1, 10_000, 14_000)]
    insert = session_take_offsets_s(takes, [], "a" * 12, InsertTarget(at_sec=12.0))
    assert insert == {0: 12.0, 1: 15.0}
    replace = ReplaceTarget(from_sec=12.0, to_sec=20.0, track_ids=["ava"])
    assert session_take_offsets_s(takes, [], "a" * 12, replace) == {0: 12.0, 1: 12.0}


def test_room_snapshot_shows_the_replace_overlay_at_the_range_start(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room(target=REPLACE)
    svc, guest = _join(ws, room)
    _record(ws, room, svc, guest, 1)
    svc.submit(_cmd("Start"), now_wall_ms=20_000)
    assert svc.snapshot()["timeline_start_sec"] == 0.5


def test_landing_again_is_idempotent(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    room, _guest, _svc, _landed = _stage(ws, INSERT, takes=2)
    first = _suggestion(ws, room["session_id"]).model_dump()
    again = RecordLandingService(ws).land(align=lambda _p: None)
    assert again["staged"] == []
    assert _suggestion(ws, room["session_id"]).model_dump() == first
    assert len(ws.project.editorial.session_suggestions) == 1


def test_undoing_the_staging_land_restores_the_project_and_relands(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    first_room = _land_end_session(ws)
    before = ws.project.model_dump(mode="json", exclude={"history"})
    room, _guest, _svc, _landed = _stage(ws, INSERT, comment_in_take=0)
    assert _suggestion(ws, room["session_id"]).takes

    HistoryService(ws).undo()
    ws.reload()
    assert ws.project.model_dump(mode="json", exclude={"history"}) == before
    assert [r.session_id for r in ws.project.editorial.record_sessions] == [
        first_room["session_id"]
    ]

    relanded = RecordLandingService(ws).land(align=lambda _p: None)
    assert [item["take_index"] for item in relanded["staged"]] == [0]
    row = _suggestion(ws, room["session_id"])
    assert [t.take_index for t in row.takes] == [0]
    assert [c.id for c in row.takes[0].comments] == ["live-note"]
    assert row.session_number == 2


def test_discarding_a_staged_take_drops_its_entry_and_the_empty_suggestion(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    room, _guest, _svc, _landed = _stage(ws, INSERT, takes=2)
    RecordLandingService(ws).delete_take(0)
    row = _suggestion(ws, room["session_id"])
    assert [t.take_index for t in row.takes] == [1]
    RecordLandingService(ws).delete_take(1)
    ws.reload()
    assert ws.project.editorial.session_suggestions == []
    assert not [s for s in ws.project.sources if s.id.startswith(f"rec-{room['session_id']}-")]


def test_skip_is_one_undo_step_and_refuses_a_suggestion_that_is_not_pending(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    sid = _suggestion(ws, room["session_id"]).id
    service = SessionSuggestionService(ws)
    assert [r["id"] for r in service.list(status="pending")] == [sid]
    skipped = service.skip(sid)
    assert skipped["status"] == "skipped"
    assert service.list(status="pending") == []
    assert [r["id"] for r in service.list(status="skipped")] == [sid]
    assert HistoryService(ws).list_entries().groups[-1].title == "Skipped Session 1"
    with pytest.raises(CodedValueError, match="is skipped, not pending") as raised:
        service.skip(sid)
    assert raised.value.code == "session_suggestion_not_pending"
    with pytest.raises(KeyError):
        service.skip("ss-missing")
    with pytest.raises(CodedValueError):
        service.list(status="done")

    HistoryService(ws).undo()
    ws.reload()
    assert _suggestion(ws, room["session_id"]).status == "pending"
    assert [t.take_index for t in _suggestion(ws, room["session_id"]).takes] == [0]


def test_cli_and_mcp_list_and_skip(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    room, _guest, _svc, _landed = _stage(ws, REPLACE)
    sid = f"ss-{room['session_id']}"
    runner = CliRunner()
    listed = runner.invoke(
        cli_app,
        ["review", "session-suggestions", "--project", str(minimal_project), "--status", "pending"],
    )
    assert listed.exit_code == 0, listed.output
    assert [row["id"] for row in json.loads(listed.output)] == [sid]
    assert [
        row["id"] for row in json.loads(list_session_suggestions_tool(str(minimal_project)))
    ] == [sid]
    bad = runner.invoke(
        cli_app,
        ["review", "session-suggestions", "--project", str(minimal_project), "--status", "x"],
    )
    assert bad.exit_code == 1
    done = runner.invoke(
        cli_app,
        ["review", "skip-session-suggestion", "--project", str(minimal_project), "--id", sid],
    )
    assert done.exit_code == 0, done.output
    assert json.loads(done.output)["status"] == "skipped"
    again = runner.invoke(
        cli_app,
        ["review", "skip-session-suggestion", "--project", str(minimal_project), "--id", sid],
    )
    assert again.exit_code == 1
    assert "not pending" in again.output
    with pytest.raises(CodedValueError):
        skip_session_suggestion_tool(str(minimal_project), sid)


def test_a_project_without_the_field_loads_and_a_save_keeps_it(
    minimal_project, sample_wav, tmp_workspace
):
    raw = load_project(minimal_project).model_dump(mode="json", by_alias=True)
    del raw["editorial"]["session_suggestions"]
    assert EpisodeProject.model_validate(raw).editorial.session_suggestions == []

    ws = _seed(minimal_project, sample_wav)
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    project = load_project(minimal_project)
    save_project(project, minimal_project)
    kept = load_project(minimal_project)
    assert [s.session_id for s in kept.editorial.session_suggestions] == [room["session_id"]]
    assert kept.editorial.session_suggestions[0].takes


def test_a_staged_session_among_legacy_sessions_keeps_its_number(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _land_end_session(ws)
    ws.mutate(
        "drop number",
        "dropped number",
        lambda p: p.editorial.record_sessions.clear(),
    )
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    ws.reload()
    assert _suggestion(ws, room["session_id"]).session_number == 2
    assert record_session_number(ws.project, room["session_id"]) == 2
    RecordLandingService(ws).land(align=lambda _p: None)
    assert record_session_number(ws.project, room["session_id"]) == 2


def test_set_target_stays_locked_after_a_staged_take(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.services.record.control import RecordControlService
    from podcast_mcp.services.record.reducer import RecordStateError

    ws = _seed(minimal_project, sample_wav)
    _stage(ws, INSERT)
    with pytest.raises(RecordStateError, match="locked once a take has been recorded"):
        RecordControlService(ws).set_target(
            {"kind": "replace", "from_sec": 1, "to_sec": 2, "track_ids": ["ava"]}
        )
