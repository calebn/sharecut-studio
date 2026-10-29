"""Returning people: a person is matched to their track by name across sessions; the host can correct it."""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools.record import record_assign_track_tool, record_tracks_tool
from podcast_mcp.models import Clip, Track, TrackRole, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document import HistoryService, SessionSuggestionService
from podcast_mcp.services.record.commands import RecordCommand
from podcast_mcp.services.record.control import RecordControlService
from podcast_mcp.services.record.landing import RecordLandingService
from podcast_mcp.services.record.service import (
    RecordSessionService,
    apply_record_ws_message,
    next_record_client_seq,
    reset_record_runtime_for_tests,
)
from podcast_mcp.services.record.track_match import normalize_name
from podcast_mcp.services.record.upload import RecordUploadService, sha256_hex
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.wav import pcm_wav_header

CAPS = ["join", "monitor", "comment"]
INSERT = {"kind": "insert", "at_sec": 1.0}


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


def _ack(ws, room, pid: str, take: int, *, seconds: float = 0.5) -> None:
    pcm = bytes(int(48_000 * 2 * seconds))
    wav = pcm_wav_header(len(pcm)) + pcm
    RecordUploadService(ws.project).ingest_part(
        session_id=room["session_id"],
        take_index=take,
        participant_id=pid,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=sha256_hex(pcm),
        file_sha256=sha256_hex(wav),
        final=True,
        expected_parts=1,
        join_offset_ms=0,
    )


def _join_guest(svc, room, name: str, i: int) -> str:
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name=name,
        client_id=f"rec-guest-{i}",
        connection_id=f"c{i}",
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
        client_id=f"rec-guest-{i}",
        role="guest",
        participant_id=echo["participant_id"],
        seq=2,
        capabilities=CAPS,
        connection_id=f"c{i}",
    )
    return echo["participant_id"]


def _late_guest(ws, room, name: str) -> str:
    """A guest who joins a room after its take stopped, with nothing recorded yet."""
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    return _join_guest(svc, room, name, 9)


def _room(ws, names: list[str], *, target=None, land: bool = False):
    """A room whose guests (``names``) all consented and recorded one take."""
    room = ShareService(ws).create_record_room(target=target)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    pids = [_join_guest(svc, room, name, i) for i, name in enumerate(names)]
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    for pid in pids:
        _ack(ws, room, pid, 0)
    if land:
        RecordLandingService(ws).land(align=lambda _p: None)
    return room, pids


def _tracks(ws) -> dict[str, str]:
    ws.reload()
    return {t.id: t.label for t in ws.project.tracks}


def _clips_by_track(ws) -> dict[str, int]:
    out: dict[str, int] = {}
    for clip in ws.project.clips:
        out[clip.track_id] = out.get(clip.track_id, 0) + 1
    return out


def _rows(ws) -> list[dict]:
    """The guests' rows (the host's own row is checked on its own)."""
    return [m for m in RecordControlService(ws).tracks()["participants"] if m["role"] == "guest"]


def _by_pid(ws) -> dict[str, dict]:
    return {m["participant_id"]: m for m in _rows(ws)}


def test_names_compare_without_case_accents_or_extra_spaces() -> None:
    assert normalize_name("  José   Núñez ") == normalize_name("jose nunez")
    assert normalize_name("Ava") != normalize_name("Eva")
    assert normalize_name("") == ""


def test_a_returning_guest_lands_on_their_session_1_track_with_cuts_intact(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["José"], land=True)
    ws.reload()
    [first_track] = [t for t in _tracks(ws) if t.startswith("p_") and t != "p_host"]
    assert _tracks(ws)[first_track] == "José"
    first_clips = [c.model_dump() for c in ws.project.clips if c.track_id == first_track]

    room, [pid] = _room(ws, ["  JOSE "])
    [row] = _rows(ws)
    assert (row["status"], row["track_id"], row["reason"]) == ("matched", first_track, "name")
    assert "returns" in row["message"] and "José" in row["message"]
    RecordLandingService(ws).land(align=lambda _p: None)

    ws.reload()
    assert set(t for t in _tracks(ws) if t.startswith("p_")) == {first_track}
    assert _tracks(ws)[first_track] == "José"
    assert _clips_by_track(ws)[first_track] == 2
    assert (
        next(c.model_dump() for c in ws.project.clips if c.track_id == first_track)
        == first_clips[0]
    )
    src = ws.project.source_by_id(f"rec-{room['session_id']}-0-{pid}-0")
    assert src is not None and src.speaker == "José"
    # Session 2 starts after Session 1 on the same track.
    starts = sorted(c.timeline_start for c in ws.project.clips if c.track_id == first_track)
    assert starts[1] > starts[0]


def test_session_2_lands_at_the_end_with_session_1_cuts_intact(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.edits.ripple import ripple_remove_clips, ripple_track_ids

    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    ws.mutate(
        "cut",
        "cut",
        lambda p: ripple_remove_clips(
            p, [(0.1, 0.3)], ripple_track_ids(p), defaults=ws.effective_config()
        ),
    )
    ws.reload()
    [ava_track] = [t for t, label in _tracks(ws).items() if label == "Ava"]
    before = [
        (c.id, c.source_start, c.source_end, c.timeline_start)
        for c in ws.project.clips
        if c.track_id == ava_track
    ]
    end_s = max(c.timeline_start + (c.source_end - c.source_start) for c in ws.project.clips)
    _room(ws, ["ava"], land=True)
    ws.reload()
    after = [
        (c.id, c.source_start, c.source_end, c.timeline_start)
        for c in ws.project.clips
        if c.track_id == ava_track
    ]
    assert len(after) == len(before) + 1 and all(row in after for row in before)
    new = [row for row in after if row not in before]
    assert new[0][3] >= end_s - 1e-6  # Session 2 starts at the end of Session 1


def test_a_new_person_gets_a_new_track(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    _room(ws, ["Ben"])
    [row] = _rows(ws)
    assert (row["status"], row["reason"]) == ("new", "new")
    RecordLandingService(ws).land(align=lambda _p: None)
    labels = sorted(label for tid, label in _tracks(ws).items() if tid.startswith("p_"))
    assert labels == ["Ava", "Ben"]


def test_two_people_sharing_a_name_are_not_merged_with_each_other_or_a_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    _room(ws, ["Ava", "ava"])
    rows = _by_pid(ws)
    assert len(rows) == 2 and {r["status"] for r in rows.values()} == {"ambiguous"}
    assert all(r["reason"] == "duplicate_name" for r in rows.values())
    assert all("called ava" in r["message"].lower() for r in rows.values())
    RecordLandingService(ws).land(align=lambda _p: None)
    tracks = [t for t in _tracks(ws) if t.startswith("p_")]
    assert len(tracks) == 3  # session 1's Ava plus one new track each


def test_two_existing_tracks_with_one_name_are_ambiguous(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    ws.mutate(
        "second ava",
        "second ava",
        lambda p: p.tracks.append(Track(id="ava2", label="AVA", role=TrackRole.DIALOGUE)),
    )
    _room(ws, ["Ava"])
    [row] = _rows(ws)
    assert (row["status"], row["reason"]) == ("ambiguous", "several_tracks")
    assert len(row["candidates"]) == 2


def test_the_host_keeps_their_own_track(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)

    def seed(p) -> None:
        p.tracks.append(Track(id="p_host", label="Caleb", role=TrackRole.DIALOGUE))
        p.clips.append(
            Clip(
                id="h1",
                track_id="p_host",
                source_id="src-h",
                source_start=0.0,
                source_end=2.0,
                timeline_start=0.0,
            )
        )

    ws.mutate("host", "host", seed)
    _room(ws, ["Ben"])
    rows = {r["participant_id"]: r for r in RecordControlService(ws).tracks()["participants"]}
    assert (rows["p_host"]["status"], rows["p_host"]["reason"]) == ("matched", "own_track")
    assert rows["p_host"]["track_label"] == "Caleb"


def test_the_host_can_move_a_person_before_landing(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    _room(ws, ["Eva"])
    ctrl = RecordControlService(ws)
    [pid] = list(_by_pid(ws))
    [ava_track] = [t for t, label in _tracks(ws).items() if label == "Ava"]
    steps = len(HistoryService(ws).list_entries().groups)

    moved = ctrl.assign_track(pid, ava_track)
    assert (moved["status"], moved["track_id"], moved["reason"], moved["changed"]) == (
        "matched",
        ava_track,
        "host_choice",
        True,
    )
    assert len(HistoryService(ws).list_entries().groups) == steps  # nothing in the project yet
    assert ctrl.assign_track(pid, ava_track)["changed"] is False
    RecordLandingService(ws).land(align=lambda _p: None)
    assert _clips_by_track(ws)[ava_track] == 2

    ws2 = _seed_again(minimal_project, sample_wav)
    _room(ws2, ["Ava"], land=True)
    _room(ws2, ["Ava"])
    c2 = RecordControlService(ws2)
    [pid2] = list(_by_pid(ws2))
    forced = c2.assign_track(pid2, "new")
    assert (forced["status"], forced["reason"]) == ("new", "host_choice")
    RecordLandingService(ws2).land(align=lambda _p: None)
    assert len([t for t in _tracks(ws2) if t.startswith("p_")]) == 2


def _seed_again(minimal_project, sample_wav):
    """A clean project of the same shape (the first test project is spent)."""
    from podcast_mcp.models import EpisodeProject

    proj = EpisodeProject.create("test_episode_b", str(minimal_project.parent / "b"))
    proj.ensure_dirs()
    path = save_project(proj)
    return _seed(path, sample_wav)


def test_moving_a_staged_person_is_one_undo_step_and_undoes(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    [ava_track] = [t for t, label in _tracks(ws).items() if label == "Ava"]
    room, [pid] = _room(ws, ["ava"], target=INSERT, land=True)
    ws.reload()
    sid = f"ss-{room['session_id']}"
    staged = next(s for s in ws.project.editorial.session_suggestions if s.id == sid)
    assert [t.track_id for t in staged.takes] == [ava_track]

    ctrl = RecordControlService(ws)
    steps = len(HistoryService(ws).list_entries().groups)
    out = ctrl.assign_track(pid, "new")
    assert (out["status"], out["track_id"]) == ("new", pid)
    ws.reload()
    staged = next(s for s in ws.project.editorial.session_suggestions if s.id == sid)
    assert [(t.track_id, t.track_label) for t in staged.takes] == [(pid, "ava")]
    assert ws.project.source_by_id(staged.takes[0].source_id).speaker == "ava"
    groups = HistoryService(ws).list_entries().groups
    assert len(groups) == steps + 1
    assert groups[-1].title.endswith("Moved ava to ava")

    HistoryService(ws).undo()
    ws.reload()
    staged = next(s for s in ws.project.editorial.session_suggestions if s.id == sid)
    assert [t.track_id for t in staged.takes] == [ava_track]
    # The staged takes are the truth after the undo, even though the host's choice stays stored.
    assert _by_pid(ws)[pid]["reason"] == "held"

    ctrl.assign_track(pid, "new")
    SessionSuggestionService(ws).accept(sid)
    ws.reload()
    assert _clips_by_track(ws)[pid] == 1 and _clips_by_track(ws)[ava_track] == 1


def test_refusals_are_plain_and_coded(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    [ava_track] = [t for t, label in _tracks(ws).items() if label == "Ava"]
    room, [ben, cat] = _room(ws, ["Ben", "Ava"], target=INSERT, land=True)
    ctrl = RecordControlService(ws)

    def refusal(pid: str, track: str) -> CodedError:
        with pytest.raises(CodedError) as caught:
            ctrl.assign_track(pid, track)
        return caught.value

    assert refusal("p_nobody", "new").code == "unknown_participant"
    unknown = refusal(ben, "nope")
    assert unknown.code == "unknown_track" and 'or "new"' in str(unknown)
    taken = refusal(ben, ava_track)  # Cat (Ava) is matched to it
    assert taken.code == "track_taken" and "Ava" in str(taken)

    SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    done = refusal(ben, "new")
    assert done.code == "session_already_accepted" and "already been accepted" in str(done)
    assert cat in _by_pid(ws)


def test_a_session_already_on_the_timeline_cannot_be_moved(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    _room2, [pid] = _room(ws, ["Ben"], land=True)
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(pid, "new")
    assert caught.value.code == "session_already_accepted"
    assert "already on the timeline" in str(caught.value)


def test_a_skipped_session_has_nothing_to_move(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    room, [pid] = _room(ws, ["Ben"], target=INSERT, land=True)
    SessionSuggestionService(ws).skip(f"ss-{room['session_id']}")
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(pid, "new")
    assert caught.value.code == "session_skipped"


def test_another_pending_sessions_new_person_can_be_returned_to(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ben"], target=INSERT, land=True)
    _room(ws, ["ben"], target={"kind": "insert", "at_sec": 2.0})
    [row] = _rows(ws)
    assert row["status"] == "matched" and row["reason"] == "name"


def test_surfaces_are_host_only_and_guests_never_see_it(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    room, [pid] = _room(ws, ["Ava"])
    [ava_track] = [t for t, label in _tracks(ws).items() if label == "Ava"]
    path = str(minimal_project)

    cli = CliRunner()
    listed = cli.invoke(cli_app, ["record", "tracks", "--project", path])
    assert listed.exit_code == 0, listed.output
    assert json.loads(listed.output)["participants"][0]["track_id"] == ava_track
    bad = cli.invoke(
        cli_app, ["record", "assign-track", "--project", path, "--participant", pid, "--track", "x"]
    )
    assert bad.exit_code == 1 and "nknown track" in bad.output + (bad.stderr or "")
    ok = cli.invoke(
        cli_app,
        ["record", "assign-track", "--project", path, "--participant", pid, "--track", "new"],
    )
    assert ok.exit_code == 0 and json.loads(ok.output)["status"] == "new"

    assert json.loads(record_tracks_tool(path))["participants"][0]["reason"] == "host_choice"
    assert json.loads(record_assign_track_tool(path, pid, ava_track))["status"] == "matched"

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    client = TestClient(create_app())
    res = client.get("/api/record/tracks", params={"path": path})
    assert res.status_code == 200, res.text
    assert res.json()["participants"][0]["participant_id"] == pid
    res = client.post(
        "/api/record/assign-track", json={"path": path, "participant_id": pid, "track": "zzz"}
    )
    assert res.status_code == 404 and res.headers["X-Sharecut-Error-Code"] == "unknown_track"
    res = client.post(
        "/api/record/assign-track", json={"path": path, "participant_id": "p_x", "track": "new"}
    )
    assert res.status_code == 404 and res.headers["X-Sharecut-Error-Code"] == "unknown_participant"

    # Nothing about tracks reaches the room snapshot a guest is given.
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    assert "track" not in json.dumps(svc.snapshot()).replace("track_ids", "")
    ws.reload()
    assert "host_choice" not in json.dumps(svc.snapshot())


def _person(pid: str, name: str, *, removed: bool = False):
    from podcast_mcp.services.record.state import ParticipantState

    return ParticipantState(
        participant_id=pid, role="guest", display_name=name, joined_wall_ms=0, removed=removed
    )


def _sam_project(ws) -> str:
    """Session 1 left a track 'sam' labelled Sam with audio on it."""

    def seed(p) -> None:
        p.tracks.append(Track(id="sam", label="Sam", role=TrackRole.DIALOGUE))
        p.clips.append(
            Clip(
                id="s1",
                track_id="sam",
                source_id="src-s",
                source_start=0.0,
                source_end=2.0,
                timeline_start=0.0,
            )
        )

    ws.mutate("sam", "sam", seed)
    return "sam"


def test_a_renamed_host_and_a_guest_with_the_hosts_old_name_do_not_share_a_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)

    def seed(p) -> None:
        p.tracks.append(Track(id="p_host", label="Caleb", role=TrackRole.DIALOGUE))
        p.clips.append(
            Clip(
                id="h1",
                track_id="p_host",
                source_id="src-h",
                source_start=0.0,
                source_end=2.0,
                timeline_start=0.0,
            )
        )

    ws.mutate("host", "host", seed)
    _room(ws, ["Caleb"])
    rows = {r["display_name"]: r for r in RecordControlService(ws).tracks()["participants"]}
    assert rows["Host"]["track_id"] == "p_host"
    guest = rows["Caleb"]
    assert (guest["status"], guest["reason"]) == ("ambiguous", "track_in_use")
    assert guest["track_id"] != "p_host" and "already used by someone else" in guest["message"]
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    on_host = {c.source_id for c in ws.project.clips if c.track_id == "p_host"}
    assert not any("rec-" in (s or "") for s in on_host)


def test_a_host_choice_keeps_its_track_when_a_same_named_guest_joins_later(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    sam = _sam_project(ws)
    room, [alex] = _room(ws, ["Alex"])
    RecordControlService(ws).assign_track(alex, sam)
    late = _late_guest(ws, room, "sam")
    rows = _by_pid(ws)
    assert rows[alex]["track_id"] == sam
    assert (rows[late]["status"], rows[late]["reason"]) == ("ambiguous", "track_in_use")
    assert rows[late]["track_id"] not in (sam, alex)


def test_staged_takes_keep_their_track_against_a_late_same_named_joiner(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    sam = _sam_project(ws)
    room, [first] = _room(ws, ["Sam"], target=INSERT, land=True)
    late = _late_guest(ws, room, "SAM")
    rows = _by_pid(ws)
    assert (rows[first]["track_id"], rows[first]["reason"]) == (sam, "held")
    assert rows[late]["status"] == "ambiguous" and rows[late]["track_id"] != sam


def test_removed_people_do_not_make_a_name_ambiguous() -> None:
    from podcast_mcp.models import EpisodeProject
    from podcast_mcp.services.record.track_match import resolve_session_tracks

    project = EpisodeProject.create("t", "/tmp/never-written")
    people = [_person("p_a", "Ava", removed=True), _person("p_b", "ava")]
    out = resolve_session_tracks(project, "s" * 12, people, {})
    assert out["p_b"].status == "new"


def test_two_same_named_people_with_no_track_yet_are_ambiguous_each_on_their_own() -> None:
    from podcast_mcp.models import EpisodeProject
    from podcast_mcp.services.record.track_match import resolve_session_tracks

    project = EpisodeProject.create("t", "/tmp/never-written")
    out = resolve_session_tracks(
        project, "s" * 12, [_person("p_a", "Ava"), _person("p_b", "ava")], {}
    )
    assert {m.status for m in out.values()} == {"ambiguous"}
    assert out["p_a"].track_id != out["p_b"].track_id


def test_a_blank_name_reads_cleanly() -> None:
    from podcast_mcp.models import EpisodeProject
    from podcast_mcp.services.record.track_match import resolve_session_tracks

    project = EpisodeProject.create("t", "/tmp/never-written")
    [m] = resolve_session_tracks(project, "s" * 12, [_person("p_a", "")], {}).values()
    assert m.message == "This person is new here, so they get a new track."


def test_the_host_can_pin_a_match_and_dismiss_an_ambiguous_flag(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    sam = _sam_project(ws)
    room, [first] = _room(ws, ["Sam"])
    ctrl = RecordControlService(ws)
    out = ctrl.assign_track(first, sam)  # already matched there: pins, changes nothing
    assert out["changed"] is False
    store = RecordSessionService(ws.project, session_id=room["session_id"])
    assert store.track_choices() == {first: sam}
    late = _late_guest(ws, room, "sam")
    assert _by_pid(ws)[first]["track_id"] == sam  # the pin holds
    assert _by_pid(ws)[late]["status"] == "ambiguous"
    dismissed = ctrl.assign_track(late, "new")
    assert dismissed["changed"] is False and dismissed["status"] == "new"
    assert store.track_choices()[late] == late


def test_a_choice_for_a_deleted_track_is_worked_out_again(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    sam = _sam_project(ws)
    _, [eva] = _room(ws, ["Eva"])
    RecordControlService(ws).assign_track(eva, sam)
    ws.mutate(
        "drop",
        "drop",
        lambda p: (
            p.tracks.remove(p.track_by_id(sam)),
            p.clips.__setitem__(slice(None), [c for c in p.clips if c.track_id != sam]),
        ),
    )
    [row] = _rows(ws)
    assert row["track_id"] == eva and row["status"] == "new"
    assert "is gone" in row["message"]
    RecordLandingService(ws).land(align=lambda _p: None)
    assert sam not in _tracks(ws)


def test_undoing_a_staged_move_and_the_staging_land_leaves_the_name_match(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    sam = _sam_project(ws)
    _room_, [pid] = _room(ws, ["Sam"], target=INSERT, land=True)
    RecordControlService(ws).assign_track(pid, "new")
    assert RecordSessionService(ws.project, session_id=_room_["session_id"]).track_choices() == {}
    HistoryService(ws).undo()  # the move
    HistoryService(ws).undo()  # the staging land
    ws.reload()
    RecordLandingService(ws).land(align=lambda _p: None)
    [row] = _rows(ws)
    assert (row["track_id"], row["reason"]) == (sam, "held")


def _replace_setup(ws):
    """Ava is on track A and Ben on track B from Session 1; Session 2 replaces Ava's range."""
    _room(ws, ["Ava", "Ben"], land=True)
    labels = _tracks(ws)
    track_a = next(t for t, label in labels.items() if label == "Ava")
    track_b = next(t for t, label in labels.items() if label == "Ben")
    target = {"kind": "replace", "from_sec": 0.1, "to_sec": 0.3, "track_ids": [track_a]}
    return track_a, track_b, target


def test_moving_a_replaced_person_keeps_the_replace_target_acceptable(
    minimal_project, sample_wav, tmp_workspace
):
    for destination in ("new", "other"):
        ws = (
            _seed(minimal_project, sample_wav)
            if destination == "new"
            else _seed_again(minimal_project, sample_wav)
        )
        _track_a, track_b, target = _replace_setup(ws)
        room, [pid] = _room(ws, ["Ava"], target=target, land=True)
        sid = f"ss-{room['session_id']}"
        dest = "new" if destination == "new" else track_b
        steps = len(HistoryService(ws).list_entries().groups)
        RecordControlService(ws).assign_track(pid, dest)
        assert len(HistoryService(ws).list_entries().groups) == steps + 1
        ws.reload()
        row = next(s for s in ws.project.editorial.session_suggestions if s.id == sid)
        moved_to = pid if dest == "new" else track_b
        assert row.track_ids == [moved_to]
        SessionSuggestionService(ws).accept(sid)  # no track_not_recorded


def test_a_replace_room_refuses_to_move_the_replaced_person_before_staging(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _track_a, _track_b, target = _replace_setup(ws)
    _room(ws, ["Ava"], target=target)
    [row] = _rows(ws)
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(row["participant_id"], "new")
    assert caught.value.code == "replace_target_track"


def test_new_routes_refuse_a_relayed_request_and_answer_409_for_refusals(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava", "Ben"], land=True)
    room, [ava, ben] = _room(ws, ["Ava", "Ben"], target=INSERT, land=True)
    path = str(minimal_project)
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    client = TestClient(create_app())
    code = "X-Sharecut-Error-Code"
    relayed = {"X-Sharecut-Relayed": "1"}
    res = client.get("/api/record/tracks", params={"path": path}, headers=relayed)
    assert res.status_code == 403 and res.headers[code] == "authz_denied"
    body = {"path": path, "participant_id": ava, "track": "new"}
    res = client.post("/api/record/assign-track", json=body, headers=relayed)
    assert res.status_code == 403 and res.headers[code] == "authz_denied"

    rows = {
        r["participant_id"]: r
        for r in client.get("/api/record/tracks", params={"path": path}).json()["participants"]
    }
    taken = {**body, "track": rows[ben]["track_id"]}
    res = client.post("/api/record/assign-track", json=taken)
    assert res.status_code == 409 and res.headers[code] == "track_taken"
    SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    res = client.post("/api/record/assign-track", json=body)
    assert res.status_code == 409 and res.headers[code] == "session_already_accepted"


def test_a_skipped_session_answers_409_over_the_route(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    room, [pid] = _room(ws, ["Ben"], target=INSERT, land=True)
    SessionSuggestionService(ws).skip(f"ss-{room['session_id']}")
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    res = TestClient(create_app()).post(
        "/api/record/assign-track",
        json={"path": str(minimal_project), "participant_id": pid, "track": "new"},
    )
    assert res.status_code == 409 and res.headers["X-Sharecut-Error-Code"] == "session_skipped"


def test_accepting_before_assign_acquires_the_project_lock_refuses_the_move(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    room, [pid] = _room(ws, ["Ava"], target=INSERT, land=True)
    suggestion_id = f"ss-{room['session_id']}"
    accepting_ws = ProjectWorkspace.open(minimal_project)
    transaction = ws.transaction
    accepted = []

    @contextmanager
    def accept_before_lock(**kwargs):
        if not accepted:
            SessionSuggestionService(accepting_ws).accept(suggestion_id)
            accepting_ws.reload()
            suggestion = next(
                s
                for s in accepting_ws.project.editorial.session_suggestions
                if s.id == suggestion_id
            )
            assert suggestion.status == "accepted"
            accepted.append(
                (
                    accepting_ws.project.model_dump(mode="json"),
                    HistoryService(accepting_ws).list_entries().model_dump(mode="json"),
                )
            )
        with transaction(**kwargs) as project:
            yield project

    monkeypatch.setattr(ws, "transaction", accept_before_lock)
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(pid, "new")
    assert caught.value.code == "session_already_accepted"
    assert len(accepted) == 1
    ws.reload()
    project_before, history_before = accepted[0]
    assert ws.project.model_dump(mode="json") == project_before
    assert HistoryService(ws).list_entries().model_dump(mode="json") == history_before


def test_a_removed_person_with_no_takes_does_not_block_a_live_same_named_person() -> None:
    from podcast_mcp.models import EpisodeProject
    from podcast_mcp.services.record.track_match import resolve_session_tracks

    project = EpisodeProject.create("t", "/tmp/never-written")
    project.tracks.append(Track(id="ava_t", label="Ava", role=TrackRole.DIALOGUE))
    gone = _person("p_a", "Ava", removed=True)
    live = _person("p_b", "ava")
    for people in ([gone, live], [live, gone]):
        out = resolve_session_tracks(project, "s" * 12, people, {})
        assert (out["p_b"].status, out["p_b"].track_id) == ("matched", "ava_t")
        assert out["p_a"].track_id != "ava_t"
    # A stale host choice on the removed person does not outrank the live one either.
    out = resolve_session_tracks(project, "s" * 12, [gone, live], {"p_a": "ava_t"})
    assert out["p_b"].track_id == "ava_t" and out["p_a"].track_id != "ava_t"


def _hook_mid_land(monkeypatch, action) -> None:
    """Run ``action`` once, while the first recording is being copied (before the project lock)."""
    from podcast_mcp.services.record import landing

    real = landing._copy_into_raw
    done: list[bool] = []

    def hooked(*args, **kwargs):
        if not done:
            done.append(True)
            action()
        return real(*args, **kwargs)

    monkeypatch.setattr(landing, "_copy_into_raw", hooked)


def test_an_assign_made_while_a_land_is_copying_is_honoured(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    sam = _sam_project(ws)
    _, [pid] = _room(ws, ["Sam"])
    other = ProjectWorkspace.open(minimal_project)
    _hook_mid_land(monkeypatch, lambda: RecordControlService(other).assign_track(pid, "new"))
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    mine = {c.track_id for c in ws.project.clips if (c.source_id or "").startswith("rec-")}
    assert mine == {pid}
    assert sam in _tracks(ws) and sam not in mine


def test_a_staged_persons_later_take_follows_a_move_made_mid_land(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    sam = _sam_project(ws)
    room, [pid] = _room(ws, ["Sam"], target=INSERT, land=True)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    svc.submit(_cmd("Start"), now_wall_ms=10_000)
    svc.submit(_cmd("Stop"), now_wall_ms=13_000)
    _ack(ws, room, pid, 1)
    other = ProjectWorkspace.open(minimal_project)
    _hook_mid_land(monkeypatch, lambda: RecordControlService(other).assign_track(pid, "new"))
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    row = next(
        s for s in ws.project.editorial.session_suggestions if s.session_id == room["session_id"]
    )
    assert sorted((t.take_index, t.track_id) for t in row.takes) == [(0, pid), (1, pid)]
    assert sam not in {t.track_id for t in row.takes}


def test_moving_a_person_who_has_only_a_staged_bed_does_not_stage_it_twice(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.services.record.landing import room_tone_raw_rel

    ws = _seed(minimal_project, sample_wav)
    sam = _sam_project(ws)
    room, [pid] = _room(ws, ["Sam"], target=INSERT)
    sid = room["session_id"]
    rel = room_tone_raw_rel(sid, pid)
    bed = Path(ws.project.workspace_dir) / rel
    bed.parent.mkdir(parents=True, exist_ok=True)
    bed.write_bytes(Path(sample_wav).read_bytes())

    def stage_bed(p) -> None:
        from podcast_mcp.models import SessionSuggestion, StagedRoomTone

        p.editorial.session_suggestions.append(
            SessionSuggestion(
                id=f"ss-{sid}",
                kind="insert",
                session_id=sid,
                session_number=2,
                at_sec=1.0,
                room_tone=[
                    StagedRoomTone(
                        track_id=sam,
                        track_label="Sam",
                        source_id=f"room-tone-{sam}",
                        path=rel,
                        duration_s=2.0,
                        sample_rate=48000,
                        channels=1,
                    )
                ],
            )
        )

    ws.mutate("bed", "bed", stage_bed)
    assert _by_pid(ws)[pid]["reason"] == "held"  # the bed alone holds them on sam
    RecordControlService(ws).assign_track(pid, "new")
    ws.reload()
    row = next(s for s in ws.project.editorial.session_suggestions if s.id == f"ss-{sid}")
    assert [b.track_id for b in row.room_tone] == [pid]
    assert _by_pid(ws)[pid]["track_id"] == pid


def test_moving_a_replaced_person_says_the_replace_follows_them(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _track_a, track_b, target = _replace_setup(ws)
    _, [pid] = _room(ws, ["Ava"], target=target, land=True)
    out = RecordControlService(ws).assign_track(pid, track_b)
    assert 'now covers "Ben" instead of "Ava"' in out["note"]


def test_host_choice_wording_says_moved_or_kept(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    sam = _sam_project(ws)
    _, [pid] = _room(ws, ["Sam"])
    ctrl = RecordControlService(ws)
    assert ctrl.assign_track(pid, sam)["message"].startswith("You kept Sam on")
    assert ctrl.assign_track(pid, "new")["message"].startswith("You moved Sam to")


def test_replace_target_track_is_a_409_over_the_route(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    _a, _b, target = _replace_setup(ws)
    _room(ws, ["Ava"], target=target)
    [row] = _rows(ws)
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    res = TestClient(create_app()).post(
        "/api/record/assign-track",
        json={
            "path": str(minimal_project),
            "participant_id": row["participant_id"],
            "track": "new",
        },
    )
    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "replace_target_track"


def _remove(ws, room, pid: str) -> None:
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    svc.submit(_cmd("RemoveParticipant", payload={"participant_id": pid}), now_wall_ms=4_000)


def _accept_code(ws, sid: str) -> str | None:
    """The refusal code Accept gives, or None when it gets past the track checks."""
    try:
        SessionSuggestionService(ws).accept(sid)
    except CodedError as exc:
        return exc.code
    return None


def test_assigning_a_removed_person_with_an_acked_take_is_refused(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _sam_project(ws)
    room, [pid] = _room(ws, ["Sam"])
    _remove(ws, room, pid)
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(pid, "new")
    assert caught.value.code == "person_removed"


def test_a_person_with_a_placed_bed_cannot_be_moved_to_land_it_twice(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    sam = _sam_project(ws)
    room = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    pid = _join_guest(svc, room, "Sam", 0)
    pcm = bytes(48_000 * 2)
    wav = pcm_wav_header(len(pcm)) + pcm
    RecordUploadService(ws.project).ingest_part(
        session_id=room["session_id"], take_index=0, participant_id=pid, segment_index=0,
        part_seq=0, data=pcm, digest=sha256_hex(pcm), file_sha256=sha256_hex(wav),
        final=True, kind="room_tone",
    )  # fmt: skip
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    assert ws.project.track_by_id(sam).room_tone is not None
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(pid, "new")
    assert caught.value.code == "session_already_accepted"


def test_the_replace_note_never_says_a_track_instead_of_itself(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _track_a, _track_b, target = _replace_setup(ws)
    _, [pid] = _room(ws, ["Ava"], target=target, land=True)
    note = RecordControlService(ws).assign_track(pid, "new")["note"]
    assert 'covers "Ava" instead of "Ava"' not in note
    assert 'now covers "Ava" on its new track; it follows Ava.' in note


def test_a_replace_cannot_be_moved_onto_another_track_it_already_covers(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track_a, track_b, _t = _replace_setup(ws)
    target = {"kind": "replace", "from_sec": 0.1, "to_sec": 0.3, "track_ids": [track_a, track_b]}
    room, [pid] = _room(ws, ["Ava"], target=target, land=True)
    sid = f"ss-{room['session_id']}"
    assert _accept_code(ws, sid) == "track_not_recorded"
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(pid, track_b)
    assert caught.value.code == "replace_target_track"
    ws.reload()
    row = next(s for s in ws.project.editorial.session_suggestions if s.id == sid)
    assert len(row.track_ids) == 2


def _late_replace_room(ws, target, *, land: bool = True, late: str = "Ava"):
    """Ben records take 0; Ava joins late and records only take 1 (both takes staged)."""
    room = ShareService(ws).create_record_room(target=target)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    ben = _join_guest(svc, room, "Ben", 0)
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    _ack(ws, room, ben, 0)
    ava = _join_guest(svc, room, late, 1)
    svc.submit(_cmd("Start"), now_wall_ms=10_000)
    svc.submit(_cmd("Stop"), now_wall_ms=13_000)
    _ack(ws, room, ben, 1)
    _ack(ws, room, ava, 1)
    if land:
        RecordLandingService(ws).land(align=lambda _p: None)
    return room, ava, ben


def _row(ws, room):
    ws.reload()
    return next(
        s for s in ws.project.editorial.session_suggestions if s.id == f"ss-{room['session_id']}"
    )


def test_discarding_a_moved_replace_persons_last_take_restores_the_follow(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track_a, _track_b, target = _replace_setup(ws)
    room, ava, _ben = _late_replace_room(ws, target)
    RecordControlService(ws).assign_track(ava, "new")
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([ava], {ava: track_a})
    RecordControlService(ws).discard_take(1)
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([track_a], {})


def test_a_moved_replace_person_who_rerecords_after_the_discard_can_be_accepted(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _track_a, _track_b, target = _replace_setup(ws)
    room, ava, ben = _late_replace_room(ws, target)
    RecordControlService(ws).assign_track(ava, "new")
    RecordControlService(ws).discard_take(1)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    svc.submit(_cmd("Start"), now_wall_ms=20_000)
    svc.submit(_cmd("Stop"), now_wall_ms=23_000)
    _ack(ws, room, ben, 2)
    _ack(ws, room, ava, 2)
    RecordLandingService(ws).land(align=lambda _p: None)
    assert _accept_code(ws, f"ss-{room['session_id']}") is None


def test_undo_and_redo_of_the_discard_round_trip_the_follow(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track_a, _track_b, target = _replace_setup(ws)
    room, ava, _ben = _late_replace_room(ws, target)
    RecordControlService(ws).assign_track(ava, "new")
    RecordControlService(ws).discard_take(1)
    history = HistoryService(ws)
    history.undo()
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([ava], {ava: track_a})
    history.redo()
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([track_a], {})
    history.undo()
    history.undo()
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([track_a], {})


def test_the_replace_is_not_pointed_back_at_a_track_someone_else_now_holds(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track_a, _track_b, target = _replace_setup(ws)
    room, ava, ben = _late_replace_room(ws, target)
    RecordControlService(ws).assign_track(ava, "new")
    RecordControlService(ws).assign_track(ben, track_a)
    RecordControlService(ws).discard_take(1)
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([ava], {ava: track_a})
    with pytest.raises(CodedError) as caught:
        SessionSuggestionService(ws).accept(row.id)
    assert caught.value.code == "track_not_recorded"
    assert '"Ava"' in str(caught.value)
    assert "p_" not in str(caught.value)


def test_track_not_recorded_names_labels(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    track_a, track_b, _t = _replace_setup(ws)
    target = {"kind": "replace", "from_sec": 0.1, "to_sec": 0.3, "track_ids": [track_a, track_b]}
    room, _pids = _room(ws, ["Ava"], target=target, land=True)
    with pytest.raises(CodedError) as caught:
        SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert caught.value.code == "track_not_recorded"
    assert '"Ben"' in str(caught.value)
    assert track_b not in str(caught.value)


def test_a_bed_keeps_a_moved_replace_person_on_the_new_track(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.models import StagedRoomTone

    ws = _seed(minimal_project, sample_wav)
    track_a, _track_b, target = _replace_setup(ws)
    room, ava, _ben = _late_replace_room(ws, target)
    RecordControlService(ws).assign_track(ava, "new")

    def stage_bed(p) -> None:
        row = next(s for s in p.editorial.session_suggestions if s.session_id == room["session_id"])
        row.room_tone.append(
            StagedRoomTone(
                track_id=ava,
                track_label="Ava",
                source_id=f"room-tone-{ava}",
                path=f"raw/room-tone/{room['session_id']}/{ava}.wav",
                duration_s=2.0,
                sample_rate=48000,
                channels=1,
            )
        )

    ws.mutate("bed", "bed", stage_bed)
    RecordControlService(ws).discard_take(1)
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([ava], {ava: track_a})


def test_track_follows_chain_and_move_back(tmp_path):
    from podcast_mcp.edits.session_track_remap import remap_staged_participant
    from podcast_mcp.models import EpisodeProject, SessionSuggestion

    project = EpisodeProject.create("chain_unit", str(tmp_path / "chain_unit"))
    row = SessionSuggestion(
        id="ss-s1", kind="replace", session_id="s1", session_number=2, track_ids=["ta"]
    )
    project.editorial.session_suggestions.append(row)

    def move(old: str, new: str) -> None:
        remap_staged_participant(
            project, "ss-s1", source_ids=set(), bed_path="x", track_id=new, track_label="Ava",
            old_track_id=old,
        )  # fmt: skip

    move("ta", "tb")
    assert (row.track_ids, row.track_follows) == (["tb"], {"tb": "ta"})
    move("tb", "tc")
    assert (row.track_ids, row.track_follows) == (["tc"], {"tc": "ta"})
    move("tc", "ta")
    assert (row.track_ids, row.track_follows) == (["ta"], {})


def test_restore_followed_tracks_ignores_a_row_without_follows_and_handles_dropped_segments(
    tmp_path,
):
    from podcast_mcp.edits.session_suggestions import (
        drop_staged_segment,
        restore_followed_tracks,
    )
    from podcast_mcp.models import EpisodeProject, SessionSuggestion, StagedTake

    project = EpisodeProject.create("restore_unit", str(tmp_path / "restore_unit"))
    row = SessionSuggestion(
        id="ss-s1", kind="replace", session_id="s1", session_number=2, track_ids=["tb"]
    )
    project.editorial.session_suggestions.append(row)
    restore_followed_tracks(project, "s1")
    assert row.track_ids == ["tb"]
    row.track_follows = {"tb": "ta"}
    row.takes.append(
        StagedTake(
            take_index=0,
            segment_index=0,
            source_id="rec-s1-0-p-0",
            track_id="tb",
            track_label="Ava",
            offset_s=0.0,
            duration_s=1.0,
        )
    )
    restore_followed_tracks(project, "s1")
    assert (row.track_ids, row.track_follows) == (["tb"], {"tb": "ta"})
    row.takes.append(
        StagedTake(
            take_index=0,
            segment_index=0,
            source_id="rec-s1-0-q-0",
            track_id="tc",
            track_label="Ben",
            offset_s=0.0,
            duration_s=1.0,
        )
    )
    drop_staged_segment(project, "s1", "rec-s1-0-p-0")
    restore_followed_tracks(project, "s1")
    assert (row.track_ids, row.track_follows) == (["ta"], {})


def _bed_only(ws, room, pid: str) -> None:
    pcm = bytes(48_000 * 2)
    wav = pcm_wav_header(len(pcm)) + pcm
    RecordUploadService(ws.project).ingest_part(
        session_id=room["session_id"], take_index=0, participant_id=pid, segment_index=0,
        part_seq=0, data=pcm, digest=sha256_hex(pcm), file_sha256=sha256_hex(wav),
        final=True, kind="room_tone",
    )  # fmt: skip


def test_a_removed_persons_bed_only_recording_does_not_make_the_next_ava_ambiguous(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava"], land=True)
    room = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    gone = _join_guest(svc, room, "Ava", 0)
    _join_guest(svc, room, "Ava", 1)
    _bed_only(ws, room, gone)
    _remove(ws, room, gone)
    RecordLandingService(ws).land(align=lambda _p: None)
    _room(ws, ["Ava"])
    assert "several_tracks" not in {r["reason"] for r in _rows(ws)}


def test_a_removed_persons_bed_only_recording_creates_no_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    gone = _join_guest(svc, room, "Sam", 0)
    _bed_only(ws, room, gone)
    _remove(ws, room, gone)
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    assert [t.id for t in ws.project.tracks if t.room_tone is not None] == []
    assert gone not in {t.id for t in ws.project.tracks}


def test_a_removed_person_with_a_take_still_lands_their_bed(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    room, [pid] = _room(ws, ["Sam"])
    _bed_only(ws, room, pid)
    _remove(ws, room, pid)
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    track = next(t for t in ws.project.tracks if t.label == "Sam")
    assert track.room_tone is not None


def test_the_replace_is_not_pointed_back_at_a_track_someone_holds_by_choice(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track_a, _track_b, target = _replace_setup(ws)
    room, ava, _ben = _late_replace_room(ws, target)
    RecordControlService(ws).assign_track(ava, "new")
    cy = _late_guest(ws, room, "Cy")
    RecordControlService(ws).assign_track(cy, track_a)
    RecordControlService(ws).discard_take(1)
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([ava], {ava: track_a})


def test_restore_followed_tracks_skips_contested_tracks_and_untouched_follows(tmp_path):
    from podcast_mcp.edits.session_suggestions import restore_followed_tracks
    from podcast_mcp.models import EpisodeProject, SessionSuggestion

    project = EpisodeProject.create("contest_unit", str(tmp_path / "contest_unit"))
    row = SessionSuggestion(
        id="ss-s1", kind="replace", session_id="s1", session_number=2, track_ids=["tb"],
        track_follows={"tb": "ta"},
    )  # fmt: skip
    project.editorial.session_suggestions.append(row)
    restore_followed_tracks(project, "s1", contested={"ta"})
    restore_followed_tracks(project, "s1", contested={"tb"})
    restore_followed_tracks(project, "s1", only={"tz"})
    assert (row.track_ids, row.track_follows) == (["tb"], {"tb": "ta"})
    restore_followed_tracks(project, "s1", only={"tb"})
    assert (row.track_ids, row.track_follows) == (["ta"], {})


def test_a_stale_ack_rollback_of_someone_elses_piece_leaves_a_follow_alone(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.project.store import ProjectStore

    ws = _seed(minimal_project, sample_wav)
    track_a, _track_b, target = _replace_setup(ws)
    room, ava, ben = _late_replace_room(ws, target)
    RecordControlService(ws).assign_track(ava, "new")
    RecordControlService(ws).discard_take(1)

    # A follow with nobody holding it, as a hand-edited or older project could carry.
    def stray(p) -> None:
        row = next(s for s in p.editorial.session_suggestions if s.session_id == room["session_id"])
        row.track_ids, row.track_follows = ["tx"], {"tx": track_a}

    ws.mutate("stray", "stray", stray)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    svc.submit(_cmd("Start"), now_wall_ms=20_000)
    svc.submit(_cmd("Stop"), now_wall_ms=23_000)
    _ack(ws, room, ben, 2)
    uploader = RecordUploadService(ws.project)
    original = ProjectStore.commit
    fired = {"done": False}

    def racing(self, project):
        row = next(
            (
                s
                for s in project.editorial.session_suggestions
                if s.session_id == room["session_id"]
            ),
            None,
        )
        if not fired["done"] and row is not None and any(t.take_index == 2 for t in row.takes):
            fired["done"] = True
            uploader._store.mark_file(
                session_id=room["session_id"], take_index=2, participant_id=ben,
                segment_index=0, file_sha256="f" * 64, byte_length=480,
            )  # fmt: skip
        return original(self, project)

    monkeypatch.setattr(ProjectStore, "commit", racing)
    RecordLandingService(ws).land(align=lambda _p: None)
    assert fired["done"]
    labels = [e.label for e in HistoryService(ws).list_entries().entries]
    assert any("stale ACK rollback" in label for label in labels)
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == (["tx"], {"tx": track_a})


def test_track_not_recorded_names_several_tracks_with_and_and_never_an_id(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track_a, track_b, _t = _replace_setup(ws)
    target = {"kind": "replace", "from_sec": 0.1, "to_sec": 0.3, "track_ids": [track_a, track_b]}
    room, _pids = _room(ws, ["Cy"], target=target, land=True)
    with pytest.raises(CodedError) as caught:
        SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert '"Ava" and "Ben", which this pickup was set to replace' in str(caught.value)


def test_track_label_has_a_cycle_guard_and_no_raw_id(tmp_path):
    from podcast_mcp.edits.session_suggestions import _missing_tracks_phrase, _track_label
    from podcast_mcp.models import EpisodeProject, SessionSuggestion

    project = EpisodeProject.create("label_unit", str(tmp_path / "label_unit"))
    row = SessionSuggestion(
        id="ss-s1", kind="replace", session_id="s1", session_number=2, track_ids=["x"],
        track_follows={"x": "y", "y": "x"},
    )  # fmt: skip
    assert _track_label(project, row, "x") is None
    assert _missing_tracks_phrase([None]) == "another track"
    assert _missing_tracks_phrase(["A", "B", None]) == '"A", "B" and another track'


def test_a_removed_persons_bed_is_dropped_when_their_only_take_is_tombstoned(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    room, [pid] = _room(ws, ["Sam"])
    _bed_only(ws, room, pid)
    _remove(ws, room, pid)
    RecordControlService(ws).discard_take(0)
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    assert [t.id for t in ws.project.tracks if t.room_tone is not None] == []


def test_a_removed_persons_bed_is_dropped_when_their_take_was_never_acked(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    pid = _join_guest(svc, room, "Sam", 0)
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    _bed_only(ws, room, pid)
    _remove(ws, room, pid)
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    assert [t.id for t in ws.project.tracks if t.room_tone is not None] == []


def test_a_pin_on_the_moved_person_does_not_block_the_restore(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track_a, _track_b, target = _replace_setup(ws)
    room, ava, _ben = _late_replace_room(ws, target, land=False)
    RecordControlService(ws).assign_track(ava, track_a)
    RecordLandingService(ws).land(align=lambda _p: None)
    RecordControlService(ws).assign_track(ava, "new")
    assert _row(ws, room).track_follows == {ava: track_a}
    RecordControlService(ws).discard_take(1)
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([track_a], {})


def test_the_moved_persons_own_acked_take_does_not_block_the_restore(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track_a, _track_b, target = _replace_setup(ws)
    room, ava, _ben = _late_replace_room(ws, target)
    RecordControlService(ws).assign_track(ava, "new")
    _ack(ws, room, ava, 0)
    RecordControlService(ws).discard_take(1)
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([track_a], {})


def test_another_persons_acked_take_blocks_the_restore(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    track_a, _track_b, target = _replace_setup(ws)
    room, zoe, _ben = _late_replace_room(ws, target, land=False, late="Zoe")
    RecordControlService(ws).assign_track(zoe, track_a)
    RecordLandingService(ws).land(align=lambda _p: None)
    RecordControlService(ws).assign_track(zoe, "new")
    other = _late_guest(ws, room, "Ava")
    _ack(ws, room, other, 0)
    RecordControlService(ws).discard_take(1)
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([zoe], {zoe: track_a})


def test_restoring_a_swap_of_two_followed_tracks_keeps_both(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _room(ws, ["Ava", "Ben"], land=True)
    labels = _tracks(ws)
    track_a = next(t for t, label in labels.items() if label == "Ava")
    track_b = next(t for t, label in labels.items() if label == "Ben")
    target = {"kind": "replace", "from_sec": 0.1, "to_sec": 0.3, "track_ids": [track_a, track_b]}
    room = ShareService(ws).create_record_room(target=target)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    dan = _join_guest(svc, room, "Dan", 0)
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    _ack(ws, room, dan, 0)
    ava = _join_guest(svc, room, "Ava", 1)
    ben = _join_guest(svc, room, "Ben", 2)
    svc.submit(_cmd("Start"), now_wall_ms=10_000)
    svc.submit(_cmd("Stop"), now_wall_ms=13_000)
    for pid in (ava, ben):
        _ack(ws, room, pid, 1)
    RecordLandingService(ws).land(align=lambda _p: None)
    RecordControlService(ws).assign_track(ava, "new")
    RecordControlService(ws).assign_track(ben, track_a)
    RecordControlService(ws).discard_take(1)
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([track_a, track_b], {})


def test_restore_followed_tracks_restores_a_swap_in_one_pass(tmp_path):
    from podcast_mcp.edits.session_suggestions import restore_followed_tracks
    from podcast_mcp.edits.session_track_remap import remap_staged_participant
    from podcast_mcp.models import EpisodeProject, SessionSuggestion

    project = EpisodeProject.create("swap_unit", str(tmp_path / "swap_unit"))
    row = SessionSuggestion(
        id="ss-s1", kind="replace", session_id="s1", session_number=2, track_ids=["ta", "tb"]
    )
    project.editorial.session_suggestions.append(row)

    def move(old: str, new: str) -> None:
        remap_staged_participant(
            project, "ss-s1", source_ids=set(), bed_path="x", track_id=new, track_label="P",
            old_track_id=old,
        )  # fmt: skip

    move("ta", "tx")
    move("tb", "ta")
    assert (row.track_ids, row.track_follows) == (["tx", "ta"], {"tx": "ta", "ta": "tb"})
    restore_followed_tracks(project, "s1")
    assert (row.track_ids, row.track_follows) == (["ta", "tb"], {})


def _swapped_row(tmp_path, name: str, ids: list[str], follows: dict[str, str]):
    from podcast_mcp.models import EpisodeProject, SessionSuggestion

    project = EpisodeProject.create(name, str(tmp_path / name))
    row = SessionSuggestion(
        id="ss-s1", kind="replace", session_id="s1", session_number=2, track_ids=ids,
        track_follows=follows,
    )  # fmt: skip
    project.editorial.session_suggestions.append(row)
    return project, row


def test_restore_followed_tracks_does_not_narrow_a_partly_restorable_swap(tmp_path):
    from podcast_mcp.edits.session_suggestions import restore_followed_tracks

    follows = {"tx": "ta", "ta": "tb"}
    project, row = _swapped_row(tmp_path, "partial_contested", ["tx", "ta"], dict(follows))
    restore_followed_tracks(project, "s1", contested={"tb"}, only={"tx", "ta"})
    assert (row.track_ids, row.track_follows) == (["tx", "ta"], follows)
    project, row = _swapped_row(tmp_path, "partial_only", ["tx", "ta"], dict(follows))
    restore_followed_tracks(project, "s1", only={"tx"})
    assert (row.track_ids, row.track_follows) == (["tx", "ta"], follows)


def test_restore_followed_tracks_restores_a_three_cycle(tmp_path):
    from podcast_mcp.edits.session_suggestions import restore_followed_tracks

    project, row = _swapped_row(
        tmp_path, "cycle", ["tb", "tc", "ta"], {"tb": "ta", "tc": "tb", "ta": "tc"}
    )
    restore_followed_tracks(project, "s1")
    assert (row.track_ids, row.track_follows) == (["ta", "tb", "tc"], {})


def test_restore_followed_tracks_restores_a_chain_only_from_its_end(tmp_path):
    from podcast_mcp.edits.session_suggestions import restore_followed_tracks

    project, row = _swapped_row(tmp_path, "chain", ["tx", "ta"], {"tx": "ta", "ta": "tb"})
    restore_followed_tracks(project, "s1", only={"ta"})
    assert (row.track_ids, row.track_follows) == (["tx", "tb"], {"tx": "ta"})
    restore_followed_tracks(project, "s1", only={"tx"})
    assert (row.track_ids, row.track_follows) == (["ta", "tb"], {})


def test_a_removed_persons_bed_only_ack_does_not_block_the_restore(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track_a, _track_b, target = _replace_setup(ws)
    room, zoe, _ben = _late_replace_room(ws, target, land=False, late="Zoe")
    RecordControlService(ws).assign_track(zoe, track_a)
    RecordLandingService(ws).land(align=lambda _p: None)
    RecordControlService(ws).assign_track(zoe, "new")
    ghost = _late_guest(ws, room, "Ava")
    _bed_only(ws, room, ghost)
    _remove(ws, room, ghost)
    RecordControlService(ws).discard_take(1)
    row = _row(ws, room)
    assert (row.track_ids, row.track_follows) == ([track_a], {})


def _rejoin(ws, room, name: str = "Sam's iPad") -> str:
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    return _join_guest(svc, room, name, 7)


def _gone_sam(ws, *, acked: bool = False, bed: bool = False, target=None):
    room = ShareService(ws).create_record_room(target=target)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    sam = _join_guest(svc, room, "Sam", 0)
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    if acked:
        _ack(ws, room, sam, 0)
    if bed:
        _bed_only(ws, room, sam)
    return room, sam


def test_a_rejoiner_takes_a_removed_persons_track_when_nothing_is_left_to_land(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track = _sam_project(ws)
    room, sam = _gone_sam(ws)
    new = _rejoin(ws, room)
    _remove(ws, room, sam)
    out = RecordControlService(ws).assign_track(new, track)
    assert out["reason"] == "host_choice" and out["track_id"] == track
    assert _by_pid(ws)[sam]["track_id"] != track


def test_a_removed_person_still_holds_the_track_after_undoing_the_staging_land(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track = _sam_project(ws)
    room, [sam] = _room(ws, ["Sam"], target=INSERT, land=True)
    new = _rejoin(ws, room)
    _remove(ws, room, sam)
    HistoryService(ws).undo()
    ws.reload()
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(new, track)
    assert caught.value.code == "track_taken"


def test_the_stale_landed_flag_only_holds_the_track_for_a_staged_target(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track = _sam_project(ws)
    room, [sam] = _room(ws, ["Sam"], land=True)
    new = _rejoin(ws, room)
    _remove(ws, room, sam)
    HistoryService(ws).undo()
    ws.reload()
    out = RecordControlService(ws).assign_track(new, track)
    assert out["reason"] == "host_choice"


def test_a_person_still_in_the_room_always_holds_the_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track = _sam_project(ws)
    room, _sam = _gone_sam(ws, bed=True)
    new = _rejoin(ws, room)
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(new, track)
    assert caught.value.code == "track_taken"


def test_a_removed_persons_bed_only_recording_does_not_hold_the_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track = _sam_project(ws)
    room, sam = _gone_sam(ws, bed=True)
    new = _rejoin(ws, room)
    _remove(ws, room, sam)
    assert RecordControlService(ws).assign_track(new, track)["reason"] == "host_choice"


def test_a_removed_person_with_a_bed_and_a_kept_take_holds_the_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track = _sam_project(ws)
    room, sam = _gone_sam(ws, acked=True, bed=True)
    new = _rejoin(ws, room)
    _remove(ws, room, sam)
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(new, track)
    assert caught.value.code == "track_taken"


def test_a_removed_person_whose_take_is_already_placed_holds_the_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track = _sam_project(ws)
    room, [sam] = _room(ws, ["Sam"], land=True)
    ws.reload()
    assert any(c.track_id == track for c in ws.project.clips)
    new = _rejoin(ws, room)
    _remove(ws, room, sam)
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(new, track)
    assert caught.value.code == "track_taken"


def test_a_removed_person_whose_only_take_was_discarded_does_not_hold_the_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track = _sam_project(ws)
    room, sam = _gone_sam(ws, acked=True)
    new = _rejoin(ws, room)
    _remove(ws, room, sam)
    RecordControlService(ws).discard_take(0)
    assert RecordControlService(ws).assign_track(new, track)["reason"] == "host_choice"


def test_a_removed_person_acking_after_the_rejoiner_is_assigned_gets_a_new_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track = _sam_project(ws)
    room, sam = _gone_sam(ws)
    new = _rejoin(ws, room)
    _remove(ws, room, sam)
    RecordControlService(ws).assign_track(new, track)
    _ack(ws, room, sam, 0)
    rows = _by_pid(ws)
    assert rows[new]["track_id"] == track
    assert rows[sam]["track_id"] != track and rows[sam]["reason"] == "track_in_use"


def test_a_removed_person_with_an_unlanded_take_holds_the_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track = _sam_project(ws)
    room, sam = _gone_sam(ws, acked=True)
    new = _rejoin(ws, room)
    _remove(ws, room, sam)
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(new, track)
    assert caught.value.code == "track_taken"


def _placed_bed_then_gone(ws, *, this_session: bool):
    track = _sam_project(ws)
    room, sam = _gone_sam(ws, bed=True)
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    if not this_session:

        def earlier(p) -> None:
            bed = p.track_by_id(track).room_tone
            assert bed is not None
            p.track_by_id(track).room_tone = bed.model_copy(
                update={"path": f"raw/room-tone/earlier/{sam}.wav"}
            )

        ws.mutate("earlier", "earlier", earlier)
    new = _rejoin(ws, room)
    _remove(ws, room, sam)
    return track, new


def test_a_removed_person_with_a_bed_placed_in_this_session_holds_the_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track, new = _placed_bed_then_gone(ws, this_session=True)
    with pytest.raises(CodedError) as caught:
        RecordControlService(ws).assign_track(new, track)
    assert caught.value.code == "track_taken"


def test_a_removed_person_with_a_bed_from_an_earlier_session_does_not_hold_the_track(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    track, new = _placed_bed_then_gone(ws, this_session=False)
    assert RecordControlService(ws).assign_track(new, track)["reason"] == "host_choice"


def test_pending_rows_name_the_people_land_copies(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import re

    from podcast_mcp.services.record import landing
    from podcast_mcp.services.record.landing_math import record_source_prefix

    ws = _seed(minimal_project, sample_wav)
    room, [ava, ben] = _room(ws, ["Ava", "Ben"])
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    cy = _join_guest(svc, room, "Cy", 5)
    for pid in (ava, ben, cy):
        _bed_only(ws, room, pid)
    _remove(ws, room, ben)
    _remove(ws, room, cy)
    seen: list[tuple[set[str], set[str]]] = []
    real = landing.pending_rows

    def spy(*args, **kwargs):
        segments, beds = real(*args, **kwargs)
        seen.append(
            ({str(r["participant_id"]) for r in segments}, {str(r["participant_id"]) for r in beds})
        )
        return segments, beds

    monkeypatch.setattr(landing, "pending_rows", spy)
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()
    pattern = re.compile(rf"^{re.escape(record_source_prefix(room['session_id']))}\d+-(.+)-\d+$")
    clip_people = {m.group(1) for c in ws.project.clips if (m := pattern.match(c.source_id or ""))}
    bed_people = {
        pid
        for pid in (ava, ben, cy)
        for t in ws.project.tracks
        if t.room_tone is not None and t.room_tone.path.endswith(f"/{pid}.wav")
    }
    assert seen == [({ava, ben}, {ava, ben})]
    assert (clip_people, bed_people) == seen[0]
