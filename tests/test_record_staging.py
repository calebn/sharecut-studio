"""Insert and replace sessions stage their takes as suggestions and leave the timeline alone."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.comments import add_comment
from podcast_mcp.edits.ripple import ripple_remove_clips, ripple_track_ids
from podcast_mcp.edits.session_suggestions import staged_span_s
from podcast_mcp.mcp.tools.review import (
    accept_session_suggestion_tool,
    list_session_suggestions_tool,
    skip_session_suggestion_tool,
)
from podcast_mcp.models import (
    ChapterMarker,
    Clip,
    EpisodeProject,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document import HistoryService, SessionSuggestionService, TimelineService
from podcast_mcp.services.record.commands import RecordCommand
from podcast_mcp.services.record.landing import (
    InsertAnchorTakenError,
    RecordLandingService,
    SessionSuggestionClosedError,
    TakeAlreadyPlacedError,
)
from podcast_mcp.services.record.landing_math import record_session_number, session_take_offsets_s
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


def _ack(ws, room, guest: str, take: int, *, seconds: float = 0.5, join_offset_ms: int = 0) -> None:
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
        join_offset_ms=join_offset_ms,
    )


def _record(
    ws,
    room,
    svc,
    guest: str,
    takes: int,
    *,
    comment_in_take: int | None = None,
    join_offset_ms: int = 0,
) -> None:
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
        _ack(ws, room, guest, take, join_offset_ms=join_offset_ms)
        clock += 10_000


def _land_end_session(ws):
    room = ShareService(ws).create_record_room()
    svc, guest = _join(ws, room)
    _record(ws, room, svc, guest, 1)
    RecordLandingService(ws).land(align=lambda _p: None)
    return room


def _stage(
    ws,
    target,
    *,
    takes: int = 1,
    comment_in_take: int | None = None,
    join_offset_ms: int = 0,
    land: bool = True,
):
    room = ShareService(ws).create_record_room(target=target)
    svc, guest = _join(ws, room)
    _record(
        ws,
        room,
        svc,
        guest,
        takes,
        comment_in_take=comment_in_take,
        join_offset_ms=join_offset_ms,
    )
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
    first_track = next(t.id for t in ws.project.tracks if t.label == "Ava")

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
    assert take.track_id == first_track != guest  # Ava returns: matched to her Session 1 track
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
    _seed_replaceable(ws)
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
    _seed_replaceable(ws)
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
    with pytest.raises(CodedValueError, match="was already skipped") as raised:
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
    _seed_replaceable(ws)
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
    assert "was already" in again.output
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


def _room_tone_bed(ws, room, guest: str) -> None:
    pcm = bytes(48_000 * 2)
    wav = pcm_wav_header(len(pcm)) + pcm
    RecordUploadService(ws.project).ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=sha256_hex(pcm),
        file_sha256=sha256_hex(wav),
        final=True,
        kind="room_tone",
    )


@pytest.mark.parametrize("target", [INSERT, REPLACE], ids=["insert", "replace"])
def test_a_staged_room_tone_bed_stays_off_the_timeline_and_is_held_on_the_suggestion(
    minimal_project, sample_wav, tmp_workspace, target
):
    from podcast_mcp.engines.room_tone import room_tone_source_id
    from podcast_mcp.engines.track_ids import slug_track_id

    ws = _seed(minimal_project, sample_wav)
    _land_end_session(ws)
    _seed_replaceable(ws)
    before = _timeline(ws)
    room = ShareService(ws).create_record_room(target=target)
    svc, guest = _join(ws, room)
    _room_tone_bed(ws, room, guest)
    assert RecordLandingService(ws).land(align=lambda _p: None)["staged"] == []
    ws.reload()
    assert _timeline(ws) == before
    assert ws.project.editorial.session_suggestions == []
    _record(ws, room, svc, guest, 1)
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    assert _timeline(ws) == before
    track_id = slug_track_id(guest)
    row = _suggestion(ws, room["session_id"])
    [bed] = row.room_tone
    assert (bed.track_id, bed.track_label) == (track_id, "Ava")
    assert bed.source_id == room_tone_source_id(track_id)
    assert bed.path == f"raw/room-tone/{room['session_id']}/{guest}.wav"
    assert bed.duration_s == pytest.approx(1.0)
    assert (Path(ws.project.workspace_dir) / bed.path).is_file()
    assert ws.project.source_by_id(bed.source_id) is None
    first = row.model_dump()
    again = RecordLandingService(ws).land(align=lambda _p: None)
    assert again["staged"] == []
    ws.reload()
    assert _timeline(ws) == before
    assert _suggestion(ws, room["session_id"]).model_dump() == first
    RecordLandingService(ws).delete_take(0)
    ws.reload()
    assert ws.project.editorial.session_suggestions == []
    assert _timeline(ws) == before


@pytest.mark.parametrize("at_sec", [1.0004, 12.3454, 0.30000000000000004])
def test_insert_with_a_sub_millisecond_anchor_stages_with_exact_offsets(
    minimal_project, sample_wav, tmp_workspace, at_sec
):
    ws = _seed(minimal_project, sample_wav)
    room, _guest, _svc, _landed = _stage(ws, {"kind": "insert", "at_sec": at_sec}, takes=2)
    row = _suggestion(ws, room["session_id"])
    assert [t.take_index for t in row.takes] == [0, 1]
    assert row.takes[0].offset_s == 0.0
    assert row.takes[1].offset_s == pytest.approx(3.0)
    assert all(t.offset_s >= 0 for t in row.takes)
    assert row.takes[0].offset_s + row.takes[0].duration_s <= row.takes[1].offset_s + 1e-9


@pytest.mark.parametrize("from_sec", [0.5004, 0.30000000000000004])
def test_replace_with_a_sub_millisecond_anchor_stages_alternatives_at_zero(
    minimal_project, sample_wav, tmp_workspace, from_sec
):
    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws)
    target = {"kind": "replace", "from_sec": from_sec, "to_sec": 2.0, "track_ids": ["ava"]}
    room, _guest, _svc, _landed = _stage(ws, target, takes=2)
    row = _suggestion(ws, room["session_id"])
    assert [(t.take_index, t.offset_s) for t in row.takes] == [(0, 0.0), (1, 0.0)]


@pytest.mark.parametrize(
    ("target", "field"),
    [
        ({"kind": "insert", "at_sec": 1e308}, "at_sec"),
        ({"kind": "insert", "at_sec": -1}, "at_sec"),
        ({"kind": "insert"}, "at_sec"),
        ({"kind": "replace", "from_sec": 1e9, "to_sec": 1e9 + 1, "track_ids": ["a"]}, "from_sec"),
        ({"kind": "replace", "from_sec": 1, "to_sec": float("nan"), "track_ids": ["a"]}, "to_sec"),
        ({"kind": "replace", "from_sec": 1, "to_sec": 2, "track_ids": [5]}, "track_ids"),
    ],
)
def test_invalid_target_times_name_the_field(target, field):
    from podcast_mcp.services.record.state import parse_session_target

    with pytest.raises(CodedValueError) as err:
        parse_session_target(target)
    assert field in str(err.value)
    assert err.value.code == "invalid_record_request"


def test_error_codes_for_unknown_id_and_bad_status(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    service = SessionSuggestionService(ws)
    with pytest.raises(KeyError) as missing:
        service.skip("ss-missing")
    assert missing.value.code == "session_suggestion_not_found"
    with pytest.raises(CodedValueError) as bad:
        service.list(status="done")
    assert bad.value.code == "invalid_status"


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_target_times_are_refused(bad):
    from podcast_mcp.services.record.state import parse_session_target

    with pytest.raises(CodedValueError) as err:
        parse_session_target({"kind": "insert", "at_sec": bad})
    assert err.value.code == "invalid_record_request"
    assert "at_sec" in str(err.value)


def _seed_timeline(ws) -> None:
    def build(project: EpisodeProject) -> None:
        project.tracks.extend(
            [
                Track(id="host", label="Host", role=TrackRole.DIALOGUE),
                Track(id="co", label="Co", role=TrackRole.DIALOGUE),
                Track(id="music", label="Music", role=TrackRole.MUSIC),
            ]
        )
        project.clips.extend(
            [
                Clip(
                    id="host-1",
                    track_id="host",
                    source_id="src-host",
                    source_start=0.0,
                    source_end=4.0,
                    timeline_start=0.0,
                ),
                Clip(
                    id="co-1",
                    track_id="co",
                    source_id="src-co",
                    source_start=0.0,
                    source_end=4.0,
                    timeline_start=0.0,
                ),
                Clip(
                    id="music-1",
                    track_id="music",
                    source_id="src-music",
                    source_start=0.0,
                    source_end=2.0,
                    timeline_start=3.0,
                ),
            ]
        )
        add_comment(project, body="early", author="rev", timeline_start=0.5, comment_id="early")
        add_comment(project, body="late", author="rev", timeline_start=3.0, comment_id="late")
        add_comment(
            project,
            body="across",
            author="rev",
            timeline_start=0.5,
            timeline_end=2.0,
            comment_id="across",
        )
        project.editorial.chapters = [
            ChapterMarker(time=0.5, title="one"),
            ChapterMarker(time=2.0, title="two"),
        ]

    ws.mutate("seed timeline", "seeded timeline", build)


def _dialogue_clips(project, track_id: str):
    return sorted(
        (c for c in project.clips if c.track_id == track_id), key=lambda c: c.timeline_start
    )


def _everything(ws) -> str:
    ws.reload()
    project = ws.project
    return json.dumps(
        {
            "timeline": _timeline(ws),
            "sources": [s.model_dump() for s in project.sources],
            "record_sessions": [r.model_dump() for r in project.editorial.record_sessions],
            "suggestions": [s.model_dump() for s in project.editorial.session_suggestions],
            "duration": project.timeline.duration_sec,
        },
        sort_keys=True,
        default=str,
    )


def test_staging_captures_the_anchor_and_the_comment_offset(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT, takes=2, comment_in_take=1, join_offset_ms=400)
    row = _suggestion(ws, room["session_id"])
    anchor = row.anchor
    assert anchor is not None
    assert (anchor.kind, anchor.track_id, anchor.source_id, anchor.side) == (
        "clip",
        "host",
        "src-host",
        "before",
    )
    assert anchor.source_sec == pytest.approx(1.0)
    assert anchor.offset_s == pytest.approx(0.0)
    assert anchor.at_sec == 1.0
    assert [t.offset_s for t in row.takes] == pytest.approx([0.4, 3.4])
    [comment] = row.takes[1].comments
    assert comment.timeline_offset_s == pytest.approx(3.0)


@pytest.mark.parametrize(
    ("at_sec", "kind", "side", "source_sec", "offset_s"),
    [
        (0.0, "clip", "before", 0.0, 0.0),
        (4.0, "end", None, None, 0.0),
        (9.0, "end", None, None, 0.0),
        (4.5, "end", None, None, 0.0),
    ],
)
def test_capture_insert_anchor_cases(at_sec, kind, side, source_sec, offset_s):
    from podcast_mcp.edits.insert_anchor import capture_insert_anchor

    project = EpisodeProject.create("anchors", "/tmp/ws")
    project.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.clips.append(
        Clip(
            id="c",
            track_id="host",
            source_id="s",
            source_start=0.0,
            source_end=4.0,
            timeline_start=0.0,
        )
    )
    anchor = capture_insert_anchor(project, at_sec)
    assert (anchor.kind, anchor.side, anchor.source_sec) == (kind, side, source_sec)
    assert anchor.offset_s == pytest.approx(offset_s)


def test_capture_insert_anchor_in_a_gap_follows_the_previous_clip():
    from podcast_mcp.edits.insert_anchor import capture_insert_anchor, resolve_insert_anchor

    project = EpisodeProject.create("gap", "/tmp/ws")
    project.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.clips.extend(
        [
            Clip(
                id="a",
                track_id="host",
                source_id="s",
                source_start=2.0,
                source_end=4.0,
                timeline_start=1.0,
            ),
            Clip(
                id="b",
                track_id="host",
                source_id="s",
                source_start=6.0,
                source_end=8.0,
                timeline_start=5.0,
            ),
        ]
    )
    anchor = capture_insert_anchor(project, 3.5)
    assert (anchor.side, anchor.source_sec, anchor.offset_s) == ("after", 4.0, pytest.approx(0.5))
    assert resolve_insert_anchor(project, anchor) == pytest.approx(3.5)
    before_all = capture_insert_anchor(project, 0.25)
    assert (before_all.side, before_all.source_sec) == ("before", 2.0)
    assert before_all.offset_s == pytest.approx(-0.75)
    assert resolve_insert_anchor(project, before_all) == pytest.approx(0.25)


def test_accept_ripples_every_dialogue_track_and_places_the_takes(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, guest, _svc, _landed = _stage(ws, INSERT, takes=2, comment_in_take=0)
    sid = f"ss-{room['session_id']}"
    staged = _suggestion(ws, room["session_id"])
    span = staged_span_s((t.offset_s, t.duration_s) for t in staged.takes)
    assert span == pytest.approx(3.5)

    result = SessionSuggestionService(ws).accept(sid)

    ws.reload()
    project = ws.project
    assert result["at_sec"] == pytest.approx(1.0)
    assert result["span_s"] == pytest.approx(3.5)
    assert result["suggestion"]["status"] == "accepted"
    assert result["unmoved_track_ids"] == ["music"]
    for track_id in ("host", "co"):
        left, right = _dialogue_clips(project, track_id)
        assert (left.timeline_start, left.source_start, left.source_end) == (0.0, 0.0, 1.0)
        assert right.timeline_start == pytest.approx(4.5)
        assert (right.source_start, right.source_end) == (1.0, 4.0)
        assert right.timeline_end == pytest.approx(4.0 + span)
    [music] = _dialogue_clips(project, "music")
    assert music.timeline_start == 3.0
    placed = _dialogue_clips(project, guest)
    assert [c.timeline_start for c in placed] == pytest.approx([1.0, 4.0])
    assert [c.source_id for c in placed] == [t.source_id for t in staged.takes]
    track = project.track_by_id(guest)
    assert track is not None
    assert track.role == TrackRole.DIALOGUE
    assert track.media is not None
    assert track.media.path == project.source_by_id(staged.takes[0].source_id).path
    assert project.timeline.duration_sec == pytest.approx(7.5)
    assert max(c.timeline_end for c in project.clips) == pytest.approx(7.5)
    assert _suggestion(ws, room["session_id"]).status == "accepted"
    assert HistoryService(ws).list_entries().groups[-1].title == "Added Session 1"


def test_accept_shifts_comments_and_chapters_and_lands_the_live_comments(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    _room, guest, _svc, _landed = _stage(ws, INSERT, takes=2, comment_in_take=0)
    SessionSuggestionService(ws).accept(ws.project.editorial.session_suggestions[0].id)
    ws.reload()
    by_id = {c.id: c for c in ws.project.comments}
    assert by_id["early"].timeline_start == 0.5
    assert by_id["late"].timeline_start == pytest.approx(6.5)
    assert (by_id["across"].timeline_start, by_id["across"].timeline_end) == (
        0.5,
        pytest.approx(5.5),
    )
    assert [c.time for c in ws.project.editorial.chapters] == pytest.approx([0.5, 5.5])
    live = by_id["live-note"]
    assert (live.author, live.body) == (guest, "Fix this")
    assert live.timeline_start == pytest.approx(1.0 + 0.0 + 1.5)


def test_accepted_live_comments_use_the_take_origin_without_the_join_offset(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, guest, _svc, _landed = _stage(ws, INSERT, takes=2, comment_in_take=1, join_offset_ms=400)
    staged = _suggestion(ws, room["session_id"])
    recording_s = staged.takes[1].comments[0].recording_ms / 1000.0
    SessionSuggestionService(ws).accept(staged.id)
    ws.reload()
    live = next(c for c in ws.project.comments if c.id == "live-note")
    assert live.timeline_start == pytest.approx(1.0 + 3.0 + recording_s)
    placed = _dialogue_clips(ws.project, guest)
    assert [c.timeline_start for c in placed] == pytest.approx([1.4, 4.4])
    assert ws.project.timeline.duration_sec == pytest.approx(4.0 + 3.9)


def test_accept_at_the_end_places_after_the_last_dialogue(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, guest, _svc, _landed = _stage(ws, {"kind": "insert", "at_sec": 50.0}, takes=2)
    assert _suggestion(ws, room["session_id"]).anchor.kind == "end"
    result = SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    ws.reload()
    assert result["at_sec"] == pytest.approx(4.0)
    assert [c.timeline_start for c in _dialogue_clips(ws.project, guest)] == pytest.approx(
        [4.0, 7.0]
    )
    assert [len(_dialogue_clips(ws.project, t)) for t in ("host", "co")] == [1, 1]
    assert ws.project.timeline.duration_sec == pytest.approx(4.0 + 3.5)


def test_accept_follows_the_audio_the_point_was_staged_on(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, guest, _svc, _landed = _stage(ws, INSERT)
    ws.mutate(
        "cut earlier",
        "cut earlier",
        lambda p: ripple_remove_clips(
            p, [(0.0, 0.5)], ripple_track_ids(p), defaults=ws.effective_config()
        ),
    )
    TimelineService(ws).insert_gap(0.25, 2.0)
    result = SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    ws.reload()
    assert result["at_sec"] == pytest.approx(1.0 - 0.5 + 2.0)
    [placed] = _dialogue_clips(ws.project, guest)
    assert placed.timeline_start == pytest.approx(2.5)


def test_accept_straddling_a_clip_split_by_an_earlier_insert_keeps_the_anchor(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    TimelineService(ws).insert_gap(1.0, 2.0)
    result = SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert result["at_sec"] == pytest.approx(3.0)


def test_accept_at_a_point_in_a_gap_moves_with_the_clip_before_it(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)

    def build(project: EpisodeProject) -> None:
        project.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
        for clip_id, start in (("a", 0.0), ("b", 6.0)):
            project.clips.append(
                Clip(
                    id=clip_id,
                    track_id="host",
                    source_id=f"src-{clip_id}",
                    source_start=0.0,
                    source_end=4.0,
                    timeline_start=start,
                )
            )

    ws.mutate("seed", "seeded", build)
    room, _guest, _svc, _landed = _stage(ws, {"kind": "insert", "at_sec": 5.0})
    anchor = _suggestion(ws, room["session_id"]).anchor
    assert (anchor.side, anchor.source_id, anchor.offset_s) == ("after", "src-a", 1.0)
    TimelineService(ws).insert_gap(0.5, 1.0)
    result = SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert result["at_sec"] == pytest.approx(6.0)


def test_accept_refuses_a_stale_anchor_and_changes_nothing(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    ws.mutate(
        "cut the point",
        "cut the point",
        lambda p: ripple_remove_clips(
            p, [(0.5, 2.0)], ripple_track_ids(p), defaults=ws.effective_config()
        ),
    )
    before = _everything(ws)
    with pytest.raises(CodedValueError) as raised:
        SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert raised.value.code == "stale_anchor"
    assert _everything(ws) == before
    assert _suggestion(ws, room["session_id"]).status == "pending"


def test_accept_places_the_room_tone_bed(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.engines.room_tone import room_tone_source_id
    from podcast_mcp.engines.track_ids import slug_track_id

    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room = ShareService(ws).create_record_room(target=INSERT)
    svc, guest = _join(ws, room)
    _room_tone_bed(ws, room, guest)
    _record(ws, room, svc, guest, 1)
    RecordLandingService(ws).land(align=lambda _p: None)
    staged = _suggestion(ws, room["session_id"])
    [bed] = staged.room_tone
    SessionSuggestionService(ws).accept(staged.id)
    ws.reload()
    track_id = slug_track_id(guest)
    track = ws.project.track_by_id(track_id)
    assert track is not None
    assert track.room_tone is not None
    assert track.room_tone.path == bed.path
    assert ws.project.source_by_id(room_tone_source_id(track_id)).path == bed.path


def test_accept_is_one_undo_step_and_redo_replays_it(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT, takes=2, comment_in_take=0)
    sid = f"ss-{room['session_id']}"
    before = _everything(ws)
    SessionSuggestionService(ws).accept(sid)
    accepted = _everything(ws)
    assert accepted != before
    history = HistoryService(ws)
    group = history.list_entries().groups[-1]
    assert group.title == "Added Session 1"

    history.undo()
    assert _everything(ws) == before
    assert _suggestion(ws, room["session_id"]).status == "pending"
    history.redo()
    assert _everything(ws) == accepted
    history.undo()
    SessionSuggestionService(ws).accept(sid)
    ws.reload()
    assert _suggestion(ws, room["session_id"]).status == "accepted"
    entry = ws.project.history.entries[-1]
    assert entry.operation == "accept_session_suggestion"
    assert entry.params["session_number"] == 1


def test_accept_refusals(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, guest, _svc, _landed = _stage(ws, INSERT)
    sid = f"ss-{room['session_id']}"
    service = SessionSuggestionService(ws)
    with pytest.raises(KeyError) as missing:
        service.accept("ss-missing")
    assert missing.value.code == "session_suggestion_not_found"

    from podcast_mcp.engines.track_ids import slug_track_id

    ws.mutate(
        "music on the guest id",
        "music on the guest id",
        lambda p: p.tracks.append(
            Track(id=slug_track_id(guest), label="Music", role=TrackRole.MUSIC)
        ),
    )
    before = _everything(ws)
    with pytest.raises(CodedValueError) as wrong_role:
        service.accept(sid)
    assert wrong_role.value.code == "track_not_dialogue"
    assert _everything(ws) == before
    HistoryService(ws).undo()

    service.accept(sid)
    accepted = _everything(ws)
    with pytest.raises(CodedValueError, match="was already accepted") as again:
        service.accept(sid)
    assert again.value.code == "session_suggestion_not_pending"
    assert _everything(ws) == accepted
    HistoryService(ws).undo()
    service.skip(sid)
    with pytest.raises(CodedValueError) as skipped:
        service.accept(sid)
    assert skipped.value.code == "session_suggestion_not_pending"


def test_accept_refuses_a_replace_over_an_unrecorded_track_and_an_empty_session(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws, label="Someone else")
    _seed_timeline(ws)
    room, _guest, _svc, _landed = _stage(ws, REPLACE)
    before = _everything(ws)
    with pytest.raises(CodedValueError, match=r'did not record "Someone else"') as replace:
        SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert replace.value.code == "track_not_recorded"
    assert _everything(ws) == before

    from podcast_mcp.models import SessionSuggestion

    ws.mutate(
        "empty suggestion",
        "empty suggestion",
        lambda p: p.editorial.session_suggestions.append(
            SessionSuggestion(
                id="ss-empty",
                kind="insert",
                session_id="e" * 12,
                session_number=9,
                at_sec=1.0,
            )
        ),
    )
    with pytest.raises(CodedValueError) as empty:
        SessionSuggestionService(ws).accept("ss-empty")
    assert empty.value.code == "session_suggestion_empty"


def test_a_second_pending_insert_at_the_same_anchor_is_refused_until_the_first_is_decided(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    first, _guest, _svc, _landed = _stage(ws, INSERT)
    other = ShareService(ws).create_record_room(target=INSERT)
    svc, guest = _join(ws, other)
    _record(ws, other, svc, guest, 1)
    before = _everything(ws)
    with pytest.raises(InsertAnchorTakenError, match="Session 1 is already staged") as raised:
        RecordLandingService(ws).land(align=lambda _p: None)
    assert raised.value.code == "insert_anchor_taken"
    assert _everything(ws) == before
    assert not [s for s in ws.project.sources if s.id.startswith(f"rec-{other['session_id']}-")]
    raw = Path(ws.project.workspace_dir) / "raw"
    assert not [p for p in raw.rglob("*") if other["session_id"] in p.name]

    SessionSuggestionService(ws).skip(f"ss-{first['session_id']}")
    landed = RecordLandingService(ws).land(align=lambda _p: None)
    assert [item["take_index"] for item in landed["staged"]] == [0]


@pytest.mark.parametrize("decision", ["accept", "skip"])
def test_a_take_after_a_decision_is_refused_and_nothing_changes(
    minimal_project, sample_wav, tmp_workspace, decision
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, guest, svc, _landed = _stage(ws, INSERT)
    sid = f"ss-{room['session_id']}"
    service = SessionSuggestionService(ws)
    getattr(service, decision)(sid)
    svc.submit(_cmd("Start"), now_wall_ms=20_000)
    svc.submit(_cmd("Stop"), now_wall_ms=23_000)
    _ack(ws, room, guest, 1)
    _room_tone_bed(ws, room, guest)
    before = _everything(ws)
    raw = Path(ws.project.workspace_dir) / "raw"
    files = sorted(raw.rglob("*"))

    with pytest.raises(SessionSuggestionClosedError) as raised:
        RecordLandingService(ws).land(align=lambda _p: None)
    assert raised.value.code == "session_suggestion_closed"
    assert _everything(ws) == before
    assert sorted(raw.rglob("*")) == files
    rows = RecordUploadService(ws.project).status(session_id=room["session_id"])["segments"]
    assert [bool(r.get("landed")) for r in rows if r["take_index"] == 1] == [False]


def test_discarding_a_placed_take_is_refused_but_a_skipped_one_can_go(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, guest, svc, _landed = _stage(ws, INSERT)
    sid = f"ss-{room['session_id']}"
    SessionSuggestionService(ws).accept(sid)
    before = _everything(ws)
    with pytest.raises(TakeAlreadyPlacedError) as raised:
        RecordLandingService(ws).delete_take(0)
    assert raised.value.code == "take_already_placed"
    assert _everything(ws) == before

    HistoryService(ws).undo()
    SessionSuggestionService(ws).skip(sid)
    svc.submit(_cmd("Start"), now_wall_ms=20_000)
    svc.submit(_cmd("Stop"), now_wall_ms=23_000)
    _ack(ws, room, guest, 1)
    with pytest.raises(SessionSuggestionClosedError):
        RecordLandingService(ws).land(align=lambda _p: None)
    RecordLandingService(ws).delete_take(0)
    ws.reload()
    assert ws.project.editorial.session_suggestions == []
    assert not [s for s in ws.project.sources if s.id.startswith(f"rec-{room['session_id']}-0-")]


def test_cli_and_mcp_accept(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    sid = f"ss-{room['session_id']}"
    runner = CliRunner()
    done = runner.invoke(
        cli_app,
        ["review", "accept-session-suggestion", "--project", str(minimal_project), "--id", sid],
    )
    assert done.exit_code == 0, done.output
    payload = json.loads(done.output)
    assert (payload["suggestion"]["status"], payload["unmoved_track_ids"]) == (
        "accepted",
        ["music"],
    )
    again = runner.invoke(
        cli_app,
        ["review", "accept-session-suggestion", "--project", str(minimal_project), "--id", sid],
    )
    assert again.exit_code == 1
    assert "was already" in again.output
    with pytest.raises(CodedValueError):
        accept_session_suggestion_tool(str(minimal_project), sid)
    HistoryService(ProjectWorkspace.open(minimal_project)).undo()
    result = json.loads(accept_session_suggestion_tool(str(minimal_project), sid))
    assert result["suggestion"]["status"] == "accepted"


def test_accept_refuses_a_session_without_an_anchor_or_a_recording_and_changes_nothing(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    sid = f"ss-{room['session_id']}"
    staged = _suggestion(ws, room["session_id"])
    service = SessionSuggestionService(ws)

    def drop_source(project: EpisodeProject) -> None:
        project.sources = [s for s in project.sources if s.id != staged.takes[0].source_id]

    ws.mutate("drop source", "dropped source", drop_source)
    before = _everything(ws)
    with pytest.raises(CodedValueError) as missing:
        service.accept(sid)
    assert missing.value.code == "staged_source_missing"
    assert _everything(ws) == before
    HistoryService(ws).undo()

    def drop_anchor(project: EpisodeProject) -> None:
        project.editorial.session_suggestions[0].anchor = None

    ws.mutate("drop anchor", "dropped anchor", drop_anchor)
    with pytest.raises(CodedValueError) as unanchored:
        service.accept(sid)
    assert unanchored.value.code == "stale_anchor"


def test_accept_leaves_a_live_comment_whose_id_belongs_to_another_author(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT, comment_in_take=0)
    ws.mutate(
        "taken id",
        "taken id",
        lambda p: add_comment(
            p, body="mine", author="someone-else", timeline_start=0.1, comment_id="live-note"
        ),
    )
    result = SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert result["comments"] == []
    ws.reload()
    assert [c.body for c in ws.project.comments if c.id == "live-note"] == ["mine"]


def _seed_single_clip(ws, *, start: float = 0.0, end: float = 8.0, source_id: str = "src-a"):
    def build(project: EpisodeProject) -> None:
        project.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
        project.clips.append(
            Clip(
                id="a",
                track_id="host",
                source_id=source_id,
                source_start=0.0,
                source_end=end,
                timeline_start=start,
            )
        )

    ws.mutate("seed", "seeded", build)


def _seed_replaceable(ws, track_id: str = "ava", label: str = "Ava") -> None:
    def build(project: EpisodeProject) -> None:
        project.tracks.append(Track(id=track_id, label=label, role=TrackRole.DIALOGUE))
        project.clips.append(
            Clip(
                id="base",
                track_id=track_id,
                source_id="src-base",
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
        )

    ws.mutate("seed", "seeded", build)


def _guest_starts(ws, room) -> list[float]:
    ws.reload()
    prefix = f"rec-{room['session_id']}-"
    return [c.timeline_start for c in ws.project.clips if (c.source_id or "").startswith(prefix)]


def test_accept_does_not_land_in_a_copy_of_the_same_source_range(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_single_clip(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    TimelineService(ws).duplicate_segment(0.5, 1.5, 5.0)
    result = SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert result["at_sec"] == pytest.approx(1.0)
    assert _guest_starts(ws, room) == [pytest.approx(1.0)]


def test_accept_refuses_when_copies_leave_the_spot_unclear(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_single_clip(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    TimelineService(ws).duplicate_segment(0.5, 1.5, 5.0)
    TimelineService(ws).insert_gap(0.0, 2.0)
    before = _everything(ws)
    with pytest.raises(CodedValueError, match="Record the session again") as raised:
        SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert raised.value.code == "stale_anchor"
    assert _everything(ws) == before


def test_accept_does_not_guess_between_clips_without_a_source(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)

    def build(project: EpisodeProject) -> None:
        project.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
        for clip_id, start in (("a", 0.0), ("b", 4.0)):
            project.clips.append(
                Clip(
                    id=clip_id,
                    track_id="host",
                    source_id=None,
                    source_start=0.0,
                    source_end=4.0,
                    timeline_start=start,
                )
            )

    ws.mutate("seed", "seeded", build)
    room, _guest, _svc, _landed = _stage(ws, {"kind": "insert", "at_sec": 5.0})
    ws.mutate(
        "move",
        "moved",
        lambda p: setattr(next(c for c in p.clips if c.id == "a"), "timeline_start", 20.0),
    )
    ws.mutate(
        "move",
        "moved",
        lambda p: setattr(next(c for c in p.clips if c.id == "b"), "timeline_start", 30.0),
    )
    with pytest.raises(CodedValueError) as raised:
        SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert raised.value.code == "stale_anchor"


def test_accept_refuses_a_gap_anchor_whose_gap_was_closed(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)

    def build(project: EpisodeProject) -> None:
        project.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
        for clip_id, start in (("a", 0.0), ("b", 6.0)):
            project.clips.append(
                Clip(
                    id=clip_id,
                    track_id="host",
                    source_id=f"src-{clip_id}",
                    source_start=0.0,
                    source_end=4.0,
                    timeline_start=start,
                )
            )

    ws.mutate("seed", "seeded", build)
    room, _guest, _svc, _landed = _stage(ws, {"kind": "insert", "at_sec": 5.0})
    ws.mutate(
        "close the gap",
        "closed the gap",
        lambda p: ripple_remove_clips(
            p, [(4.0, 6.0)], ripple_track_ids(p), defaults=ws.effective_config()
        ),
    )
    before = _everything(ws)
    with pytest.raises(CodedValueError) as raised:
        SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert raised.value.code == "stale_anchor"
    assert _everything(ws) == before


def test_accept_refuses_a_point_that_moved_before_the_start(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_single_clip(ws, start=5.0, end=6.0)
    room, _guest, _svc, _landed = _stage(ws, {"kind": "insert", "at_sec": 2.0})
    anchor = _suggestion(ws, room["session_id"]).anchor
    assert (anchor.side, anchor.offset_s) == ("before", -3.0)
    ws.mutate(
        "cut the start",
        "cut the start",
        lambda p: ripple_remove_clips(
            p, [(0.0, 4.0)], ripple_track_ids(p), defaults=ws.effective_config()
        ),
    )
    before = _everything(ws)
    with pytest.raises(CodedValueError) as raised:
        SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert raised.value.code == "stale_anchor"
    assert _everything(ws) == before


def test_a_land_after_accept_with_a_held_bed_and_no_new_recording_is_quiet(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room = ShareService(ws).create_record_room(target=INSERT)
    svc, guest = _join(ws, room)
    _room_tone_bed(ws, room, guest)
    _record(ws, room, svc, guest, 1)
    RecordLandingService(ws).land(align=lambda _p: None)
    sid = f"ss-{room['session_id']}"
    SessionSuggestionService(ws).accept(sid)
    before = _everything(ws)
    landed = RecordLandingService(ws).land(align=lambda _p: None)
    assert landed["clips"] == []
    assert landed["staged"] == []
    assert _everything(ws) == before
    svc.submit(_cmd("Start"), now_wall_ms=20_000)
    svc.submit(_cmd("Stop"), now_wall_ms=23_000)
    _ack(ws, room, guest, 1)
    with pytest.raises(SessionSuggestionClosedError):
        RecordLandingService(ws).land(align=lambda _p: None)


def test_a_take_refused_inside_the_mutate_leaves_its_row_and_no_copy(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, guest, svc, _landed = _stage(ws, INSERT)
    sid = f"ss-{room['session_id']}"
    svc.submit(_cmd("Start"), now_wall_ms=20_000)
    svc.submit(_cmd("Stop"), now_wall_ms=23_000)
    _ack(ws, room, guest, 1)
    raw = Path(ws.project.workspace_dir) / "raw"
    files = sorted(raw.rglob("*"))
    other = ProjectWorkspace.open(minimal_project)
    original = RecordLandingService._unstaged_comments

    def accept_first(self, rows, copied):
        SessionSuggestionService(other).accept(sid)
        return original(self, rows, copied)

    monkeypatch.setattr(RecordLandingService, "_unstaged_comments", accept_first)
    with pytest.raises(SessionSuggestionClosedError):
        RecordLandingService(ws).land(align=lambda _p: None)
    rows = RecordUploadService(ws.project).status(session_id=room["session_id"])["segments"]
    second = [r for r in rows if r["take_index"] == 1]
    assert [bool(r.get("land_failed")) for r in second] == [False]
    assert sorted(raw.rglob("*")) == files


def test_a_later_land_uses_the_stored_anchor_instead_of_capturing_again(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_single_clip(ws, end=10.0)
    _stage(ws, {"kind": "insert", "at_sec": 6.0})
    room, guest, svc, _landed = _stage(ws, {"kind": "insert", "at_sec": 1.0})
    ws.mutate(
        "cut between",
        "cut between",
        lambda p: ripple_remove_clips(
            p, [(1.0, 6.0)], ripple_track_ids(p), defaults=ws.effective_config()
        ),
    )
    svc.submit(_cmd("Start"), now_wall_ms=20_000)
    svc.submit(_cmd("Stop"), now_wall_ms=23_000)
    _ack(ws, room, guest, 1)
    landed = RecordLandingService(ws).land(align=lambda _p: None)
    assert [item["take_index"] for item in landed["staged"]] == [1]


def test_not_pending_and_unknown_messages_say_what_to_do(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    sid = f"ss-{room['session_id']}"
    service = SessionSuggestionService(ws)
    with pytest.raises(KeyError, match="List the staged sessions"):
        service.accept("ss-missing")
    service.skip(sid)
    with pytest.raises(CodedValueError, match="Undo that step first"):
        service.accept(sid)


def test_accept_shifts_pending_timeline_decisions_on_dialogue_tracks_only(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.models import EditDecision, EditDecisionType

    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)

    def add(project: EpisodeProject) -> None:
        for edit_id, track_id, start in (
            ("early", "host", 0.25),
            ("late", "host", 3.0),
            ("music", "music", 3.0),
        ):
            project.editorial.edit_decisions.append(
                EditDecision(
                    id=edit_id,
                    track_id=track_id,
                    type=EditDecisionType.MUTE,
                    start=start,
                    end=start + 0.5,
                    timebase="timeline",
                    applied=False,
                )
            )
        project.editorial.edit_decisions.append(
            EditDecision(
                id="split",
                track_id="host",
                type=EditDecisionType.SPLIT,
                start=3.5,
                end=3.5,
                timebase="timeline",
                applied=False,
            )
        )

    ws.mutate("seed decisions", "seeded decisions", add)
    room, _guest, _svc, _landed = _stage(ws, INSERT)
    result = SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    ws.reload()
    spans = {e.id: (e.start, e.end) for e in ws.project.editorial.edit_decisions}
    assert spans["early"] == (0.25, 0.75)
    assert spans["late"] == (
        pytest.approx(3.0 + result["span_s"]),
        pytest.approx(3.5 + result["span_s"]),
    )
    assert spans["split"] == (pytest.approx(3.5 + result["span_s"]),) * 2
    assert spans["music"] == (3.0, 3.5)


def test_a_bed_arriving_inside_the_mutate_after_accept_is_refused_not_held(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, guest, _svc, _landed = _stage(ws, INSERT)
    sid = f"ss-{room['session_id']}"
    _room_tone_bed(ws, room, guest)
    raw = Path(ws.project.workspace_dir) / "raw"
    files = sorted(p for p in raw.rglob("*") if p.is_file())
    other = ProjectWorkspace.open(minimal_project)
    original = RecordLandingService._unstaged_comments

    def accept_first(self, rows, copied):
        SessionSuggestionService(other).accept(sid)
        return original(self, rows, copied)

    monkeypatch.setattr(RecordLandingService, "_unstaged_comments", accept_first)
    with pytest.raises(SessionSuggestionClosedError):
        RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    assert _suggestion(ws, room["session_id"]).room_tone == []
    rows = RecordUploadService(ws.project).room_tone_status(session_id=room["session_id"])
    assert [bool(r.get("landed")) or bool(r.get("land_failed")) for r in rows] == [False]
    assert sorted(p for p in raw.rglob("*") if p.is_file()) == files


def _bed_rows(ws, room):
    return RecordUploadService(ws.project).room_tone_status(session_id=room["session_id"])


@pytest.mark.parametrize("target", [INSERT, REPLACE], ids=["insert", "replace"])
def test_a_staged_bed_upload_row_is_landed_once_held(
    minimal_project, sample_wav, tmp_workspace, target
):
    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws)
    room = ShareService(ws).create_record_room(target=target)
    svc, guest = _join(ws, room)
    _room_tone_bed(ws, room, guest)
    _record(ws, room, svc, guest, 1)
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    assert len(_suggestion(ws, room["session_id"]).room_tone) == 1
    [row] = _bed_rows(ws, room)
    assert bool(row.get("landed")) is True
    assert bool(row.get("land_failed")) is False
    first = _everything(ws)
    RecordLandingService(ws).land(align=lambda _p: None)
    assert _everything(ws) == first


def test_a_land_after_accept_leaves_the_bed_row_landed(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room = ShareService(ws).create_record_room(target=INSERT)
    svc, guest = _join(ws, room)
    _room_tone_bed(ws, room, guest)
    _record(ws, room, svc, guest, 1)
    RecordLandingService(ws).land(align=lambda _p: None)
    SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    before = _everything(ws)
    landed = RecordLandingService(ws).land(align=lambda _p: None)
    assert landed["staged"] == [] and landed["clips"] == []
    assert _everything(ws) == before
    [row] = _bed_rows(ws, room)
    assert (bool(row.get("landed")), bool(row.get("land_failed"))) == (True, False)


def test_a_bed_arriving_after_close_stays_refused_and_unlanded(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, guest, _svc, _landed = _stage(ws, INSERT)
    SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    _room_tone_bed(ws, room, guest)
    before = _everything(ws)
    with pytest.raises(SessionSuggestionClosedError):
        RecordLandingService(ws).land(align=lambda _p: None)
    assert _everything(ws) == before
    [row] = _bed_rows(ws, room)
    assert (bool(row.get("landed")), bool(row.get("land_failed"))) == (False, False)


def test_an_end_target_lands_the_bed_and_take_on_the_timeline(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.engines.room_tone import room_tone_source_id
    from podcast_mcp.engines.track_ids import slug_track_id

    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _join(ws, room)
    _room_tone_bed(ws, room, guest)
    _record(ws, room, svc, guest, 1)
    landed = RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    track_id = slug_track_id(guest)
    track = ws.project.track_by_id(track_id)
    assert track is not None and track.room_tone is not None
    assert ws.project.source_by_id(room_tone_source_id(track_id)) is not None
    assert [c.timeline_start for c in ws.project.clips] == [0.0]
    assert len(landed["clips"]) == 1
    assert ws.project.editorial.session_suggestions == []
    [row] = _bed_rows(ws, room)
    assert (bool(row.get("landed")), bool(row.get("land_failed"))) == (True, False)


def _refused_target(ws, target):
    from podcast_mcp.services.record.control import RecordControlService

    with pytest.raises(CodedValueError) as raised:
        ShareService(ws).create_record_room(target=target)
    assert raised.value.code == "invalid_record_request"
    ShareService(ws).create_record_room()
    ctrl = RecordControlService(ws)
    with pytest.raises(CodedValueError) as via_control:
        ctrl.set_target(target)
    with pytest.raises(CodedValueError) as via_command:
        ctrl.submit_host("SetTarget", {"target": target})
    assert str(via_control.value) == str(via_command.value) == str(raised.value)
    assert ctrl.snapshot()["target"] == {"kind": "end"}
    return str(raised.value)


def test_a_replace_target_with_an_unknown_track_is_refused_by_field(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws)
    message = _refused_target(
        ws, {"kind": "replace", "from_sec": 1, "to_sec": 2, "track_ids": ["ava", "ghost"]}
    )
    assert message.startswith("track_ids:") and "ghost" in message and "ava" in message


def test_a_replace_target_past_the_timeline_end_is_refused_by_field(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws)
    message = _refused_target(
        ws, {"kind": "replace", "from_sec": 8, "to_sec": 12, "track_ids": ["ava"]}
    )
    assert message.startswith("to_sec:") and "10.000s" in message


@pytest.mark.parametrize(
    "target", [{"kind": "end"}, {"kind": "start"}, {"kind": "insert", "at_sec": 2}]
)
@pytest.mark.parametrize("damaged_file", ["project", "history"])
def test_nonreplace_target_persists_when_saved_project_is_unreadable(
    minimal_project, sample_wav, tmp_workspace, target, damaged_file
):
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _join(ws, room)
    damaged_path = ws.path if damaged_file == "project" else ws.project.history_dir() / "index.json"
    damaged_path.parent.mkdir(parents=True, exist_ok=True)
    damaged_path.write_text("{ invalid generated saved state")

    svc.submit(_cmd("SetTarget", payload={"target": target}), now_wall_ms=0)
    assert (
        RecordSessionService(ws.project, session_id=room["session_id"]).snapshot()["target"]
        == target
    )
    loader_error = (
        "project file is damaged" if damaged_file == "project" else "corrupt JSON sidecar"
    )
    with pytest.raises(ValueError, match=loader_error):
        svc.submit(
            _cmd(
                "SetTarget",
                payload={
                    "target": {
                        "kind": "replace",
                        "from_sec": 1,
                        "to_sec": 2,
                        "track_ids": ["ava"],
                    }
                },
            ),
            now_wall_ms=0,
        )
    assert (
        RecordSessionService(ws.project, session_id=room["session_id"]).snapshot()["target"]
        == target
    )


def test_replace_target_uses_saved_identity_while_live_workspace_path_is_temporary(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws)
    room = ShareService(ws).create_record_room()
    svc, _guest = _join(ws, room)
    ws.project.tracks.append(Track(id="unsaved", label="Unsaved", role=TrackRole.MUSIC))
    target = {"kind": "replace", "from_sec": 1, "to_sec": 2, "track_ids": ["unsaved"]}
    monkeypatch.chdir(tmp_path)
    original_workspace = ws.project.workspace_dir
    ws.project.workspace_dir = "."
    try:
        with pytest.raises(CodedValueError, match="unsaved"):
            svc.submit(_cmd("SetTarget", payload={"target": target}), now_wall_ms=0)
    finally:
        ws.project.workspace_dir = original_workspace
    assert RecordSessionService(ws.project, session_id=room["session_id"]).snapshot()["target"] == {
        "kind": "end"
    }


def test_a_replace_target_over_a_track_added_after_connect_is_accepted(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws)
    room = ShareService(ws).create_record_room()
    svc, _guest = _join(ws, room)
    target = {"kind": "replace", "from_sec": 1, "to_sec": 2, "track_ids": ["music"]}
    with pytest.raises(CodedValueError, match="music"):
        svc.submit(_cmd("SetTarget", payload={"target": target}), now_wall_ms=0)

    def add_music(project: EpisodeProject) -> None:
        project.tracks.append(Track(id="music", label="Music", role=TrackRole.MUSIC))

    ProjectWorkspace.open(ws.path).mutate("add", "added", add_music)
    assert ws.project.track_by_id("music") is None
    svc.submit(_cmd("SetTarget", payload={"target": target}), now_wall_ms=0)
    assert svc.snapshot()["target"]["track_ids"] == ["music"]


def test_a_replace_target_overshooting_by_a_hair_is_accepted_and_a_real_overshoot_reads_clearly(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.services.record.control import RecordControlService

    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws)
    ShareService(ws).create_record_room()
    ctrl = RecordControlService(ws)
    hair = {"kind": "replace", "from_sec": 1, "to_sec": 10.00001, "track_ids": ["ava"]}
    assert ctrl.set_target(hair)["target"]["to_sec"] == 10.00001
    near = {"kind": "replace", "from_sec": 1, "to_sec": 10.004, "track_ids": ["ava"]}
    with pytest.raises(CodedValueError) as raised:
        ctrl.set_target(near)
    assert "10.004s" in str(raised.value) and "10.000s" in str(raised.value)


def test_a_replace_target_in_an_episode_without_tracks_says_so(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    message = _refused_target(
        ws, {"kind": "replace", "from_sec": 1, "to_sec": 2, "track_ids": ["ava"]}
    )
    assert message == (
        "track_ids: this episode has no tracks yet, so a replace target cannot be set."
    )


def test_set_target_without_a_target_is_refused_naming_the_field():
    from podcast_mcp.services.record.commands import validate_record_payload

    for payload in ({}, {"target": None}, {"target": 3}, {"target": ["end"]}):
        with pytest.raises(CodedValueError, match=r"^target:") as raised:
            validate_record_payload("SetTarget", payload)
        assert raised.value.code == "invalid_record_request"


def test_set_target_accepts_a_bare_kind_string_like_the_cli():
    from podcast_mcp.services.record.commands import validate_record_payload

    for kind in ("end", "start"):
        assert validate_record_payload("SetTarget", {"target": kind}) == {"target": {"kind": kind}}
    assert validate_record_payload("SetTarget", {"target": " end "}) == {"target": {"kind": "end"}}


def test_set_target_refuses_a_bare_string_that_needs_more_or_is_unknown():
    from podcast_mcp.services.record.commands import validate_record_payload

    for bare, needle in (
        ("insert", "at_sec"),
        ("replace", "track_ids"),
        ("middle", "use end, start, insert or replace"),
        ("", "use end, start, insert or replace"),
    ):
        with pytest.raises(CodedValueError, match=needle) as raised:
            validate_record_payload("SetTarget", {"target": bare})
        assert raised.value.code == "invalid_record_request"


def test_set_target_with_each_object_kind_validates():
    from podcast_mcp.services.record.commands import validate_record_payload

    for kind in ("end", "insert", "replace"):
        target = {
            "end": {"kind": "end"},
            "insert": {"kind": "insert", "at_sec": 1.0},
            "replace": {"kind": "replace", "from_sec": 1.0, "to_sec": 2.0, "track_ids": ["a"]},
        }[kind]
        assert validate_record_payload("SetTarget", {"target": target})["target"]["kind"] == kind


def test_set_target_stays_locked_after_a_discarded_only_take(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.services.record.control import RecordControlService
    from podcast_mcp.services.record.reducer import RecordStateError

    ws = _seed(minimal_project, sample_wav)
    _stage(ws, INSERT)
    RecordLandingService(ws).delete_take(0)
    ws.reload()
    assert ws.project.editorial.session_suggestions == []
    with pytest.raises(RecordStateError, match="locked once a take has been recorded"):
        RecordControlService(ws).set_target({"kind": "end"})


def test_a_replace_target_with_a_reversed_range_is_refused_by_field(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws)
    message = _refused_target(
        ws, {"kind": "replace", "from_sec": 5, "to_sec": 2, "track_ids": ["ava"]}
    )
    assert "to_sec" in message


def test_a_valid_replace_target_is_accepted_by_every_path(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.services.record.control import RecordControlService

    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws)
    target = {"kind": "replace", "from_sec": 1.0, "to_sec": 10.0, "track_ids": ["ava"]}
    ShareService(ws).create_record_room()
    ctrl = RecordControlService(ws)
    assert ctrl.set_target(target)["target"] == target
    ctrl.submit_host("SetTarget", {"target": {"kind": "end"}})
    assert ctrl.snapshot()["target"] == {"kind": "end"}


def test_an_insert_past_the_end_is_allowed_and_anchors_to_the_end(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.services.record.control import RecordControlService

    ws = _seed(minimal_project, sample_wav)
    _seed_replaceable(ws)
    far = {"kind": "insert", "at_sec": 500.0}
    room, _guest, _svc, _landed = _stage(ws, far)
    row = _suggestion(ws, room["session_id"])
    assert row.anchor is not None and row.anchor.kind == "end"
    ShareService(ws).create_record_room()
    assert RecordControlService(ws).set_target(far)["target"] == far
