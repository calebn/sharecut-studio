"""Hearing a staged insert or replace before Accept: windows, cache, refusals and no changes."""

from __future__ import annotations

import array
import hashlib
import json
import math
import wave
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.insert_anchor import capture_insert_anchor
from podcast_mcp.edits.session_suggestions import ensure_session_suggestion
from podcast_mcp.mcp.tools.review import hear_session_suggestion_tool
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    SessionSuggestion,
    StagedRoomTone,
    StagedTake,
    Track,
    TrackRole,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import PlayService, SessionSuggestionService
from podcast_mcp.util.coded_error import CodedValueError
from test_record_replace_accept import SID, SUGGESTION, _stage_replace, _words

RATE = 48_000
CLI = CliRunner()


def _write_tone(path: Path, seconds: float, hz: float, amp: int = 8000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    samples = array.array(
        "h",
        (int(amp * math.sin(2 * math.pi * hz * i / RATE)) for i in range(round(seconds * RATE))),
    )
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(RATE)
        audio.writeframes(samples.tobytes())


def _pcm(path: str | Path) -> list[int]:
    with wave.open(str(path), "rb") as audio:
        return list(array.array("h", audio.readframes(audio.getnframes())))


def _seconds(path: str | Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


@pytest.fixture
def ws(minimal_project, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.edits.cut_speech.speech_energy_guard_enabled", lambda _defaults: False
    )
    workspace = ProjectWorkspace.open(minimal_project)
    root = workspace.project.workspace_path()

    def build(project: EpisodeProject) -> None:
        for track_id, hz in (("host", 330), ("guest", 440)):
            _write_tone(root / "raw" / f"{track_id}.wav", 10.0, hz)
        project.sources = [
            _source(f"src-{track_id}", f"raw/{track_id}.wav", 10.0)
            for track_id in ("host", "guest")
        ]
        project.tracks = [
            Track(
                id=track_id,
                label=track_id.title(),
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=10.0),
            )
            for track_id in ("host", "guest")
        ]
        project.clips = [
            Clip(
                id=f"{track_id}-full",
                track_id=track_id,
                source_id=f"src-{track_id}",
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
            for track_id in ("host", "guest")
        ]
        project.timeline.duration_sec = 10.0

    workspace.mutate("seed", "seeded", build)
    return workspace


def _stage_files(ws, hz: float = 700) -> None:
    """Give every staged recording real audio of its own length."""
    root = ws.project.workspace_path()
    for row in ws.project.editorial.session_suggestions:
        for take in row.takes:
            source = ws.project.source_by_id(take.source_id)
            _write_tone(root / source.path, take.duration_s, hz + 50 * take.take_index)
        for bed in row.room_tone:
            _write_tone(root / bed.path, bed.duration_s, 90, amp=300)


def _replace(ws, from_sec, to_sec, takes, **kwargs) -> str:
    sid = _stage_replace(ws, from_sec, to_sec, takes, **kwargs)
    ws.reload()
    _stage_files(ws)
    return sid


def _insert(ws, at_sec: float, durations: list[float], *, bed: float | None = None) -> str:
    def build(project: EpisodeProject) -> None:
        takes = []
        for index, duration in enumerate(durations):
            source_id = f"rec-{SID}-0-host-{index}"
            project.sources.append(_source(source_id, f"raw/{source_id}.wav", duration))
            takes.append(
                StagedTake(
                    take_index=0,
                    track_id="host",
                    track_label="Host",
                    segment_index=index,
                    source_id=source_id,
                    offset_s=sum(durations[:index]),
                    duration_s=duration,
                )
            )
        beds = []
        if bed is not None:
            project.sources.append(_source("bed-1", "raw/bed-1.wav", bed))
            beds.append(
                StagedRoomTone(
                    track_id="host",
                    track_label="Host",
                    source_id="bed-1",
                    path="raw/bed-1.wav",
                    duration_s=bed,
                    sample_rate=RATE,
                    channels=1,
                )
            )
        ensure_session_suggestion(
            project,
            SessionSuggestion(
                id=SUGGESTION,
                kind="insert",
                session_id=SID,
                session_number=1,
                at_sec=at_sec,
                anchor=capture_insert_anchor(project, at_sec),
                takes=takes,
                room_tone=beds,
            ),
        )

    ws.mutate("stage", "staged", build)
    ws.reload()
    _stage_files(ws)
    return SUGGESTION


def _source(source_id: str, rel: str, duration: float):
    from podcast_mcp.models import SourceRecording

    return SourceRecording(
        id=source_id,
        path=rel,
        speaker="host",
        duration_sec=duration,
        sample_rate=RATE,
        channels=1,
    )


def _svc(ws) -> SessionSuggestionService:
    return SessionSuggestionService(ws)


def _hear(ws, sid: str = SUGGESTION, **kwargs):
    kwargs.setdefault("dry_run", True)
    return _svc(ws).preview(sid, **kwargs)


# --- windows ---


def test_current_is_the_range_plus_a_pad_each_side_and_suggested_the_take_plus_a_pad(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 3.0)]})
    result = _hear(ws, sid, mode="ab", pad_sec=1.5)
    assert (result["current"]["start_s"], result["current"]["end_s"]) == (1.5, 6.5)
    assert (result["suggested"]["start_s"], result["suggested"]["end_s"]) == (1.5, 7.5)
    assert _seconds(result["current"]["wav"]) == pytest.approx(5.0, abs=1 / RATE)
    assert _seconds(result["suggested"]["wav"]) == pytest.approx(6.0, abs=1 / RATE)
    assert result["delta_s"] == pytest.approx(1.0)
    assert (result["removed_s"], result["span_s"]) == (2.0, 3.0)
    assert result["suggested"]["delta_s"] == pytest.approx(1.0)
    assert result["take_index"] == 0
    assert result["kind"] == "replace"
    # A/B is Current, the gap, then Suggested.
    assert _seconds(result["wav"]) == pytest.approx(5.0 + 0.4 + 6.0, abs=0.01)


def test_an_insert_is_a_pad_each_side_of_the_point_and_the_takes_one_after_another(ws) -> None:
    sid = _insert(ws, 4.0, [1.0, 1.5])
    result = _hear(ws, sid, mode="ab", pad_sec=1.0)
    assert (result["current"]["start_s"], result["current"]["end_s"]) == (3.0, 5.0)
    assert (result["suggested"]["start_s"], result["suggested"]["end_s"]) == (3.0, 7.5)
    assert _seconds(result["suggested"]["wav"]) == pytest.approx(4.5, abs=1 / RATE)
    assert result["delta_s"] == pytest.approx(2.5)
    assert result["take_index"] is None
    assert result["speech"] is None


def test_windows_stop_at_the_start_and_the_end_of_the_episode(ws) -> None:
    near_start = _replace(ws, 0.5, 1.5, {0: [("host", 0.0, 1.0)]})
    result = _hear(ws, near_start, mode="ab", pad_sec=1.5)
    assert result["current"]["start_s"] == 0.0
    assert result["suggested"]["start_s"] == 0.0
    assert _seconds(result["current"]["wav"]) == pytest.approx(3.0, abs=1 / RATE)
    assert _seconds(result["suggested"]["wav"]) == pytest.approx(3.0, abs=1 / RATE)


def test_windows_stop_at_the_end_of_the_episode(ws) -> None:
    sid = _replace(ws, 8.0, 9.5, {0: [("host", 0.0, 4.0)]})
    result = _hear(ws, sid, mode="ab", pad_sec=1.5)
    assert result["current"]["end_s"] == pytest.approx(10.0)
    assert _seconds(result["current"]["wav"]) == pytest.approx(3.5, abs=1 / RATE)
    # The episode is 10 - 1.5 + 4 = 12.5 s long after Accept.
    assert result["suggested"]["end_s"] == pytest.approx(12.5)
    assert _seconds(result["suggested"]["wav"]) == pytest.approx(6.0, abs=1 / RATE)


def test_each_take_of_a_replace_gets_its_own_length_and_default_is_the_last(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 4.0)]})
    last = _hear(ws, sid, mode="suggested", pad_sec=1.0)
    first = _hear(ws, sid, mode="suggested", take_index=0, pad_sec=1.0)
    assert (last["take_index"], last["span_s"]) == (1, 4.0)
    assert (first["take_index"], first["span_s"]) == (0, 1.0)
    assert first["current"] is None
    assert _seconds(first["suggested"]["wav"]) == pytest.approx(3.0, abs=1 / RATE)
    assert _seconds(last["suggested"]["wav"]) == pytest.approx(6.0, abs=1 / RATE)


# --- what Accept ships ---


@pytest.mark.parametrize("take_s", [1.0, 3.5])
def test_suggested_is_the_audio_a_real_accept_then_gives_for_the_same_window(
    ws, monkeypatch, take_s
) -> None:
    # Pin the trim so the comparison is of the windows, not of a measurement before and after.
    monkeypatch.setattr(PlayService, "mix_trim_db", lambda self, **_kw: -1.0)
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, take_s)]})
    result = _hear(ws, sid, mode="suggested", pad_sec=1.0)
    _svc(ws).accept(sid)
    ws.reload()
    accepted = ws.project.workspace_path() / "accepted.wav"
    play = PlayService(ws)
    play._render_mix_window(
        ws.project,
        result["suggested"]["start_s"],
        result["suggested"]["end_s"],
        accepted,
        trim_db=-1.0,
    )
    assert _pcm(result["suggested"]["wav"]) == _pcm(accepted)
    placed = [
        c for c in ws.project.clips if c.track_id == "host" and c.source_id.startswith("rec-")
    ]
    assert placed[0].timeline_start == pytest.approx(result["suggested"]["start_s"] + 1.0)
    assert placed[0].timeline_end - placed[0].timeline_start == pytest.approx(take_s)


def test_current_is_the_window_of_the_project_as_it_is(ws, monkeypatch) -> None:
    monkeypatch.setattr(PlayService, "mix_trim_db", lambda self, **_kw: -1.0)
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 3.0)]})
    result = _hear(ws, sid, mode="current", pad_sec=1.0)
    direct = ws.project.workspace_path() / "direct.wav"
    PlayService(ws)._render_mix_window(ws.project, 2.0, 6.0, direct, trim_db=-1.0)
    assert _pcm(result["current"]["wav"]) == _pcm(direct)


def test_the_new_take_is_heard_from_its_clip_for_a_track_that_had_no_audio(ws) -> None:
    # A staged track that is new to the project: its media is set when the take is placed.
    ws.mutate(
        "drop",
        "dropped",
        lambda p: setattr(p, "clips", [c for c in p.clips if c.track_id != "guest"]),
    )
    sid = _insert(ws, 4.0, [2.0])
    suggested = _hear(ws, sid, mode="suggested", pad_sec=1.0)["suggested"]
    window = _pcm(suggested["wav"])
    inside = window[RATE + 4800 : 3 * RATE - 4800]
    assert max(abs(sample) for sample in inside) > 1000


def test_a_room_tone_bed_is_in_the_insert_window_as_accept_places_it(ws) -> None:
    sid = _insert(ws, 4.0, [2.0], bed=1.0)
    with_bed = _hear(ws, sid, mode="suggested", pad_sec=1.0)
    assert with_bed["span_s"] == 2.0
    assert _seconds(with_bed["suggested"]["wav"]) == pytest.approx(4.0, abs=1 / RATE)


# --- speech ---


def test_a_replace_carries_the_speech_it_would_remove_and_says_so(ws) -> None:
    _words(ws, "guest", ("so", 3.2, 3.5), ("plan", 3.6, 3.9))
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    result = _hear(ws, sid, mode="suggested")
    [track] = result["speech"]["tracks"]
    assert track["track_id"] == "guest"
    assert [word["text"] for word in track["words"]] == ["so", "plan"]
    assert result["speech_message"] == (
        'Replacing this range also removes 2 words from Guest: "so plan". '
        "Replace anyway to apply it; undo brings it back."
    )
    # Accept holds the same speech until it is confirmed.
    held = _svc(ws).accept(sid)
    assert held["needs_confirmation"]["speech"] == result["speech"]


def test_a_replace_that_removes_no_other_speech_has_none(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    result = _hear(ws, sid, mode="suggested")
    assert result["speech"] is None
    assert result["speech_message"] is None


# --- the cache ---


class _Spy:
    def __init__(self, monkeypatch) -> None:
        self.snapshots = 0
        self.accepts = 0
        from podcast_mcp.services.document import play_session

        snapshot = play_session.snapshot_project
        accept = play_session.apply_session_suggestion_for_preview

        def counted_snapshot(project):
            self.snapshots += 1
            return snapshot(project)

        def counted_accept(*args, **kwargs):
            self.accepts += 1
            return accept(*args, **kwargs)

        monkeypatch.setattr(play_session, "snapshot_project", counted_snapshot)
        monkeypatch.setattr(play_session, "apply_session_suggestion_for_preview", counted_accept)


def test_a_second_call_is_a_cache_hit_that_neither_snapshots_nor_accepts(ws, monkeypatch) -> None:
    _words(ws, "guest", ("so", 3.2, 3.5))
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    spy = _Spy(monkeypatch)
    first = _hear(ws, sid, mode="ab")
    assert (spy.snapshots, spy.accepts) == (2, 2)
    second = _hear(ws, sid, mode="ab")
    assert (spy.snapshots, spy.accepts) == (2, 2)
    assert second == first
    assert second["speech"] is not None


@pytest.mark.parametrize(
    "change",
    ["bed", "staged_wav", "clip", "code_rev", "take", "pad", "mix"],
)
def test_a_change_to_what_the_window_plays_is_a_miss(ws, monkeypatch, change) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)], 1: [("host", 0.0, 3.0)]})
    kwargs: dict = {"mode": "suggested", "take_index": 0}
    first = _hear(ws, sid, **kwargs)
    if change == "bed":

        def add_bed(project: EpisodeProject) -> None:
            row = project.editorial.session_suggestions[0]
            row.room_tone = [
                StagedRoomTone(
                    track_id="host",
                    track_label="Host",
                    source_id="bed",
                    path="raw/bed.wav",
                    duration_s=1.0,
                    sample_rate=RATE,
                    channels=1,
                )
            ]

        ws.mutate("bed", "bedded", add_bed)
    elif change == "staged_wav":
        take = ws.project.editorial.session_suggestions[0].takes[0]
        path = ws.project.workspace_path() / ws.project.source_by_id(take.source_id).path
        _write_tone(path, take.duration_s, 900)
    elif change == "clip":
        ws.mutate(
            "clip",
            "clipped",
            lambda p: setattr(
                next(c for c in p.clips if c.track_id == "guest"), "source_start", 0.5
            ),
        )
    elif change == "code_rev":
        monkeypatch.setattr("podcast_mcp.services.document.play_session.SESSION_PREVIEW_REV", 99)
    elif change == "take":
        kwargs["take_index"] = 1
    elif change == "pad":
        kwargs["pad_sec"] = 1.0
    elif change == "mix":
        ws.mutate("gain", "gained", lambda p: setattr(p.tracks[0], "fader_db", -3.0))
    spy = _Spy(monkeypatch)
    second = _hear(ws, sid, **kwargs)
    assert spy.accepts == 1
    assert second["suggested"]["wav"] != first["suggested"]["wav"]


def test_current_does_not_depend_on_the_take(ws, monkeypatch) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)], 1: [("host", 0.0, 3.0)]})
    first = _hear(ws, sid, mode="current", take_index=0)
    spy = _Spy(monkeypatch)
    second = _hear(ws, sid, mode="current", take_index=1)
    assert spy.accepts == 0
    assert second["current"] == first["current"]


def test_a_wav_the_cache_dropped_is_rendered_again(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    first = _hear(ws, sid, mode="suggested")
    Path(first["suggested"]["wav"]).unlink()
    again = _hear(ws, sid, mode="suggested")
    assert Path(again["suggested"]["wav"]).is_file()
    assert again["suggested"] == first["suggested"]


def test_rerender_builds_the_window_again(ws, monkeypatch) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    _hear(ws, sid, mode="suggested")
    spy = _Spy(monkeypatch)
    _hear(ws, sid, mode="suggested", rerender=True)
    assert spy.accepts == 1


def test_a_cache_hit_does_not_open_a_transaction(ws, monkeypatch) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    _hear(ws, sid, mode="ab")
    with patch.object(ProjectWorkspace, "transaction", side_effect=AssertionError("locked")):
        _hear(ws, sid, mode="ab")


def test_no_stem_is_ever_rendered_for_a_snapshot(ws, monkeypatch) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    seen: list[EpisodeProject] = []
    original = PlayService.ensure_stem

    def watched(self, track_id, **kwargs):
        seen.append(self.project)
        return original(self, track_id, **kwargs)

    monkeypatch.setattr(PlayService, "ensure_stem", watched)
    _hear(ws, sid, mode="ab")
    assert all(project is ws.project for project in seen)


# --- nothing changes ---


def _fingerprint(ws, sid: str) -> str:
    ws.reload()
    project = ws.project
    root = project.workspace_path() / "artifacts"
    tracked = {
        str(path.relative_to(root)): (path.stat().st_mtime_ns, path.stat().st_size)
        for folder in ("tracks", "level_profiles")
        for path in sorted((root / folder).rglob("*"))
        if path.is_file()
    }
    project_file = ws.path.read_bytes() if hasattr(ws, "path") else b""
    return json.dumps(
        {
            "project": project.model_dump(mode="json", exclude={"render"}),
            "history": [e.model_dump(mode="json") for e in project.history.entries][-1:],
            "row": next(r for r in project.editorial.session_suggestions if r.id == sid).model_dump(
                mode="json"
            ),
            "files": tracked,
            "saved": hashlib.sha256(project_file).hexdigest(),
        },
        sort_keys=True,
        default=str,
    )


@pytest.mark.parametrize("mode", ["current", "suggested", "ab"])
def test_a_preview_changes_nothing_but_the_play_cache(ws, mode) -> None:
    _words(ws, "guest", ("so", 3.2, 3.5))
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    # The live mix's own stems and trim are measured once, as any play of it would.
    PlayService(ws).mix_trim_db()
    before = _fingerprint(ws, sid)
    for _ in range(2):
        _hear(ws, sid, mode=mode)
    assert _fingerprint(ws, sid) == before
    assert (ws.project.workspace_path() / "artifacts" / "play_cache").is_dir()


def test_warm_changes_nothing_in_the_project(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    before = json.loads(_fingerprint(ws, sid))
    _svc(ws).warm(sid)
    after = json.loads(_fingerprint(ws, sid))
    for key in ("project", "history", "row"):
        assert after[key] == before[key]


def test_a_preview_of_an_insert_and_a_refused_one_change_nothing_either(ws) -> None:
    sid = _insert(ws, 4.0, [1.0], bed=0.5)
    PlayService(ws).mix_trim_db()
    before = _fingerprint(ws, sid)
    _hear(ws, sid, mode="ab")
    with pytest.raises(CodedValueError):
        _hear(ws, sid, mode="ab", take_index=0)
    assert _fingerprint(ws, sid) == before


# --- refusals: the same code as Accept ---


def _stale(ws) -> str:
    return _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]}, capture=False)


def _no_take(ws) -> tuple[str, dict]:
    return _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]}), {"take_index": 7}


def _insert_with_take(ws) -> tuple[str, dict]:
    return _insert(ws, 4.0, [1.0]), {"take_index": 0}


def _not_recorded(ws) -> str:
    return _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]}, track_ids=["host", "guest"])


def _music(ws) -> str:
    ws.mutate(
        "music",
        "musicked",
        lambda p: p.tracks.append(Track(id="music", label="Music", role=TrackRole.MUSIC)),
    )
    return _replace(ws, 3.0, 5.0, {0: [("music", 0.0, 1.0)]}, track_ids=["music"])


def _pending_edit(ws) -> str:
    ws.mutate(
        "decision",
        "decided",
        lambda p: p.editorial.edit_decisions.append(
            EditDecision(
                id="inside",
                track_id="host",
                type=EditDecisionType.MUTE,
                start=3.5,
                end=4.0,
                timebase="timeline",
                applied=False,
            )
        ),
    )
    return _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})


def _source_gone(ws) -> str:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    ws.mutate(
        "drop",
        "dropped",
        lambda p: setattr(p, "sources", [s for s in p.sources if not s.id.startswith("rec-")]),
    )
    return sid


def _empty(ws) -> str:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    ws.mutate(
        "empty",
        "emptied",
        lambda p: setattr(p.editorial.session_suggestions[0], "takes", []),
    )
    return sid


def _skipped(ws) -> str:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    _svc(ws).skip(sid)
    return sid


@pytest.mark.parametrize(
    ("code", "build"),
    [
        ("stale_anchor", _stale),
        ("track_not_recorded", _not_recorded),
        ("track_not_dialogue", _music),
        ("pending_edits_in_range", _pending_edit),
        ("staged_source_missing", _source_gone),
        ("session_suggestion_empty", _empty),
        ("session_suggestion_not_pending", _skipped),
    ],
)
def test_a_preview_refuses_with_the_code_accept_gives(ws, code, build) -> None:
    sid = build(ws)
    with pytest.raises(CodedValueError) as accepted:
        _svc(ws).accept(sid, override_audio_checks=True)
    assert accepted.value.code == code
    for mode in ("current", "suggested", "ab"):
        with pytest.raises(CodedValueError) as refused:
            _hear(ws, sid, mode=mode)
        assert refused.value.code == code
        assert str(refused.value) == str(accepted.value)


def test_an_unknown_take_and_a_take_on_an_insert_are_refused_as_accept_does(ws) -> None:
    sid, kwargs = _no_take(ws)
    with pytest.raises(CodedValueError) as accepted:
        _svc(ws).accept(sid, **kwargs)
    with pytest.raises(CodedValueError) as refused:
        _hear(ws, sid, **kwargs)
    assert (refused.value.code, str(refused.value)) == ("take_not_found", str(accepted.value))
    ws.mutate("clear", "cleared", lambda p: setattr(p.editorial, "session_suggestions", []))
    sid, kwargs = _insert_with_take(ws)
    with pytest.raises(CodedValueError) as accepted:
        _svc(ws).accept(sid, **kwargs)
    with pytest.raises(CodedValueError) as refused:
        _hear(ws, sid, **kwargs)
    assert (refused.value.code, str(refused.value)) == (
        "take_not_applicable",
        str(accepted.value),
    )


def test_the_refine_gate_holds_a_replace_preview_in_the_same_words(ws) -> None:
    from podcast_mcp.edits.transcript_refine_status import (
        REFINE_GATE,
        TranscriptRefineRequiredError,
    )

    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    with patch.object(
        REFINE_GATE, "assert_clear", side_effect=TranscriptRefineRequiredError("jargon")
    ):
        with pytest.raises(TranscriptRefineRequiredError) as accepted:
            _svc(ws).accept(sid)
        with pytest.raises(TranscriptRefineRequiredError) as refused:
            _hear(ws, sid)
    assert str(refused.value) == str(accepted.value)
    assert refused.value.code == accepted.value.code == "transcript_refine_required"


def test_a_preview_needs_no_override_and_a_bad_mode_is_refused(ws) -> None:
    _words(ws, "guest", ("so", 3.2, 3.5))
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    assert _hear(ws, sid, mode="suggested")["speech"] is not None
    with pytest.raises(CodedValueError) as refused:
        _hear(ws, sid, mode="loud")
    assert refused.value.code == "compare_mode_invalid"


# --- warm ---


def test_warm_renders_both_sides_and_reports_each(ws, monkeypatch) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    warmed = _svc(ws).warm(sid)
    assert warmed["sides"] == {"current": "ready", "suggested": "ready"}
    assert isinstance(warmed["trim_db"], float)
    spy = _Spy(monkeypatch)
    _hear(ws, sid, mode="ab")
    assert spy.accepts == 0


def test_warm_says_unavailable_for_a_session_accept_would_refuse(ws) -> None:
    sid = _stale(ws)
    assert _svc(ws).warm(sid)["sides"] == {"current": "unavailable", "suggested": "unavailable"}


# --- surfaces ---


def test_the_cli_prints_the_result(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    ran = CLI.invoke(
        cli_app,
        [
            "review",
            "preview-session-suggestion",
            "--project",
            str(ws.path),
            "--id",
            sid,
            "--take",
            "0",
            "--mode",
            "ab",
            "--pad",
            "1",
            "--dry-run",
        ],
    )
    assert ran.exit_code == 0, ran.output
    payload = json.loads(ran.output)
    assert payload["suggestion_id"] == sid
    assert payload["mode"] == "ab"
    assert payload["current"]["start_s"] == 2.0
    assert payload["suggested"]["delta_s"] == pytest.approx(0.0)
    assert payload["player"] is None


def test_the_cli_refuses_in_words_with_a_failing_exit(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    ran = CLI.invoke(
        cli_app,
        [
            "review",
            "preview-session-suggestion",
            "--project",
            str(ws.path),
            "--id",
            sid,
            "--take",
            "9",
            "--dry-run",
        ],
    )
    assert ran.exit_code == 1
    assert "has no take 9" in ran.output


def test_the_mcp_tool_returns_the_same_shape(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 3.0)]})
    payload = json.loads(
        hear_session_suggestion_tool(
            str(ws.path), sid, take_index=0, mode="suggested", dry_run=True
        )
    )
    assert set(payload) >= {
        "suggestion_id",
        "kind",
        "take_index",
        "current",
        "suggested",
        "delta_s",
        "speech",
        "wav",
    }
    assert payload["current"] is None
    assert payload["suggested"]["delta_s"] == pytest.approx(1.0)
    assert payload["player"] is None


def test_the_gui_routes_return_the_json_and_the_wav(ws) -> None:
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 3.0)]})
    client = TestClient(create_app())
    info = client.get(
        "/api/session-suggestion/hear",
        params={"path": str(ws.path), "suggestion_id": sid, "mode": "ab"},
    )
    assert info.status_code == 200, info.text
    body = info.json()
    assert body["suggested"]["delta_s"] == pytest.approx(1.0)
    wav = client.get(
        "/api/session-suggestion/hear-wav",
        params={"path": str(ws.path), "suggestion_id": sid, "mode": "suggested"},
    )
    assert wav.status_code == 200
    assert wav.headers["content-type"] == "audio/wav"
    refused = client.get(
        "/api/session-suggestion/hear",
        params={"path": str(ws.path), "suggestion_id": sid, "take_index": 9},
    )
    assert refused.status_code == 400
    assert refused.headers["X-Sharecut-Error-Code"] == "take_not_found"
    missing = client.get(
        "/api/session-suggestion/hear",
        params={"path": str(ws.path), "suggestion_id": "ss-nope"},
    )
    assert missing.status_code == 404
    assert missing.headers["X-Sharecut-Error-Code"] == "session_suggestion_not_found"


def test_the_route_paths_stay_clear_of_the_review_audio_rate_limit() -> None:
    from podcast_mcp.util.rate_limit import is_review_audio_path

    for path in (
        "/api/session-suggestion/hear",
        "/api/session-suggestion/hear-wav",
        "/api/session-suggestion/warm",
    ):
        assert not is_review_audio_path(path)


# --- audit fixes ---


def test_a_take_accept_would_refuse_is_refused_whether_or_not_current_was_rendered(ws) -> None:
    sid = _replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 2.0), ("guest", 0.0, 2.0)], 1: [("host", 0.0, 2.0)]},
        track_ids=["host", "guest"],
    )
    with pytest.raises(CodedValueError) as accepted:
        _svc(ws).accept(sid, take_index=1, override_audio_checks=True)
    assert accepted.value.code == "track_not_recorded"
    for take in (1, 0, 1):
        if take == 0:
            assert _hear(ws, sid, mode="current", take_index=0)["current"] is not None
            continue
        with pytest.raises(CodedValueError) as refused:
            _hear(ws, sid, mode="current", take_index=take)
        assert refused.value.code == "track_not_recorded"


@pytest.mark.parametrize("pad", [float("nan"), float("inf"), -1.0, 10.5])
def test_a_pad_outside_zero_to_ten_seconds_is_refused(ws, pad) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    with pytest.raises(CodedValueError) as refused:
        _hear(ws, sid, pad_sec=pad)
    assert refused.value.code == "pad_sec_invalid"
    assert "pad_sec must be a number of seconds from 0 to 10" in str(refused.value)


@pytest.mark.parametrize("gap", [float("nan"), float("inf"), -0.1, 1e9])
def test_a_gap_outside_zero_to_five_seconds_is_refused(ws, gap) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    with pytest.raises(CodedValueError) as refused:
        _hear(ws, sid, mode="ab", gap_sec=gap)
    assert refused.value.code == "gap_sec_invalid"


def test_warm_of_an_unknown_session_is_not_found_like_the_other_calls(ws) -> None:
    from podcast_mcp.util.coded_error import CodedKeyError

    with pytest.raises(CodedKeyError) as refused:
        _svc(ws).warm("ss-nope")
    assert refused.value.code == "session_suggestion_not_found"


def test_warm_says_failed_for_a_side_that_could_not_be_written(ws, monkeypatch) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    real = SessionSuggestionService._hear

    def failing(self, suggestion_id, **kwargs):
        if kwargs["mode"] == "suggested":
            raise OSError("disk full")
        return real(self, suggestion_id, **kwargs)

    monkeypatch.setattr(SessionSuggestionService, "_hear", failing)
    assert _svc(ws).warm(sid)["sides"] == {"current": "ready", "suggested": "failed"}


def test_the_refine_gate_asks_to_try_again_for_accept_and_preview_alike(ws) -> None:
    from podcast_mcp.services.document.session_suggestion import REPLACE_REFINE_HINT

    assert "then try again" in REPLACE_REFINE_HINT
    assert "accept again" not in REPLACE_REFINE_HINT


def test_the_gui_warm_of_an_unknown_session_is_a_404(ws) -> None:
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    res = TestClient(create_app()).post(
        "/api/session-suggestion/warm", params={"path": str(ws.path), "suggestion_id": "ss-nope"}
    )
    assert res.status_code == 404
    assert res.headers["X-Sharecut-Error-Code"] == "session_suggestion_not_found"
