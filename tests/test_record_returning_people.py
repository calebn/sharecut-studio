"""Returning people: a person is matched to their track by name across sessions; the host can correct it."""

from __future__ import annotations

import json
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


def _room(ws, names: list[str], *, target=None, land: bool = False):
    """A room whose guests (``names``) all consented and recorded one take."""
    room = ShareService(ws).create_record_room(target=target)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    pids: list[str] = []
    for i, name in enumerate(names):
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
        pids.append(echo["participant_id"])
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
    assert bad.exit_code == 1 and "unknown track" in bad.output + (bad.stderr or "")
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
