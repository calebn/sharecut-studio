"""A session that starts the episode lands at time 0 and moves everything already there later."""

from __future__ import annotations

import hashlib
import json
import math
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.comments import add_comment
from podcast_mcp.edits.session_gap import close_session_gap, open_session_gap
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_from_timeline, timeline_duration_sec
from podcast_mcp.models import (
    AppliedEditRecord,
    AutomationEnvelope,
    AutomationPoint,
    ChapterMarker,
    Clip,
    EditDecision,
    EditDecisionType,
    InsertAnchor,
    SessionSuggestion,
    Track,
    TrackRole,
)
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document import HistoryService, SessionSuggestionService
from podcast_mcp.services.record.landing import RecordLandingService
from podcast_mcp.services.record.landing_start import own_extent_s
from podcast_mcp.services.record.upload import RecordUploadService, sha256_hex
from podcast_mcp.util.wav import pcm_wav_header
from test_record_replace_accept import _stage_replace
from test_record_staging import _cmd, _join, _room_tone_bed, _seed, _suggestion

RATE = 48_000
START = {"kind": "start"}
LEN1 = 4.0


def _tone(seconds: float, hz: float) -> bytes:
    t = np.arange(round(seconds * RATE)) / RATE
    return (np.sin(2 * math.pi * hz * t) * 12_000).astype("<i2").tobytes()


def _take(ws, room, svc, guest: str, take: int, seconds: float, hz: float) -> None:
    clock = take * 10_000
    svc.submit(_cmd("Start"), now_wall_ms=clock)
    svc.submit(_cmd("Stop"), now_wall_ms=clock + 3_000)
    pcm = _tone(seconds, hz)
    RecordUploadService(ws.project).ingest_part(
        session_id=room["session_id"],
        take_index=take,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=sha256_hex(pcm),
        file_sha256=sha256_hex(pcm_wav_header(len(pcm)) + pcm),
        final=True,
        expected_parts=1,
    )


def _land(ws):
    return RecordLandingService(ws).land(align=lambda _p: None)


def _dump(ws) -> dict:
    """The saved project without its history and the render cause journal, which undo extends."""
    ws.reload()
    return ws.project.model_dump(
        mode="json", exclude={"history": True, "render": {"invalidations"}}
    )


def _digest(ws) -> str:
    return hashlib.sha256(json.dumps(_dump(ws), sort_keys=True).encode()).hexdigest()


def _clips(ws, track_id: str | None = None) -> dict[str, float]:
    ws.reload()
    return {
        c.id: round(c.timeline_start, 6)
        for c in ws.project.clips
        if track_id is None or c.track_id == track_id
    }


def _episode(ws) -> tuple[dict, str]:
    """Session 1 (a 4 s tone) plus review state keyed to its timeline; returns its room and track."""
    room = ShareService(ws).create_record_room()
    svc, guest = _join(ws, room)
    _take(ws, room, svc, guest, 0, LEN1, 440.0)
    _land(ws)

    def decorate(project) -> None:
        project.tracks.append(Track(id="music", label="Music", role=TrackRole.MUSIC))
        project.clips.append(
            Clip(
                id="music-1",
                track_id="music",
                source_id="src-music",
                source_start=0.0,
                source_end=2.0,
                timeline_start=3.0,
            )
        )
        add_comment(project, body="early", author="rev", timeline_start=1.0, comment_id="early")
        add_comment(
            project,
            body="span",
            author="rev",
            timeline_start=1.0,
            timeline_end=3.0,
            comment_id="span",
        )
        project.editorial.chapters = [ChapterMarker(time=2.0, title="two")]
        project.editorial.edit_decisions.append(
            EditDecision(
                id="d1",
                track_id=guest,
                type=EditDecisionType.MUTE,
                start=1.0,
                end=2.0,
                timebase="timeline",
                applied=False,
            )
        )
        project.editorial.edit_log.append(
            AppliedEditRecord(
                id="alog_1",
                applied_at="2026-01-01T00:00:00+00:00",
                operation="approve_edits",
                track_ids=[guest],
                timeline_start=0.5,
                timeline_end=1.0,
            )
        )
        project.automation_envelopes.append(
            AutomationEnvelope(
                track_id=guest,
                points=[
                    AutomationPoint(id="a0", time=0.0, value=1.0),
                    AutomationPoint(id="a1", time=2.0, value=0.5),
                ],
            )
        )

    ws.mutate("decorate", "decorated", decorate)
    return room, guest


def _start_room(ws):
    room = ShareService(ws).create_record_room(target=START)
    svc, guest = _join(ws, room)
    return room, svc, guest


def _review_state(ws) -> dict:
    ws.reload()
    p = ws.project
    return {
        "comments": {c.id: (c.timeline_start, c.timeline_end) for c in p.comments},
        "chapters": [c.time for c in p.editorial.chapters],
        "decisions": {e.id: (e.start, e.end) for e in p.editorial.edit_decisions},
        "log": [(r.timeline_start, r.timeline_end) for r in p.editorial.edit_log],
        "envelope": [pt.time for e in p.automation_envelopes for pt in e.points],
    }


def test_a_start_session_lands_at_zero_and_shifts_everything_by_its_length(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _episode(ws)
    before_clips = _clips(ws)
    before_duration = timeline_duration_sec(ws.project)
    cuts_before = {
        c.id: (c.source_start, c.source_end, c.timeline_end - c.timeline_start)
        for c in ws.project.clips
    }

    room, svc, guest2 = _start_room(ws)
    _take(ws, room, svc, guest2, 0, 2.5, 880.0)
    landed = _land(ws)

    [placed] = landed["clips"]
    assert placed["timeline_start"] == 0.0
    shift = 2.5
    after = _clips(ws)
    for clip_id, start in before_clips.items():
        assert after[clip_id] == pytest.approx(start + shift)
    new_id = placed["clip_id"]
    assert after[new_id] == 0.0
    state = _review_state(ws)
    assert state["comments"]["early"] == (1.0 + shift, None)
    assert state["comments"]["span"] == (1.0 + shift, 3.0 + shift)
    assert state["chapters"] == [2.0 + shift]
    assert state["decisions"]["d1"] == (1.0 + shift, 2.0 + shift)
    assert state["log"] == [(0.5 + shift, 1.0 + shift)]
    assert state["envelope"] == [0.0 + shift, 2.0 + shift]
    assert timeline_duration_sec(ws.project) == pytest.approx(before_duration + shift)
    assert ws.project.timeline.duration_sec == pytest.approx(before_duration + shift)
    for clip in ws.project.clips:
        if clip.id in cuts_before:
            assert (
                clip.source_start,
                clip.source_end,
                clip.timeline_end - clip.timeline_start,
            ) == cuts_before[clip.id]
    assert min(c.timeline_start for c in ws.project.clips) == 0.0
    assert [(r.number, r.target_kind) for r in ws.project.editorial.record_sessions] == [
        (1, "end"),
        (2, "start"),
    ]
    assert HistoryService(ws).list_entries().groups[-1].title == "Added Session 2 at the start"


def test_the_land_is_one_undo_step_that_restores_the_exact_project(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _episode(ws)
    before = _dump(ws)
    room, svc, guest2 = _start_room(ws)
    _take(ws, room, svc, guest2, 0, 2.5, 880.0)
    steps = len(HistoryService(ws).list_entries().groups)
    _land(ws)
    landed = _digest(ws)
    assert len(HistoryService(ws).list_entries().groups) == steps + 1
    assert landed != before

    HistoryService(ws).undo()
    assert _dump(ws) == before
    HistoryService(ws).redo()
    assert _digest(ws) == landed


def test_each_land_opens_only_the_time_it_adds(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _episode(ws)
    original = _clips(ws)
    room, svc, guest2 = _start_room(ws)
    _take(ws, room, svc, guest2, 0, 2.5, 880.0)
    _land(ws)
    after_first = _digest(ws)
    _take(ws, room, svc, guest2, 1, 1.5, 660.0)
    second = _land(ws)

    [placed] = second["clips"]
    assert placed["timeline_start"] == pytest.approx(5.0)
    end_of_session = 5.0 + 1.5
    after = _clips(ws)
    for clip_id, start in original.items():
        assert after[clip_id] == pytest.approx(start + end_of_session)
    assert own_extent_s(ws.project.clips, room["session_id"]) == pytest.approx(end_of_session)
    assert HistoryService(ws).list_entries().groups[-1].title == "Added to Session 2"
    state = _review_state(ws)
    assert state["comments"]["early"] == (1.0 + end_of_session, None)

    HistoryService(ws).undo()
    assert _digest(ws) == after_first


def test_a_second_start_session_moves_the_first_one_too(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _episode(ws)
    first_room, svc, guest2 = _start_room(ws)
    _take(ws, first_room, svc, guest2, 0, 2.5, 880.0)
    _land(ws)
    both = _clips(ws)

    second_room, svc3, guest3 = _start_room(ws)
    _take(ws, second_room, svc3, guest3, 0, 1.0, 330.0)
    landed = _land(ws)

    after = _clips(ws)
    assert after[landed["clips"][0]["clip_id"]] == 0.0
    for clip_id, start in both.items():
        assert after[clip_id] == pytest.approx(start + 1.0)
    assert min(after.values()) == 0.0
    assert [r.number for r in ws.project.editorial.record_sessions] == [1, 2, 3]
    assert HistoryService(ws).list_entries().groups[-1].title == "Added Session 3 at the start"


def test_the_start_session_is_first_in_a_real_render_and_mix(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _, guest1 = _episode(ws)
    room, svc, guest2 = _start_room(ws)
    _take(ws, room, svc, guest2, 0, 2.5, 880.0)
    _land(ws)
    ws.reload()
    assert timeline_duration_sec(ws.project) == pytest.approx(2.5 + 5.0)
    defaults = load_defaults()

    def load(path: Path) -> np.ndarray:
        with wave.open(str(path), "rb") as media:
            frames = media.readframes(media.getnframes())
            return np.frombuffer(frames, dtype="<i2")[:: media.getnchannels()]

    def render(track_id: str) -> Path:
        out = tmp_workspace / f"{track_id}.wav"
        render_track_from_timeline(ws.project, ws.project.track_by_id(track_id), out, defaults)
        return out

    new_wav, old_wav = render(guest2), render(guest1)
    mix_wav = FFmpegEngine().mix_tracks([(new_wav, 0.0), (old_wav, 0.0)], tmp_workspace / "mix.wav")
    new, old, mix = load(new_wav), load(old_wav), load(mix_wav)
    loud = 1_000
    assert new.size / RATE == pytest.approx(2.5, abs=0.05)
    assert old.size / RATE == pytest.approx(2.5 + LEN1, abs=0.05)
    assert mix.size / RATE == pytest.approx(2.5 + LEN1, abs=0.05)
    assert np.flatnonzero(np.abs(new) > loud)[0] < 0.05 * RATE
    assert np.flatnonzero(np.abs(old) > loud)[0] == pytest.approx(2.5 * RATE, abs=0.05 * RATE)
    assert np.abs(old[: round(2.4 * RATE)]).max() <= loud
    assert np.flatnonzero(np.abs(mix) > loud)[0] < 0.05 * RATE
    assert np.abs(mix[round(2.0 * RATE) : round(2.4 * RATE)]).max() > loud


def test_a_pending_insert_and_replace_still_find_their_audio(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    _, guest1 = _episode(ws)
    insert_room = ShareService(ws).create_record_room(target={"kind": "insert", "at_sec": 1.0})
    isvc, iguest = _join(ws, insert_room)
    _take(ws, insert_room, isvc, iguest, 0, 1.0, 550.0)
    _land(ws)
    replace_id = _stage_replace(
        ws, 2.5, 3.5, {0: [(guest1, 0.0, 1.0)]}, track_ids=[guest1], session_id="b" * 12, number=3
    )
    insert_id = _suggestion(ws, insert_room["session_id"]).id

    start_room, svc, guest2 = _start_room(ws)
    _take(ws, start_room, svc, guest2, 0, 2.5, 880.0)
    _land(ws)

    insert = _suggestion(ws, insert_room["session_id"])
    assert insert.anchor.at_sec == pytest.approx(3.5)
    replace = _suggestion(ws, "b" * 12)
    assert replace.anchor.at_sec == pytest.approx(5.0)
    assert replace.end_anchor.at_sec == pytest.approx(6.0)

    service = SessionSuggestionService(ws)
    placed = service.accept(replace_id)
    assert placed["from_sec"] == pytest.approx(5.0)
    assert placed["to_sec"] == pytest.approx(6.0)
    accepted = service.accept(insert_id)
    assert accepted["at_sec"] == pytest.approx(3.5)


def test_the_room_tone_bed_lands_with_a_start_session(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _episode(ws)
    room, svc, guest2 = _start_room(ws)
    _room_tone_bed(ws, room, guest2)
    _take(ws, room, svc, guest2, 1, 2.5, 880.0)
    _land(ws)
    ws.reload()
    track = ws.project.track_by_id(guest2)
    assert track is not None and track.room_tone is not None
    [clip] = [c for c in ws.project.clips if c.track_id == guest2]
    assert clip.timeline_start == 0.0


def test_discarding_the_last_take_gives_the_time_back(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _episode(ws)
    original = _clips(ws)
    state = _review_state(ws)
    room, svc, guest2 = _start_room(ws)
    _take(ws, room, svc, guest2, 0, 2.5, 880.0)
    _land(ws)
    _take(ws, room, svc, guest2, 1, 1.5, 660.0)
    _land(ws)

    RecordLandingService(ws).delete_take(1)
    mid = _clips(ws)
    assert {k: v for k, v in mid.items() if k in original} == pytest.approx(
        {k: v + 2.5 for k, v in original.items()}
    )
    RecordLandingService(ws).delete_take(0)
    assert {k: v for k, v in _clips(ws).items() if k in original} == pytest.approx(original)
    assert _review_state(ws) == state


def test_a_stale_ack_rollback_gives_the_time_back(minimal_project, sample_wav, tmp_workspace):
    ws = _seed(minimal_project, sample_wav)
    _episode(ws)
    original = _clips(ws)
    room, svc, guest2 = _start_room(ws)
    _take(ws, room, svc, guest2, 0, 2.5, 880.0)
    calls = {"n": 0}

    def generation_current(_self, _item) -> bool:
        calls["n"] += 1
        return calls["n"] <= 2

    with (
        patch.object(RecordLandingService, "_ack_generation_current", generation_current),
        patch.object(RecordLandingService, "_mark_registered_landing", lambda *_a, **_k: False),
    ):
        _land(ws)
    assert _clips(ws) == pytest.approx(original)
    assert not [c for c in ws.project.clips if c.track_id == guest2]


def _gap_project(guest: str = "g"):
    from podcast_mcp.models import EpisodeProject

    project = EpisodeProject.create("gap", "/tmp/gap-unused")
    project.timeline.duration_sec = 5.0
    project.tracks.extend(
        [
            Track(id=guest, label="G", role=TrackRole.DIALOGUE),
            Track(id="music", label="M", role=TrackRole.MUSIC),
        ]
    )
    project.clips.extend(
        [
            Clip(
                id="a",
                track_id=guest,
                source_id="s",
                source_start=0,
                source_end=4,
                timeline_start=0,
            ),
            Clip(
                id="m",
                track_id="music",
                source_id="m",
                source_start=0,
                source_end=2,
                timeline_start=3,
            ),
        ]
    )
    add_comment(project, body="x", author="r", timeline_start=1.0, comment_id="x")
    project.editorial.session_suggestions.append(
        SessionSuggestion(
            id="ss-p",
            kind="insert",
            session_id="p" * 12,
            session_number=2,
            at_sec=1.0,
            anchor=InsertAnchor(kind="end", at_sec=1.0),
        )
    )
    return project


def test_open_then_close_a_gap_round_trips_everything_keyed_to_time() -> None:
    defaults = load_defaults()
    project = _gap_project()
    before = project.model_dump(mode="json")
    ids = [t.id for t in project.tracks]
    open_session_gap(project, 0.0, 2.0, ids, defaults=defaults)
    assert {c.id: c.timeline_start for c in project.clips} == {"a": 2.0, "m": 5.0}
    assert project.comments[0].timeline_start == 3.0
    pending = project.editorial.session_suggestions[0]
    assert (pending.at_sec, pending.anchor.at_sec) == (3.0, 3.0)

    assert close_session_gap(project, 0.0, 2.0, ids, defaults=defaults) is True
    assert project.model_dump(mode="json") == before


def test_close_refuses_when_audio_sits_in_the_gap() -> None:
    project = _gap_project()
    before = project.model_dump(mode="json")
    assert close_session_gap(project, 1.0, 2.0, ["g", "music"], defaults=load_defaults()) is False
    assert project.model_dump(mode="json") == before


def test_opening_a_gap_leaves_the_suggestion_being_accepted_alone() -> None:
    project = _gap_project()
    open_session_gap(
        project, 1.0, 1.0, ["g"], defaults=load_defaults(), except_suggestion_id="ss-p"
    )
    assert project.editorial.session_suggestions[0].at_sec == 1.0
