"""Edit modes (#1137): ripple and gap for trim, delete, cut and paste, the ripple scope
rule (every dialogue track moves together) and the speech guard (a ripple that cuts
another track's speech asks first, and applies once confirmed)."""

from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import pytest
from typer.testing import CliRunner

from history_helpers import history_move
from podcast_mcp.cli.main import app
from podcast_mcp.edits.cut_speech import (
    CutSpeechConfirmation,
    SourceExtent,
    SpeechClearance,
    clear_ripple,
)
from podcast_mcp.edits.decisions import apply_auto_edits
from podcast_mcp.edits.timeline_ops import plan_ripple_delete
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EditMode,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document.boundary import TrimBoundaryTarget, boundary_context
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.util.timebase import SourceSec

SR = 16_000
DUR = 30.0
GUEST_WORDS = 'This also cuts Guest\'s speech at 0:10.1 ("so the plan"). '
CUT_ANYWAY = "Cut anyway, or leave a gap to keep it."


def _write_wav(path: Path, signal: np.ndarray) -> None:
    data = (np.clip(signal, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(data.tobytes())


def _tone(freq: float) -> np.ndarray:
    t = np.arange(int(DUR * SR)) / SR
    return 0.1 * np.sin(2 * np.pi * freq * t)


def _words(*rows: tuple[str, float, float, bool]) -> list[TranscriptWord]:
    return [
        TranscriptWord(text=text, start=start, end=end, suppressed=suppressed)
        for text, start, end, suppressed in rows
    ]


@pytest.fixture
def episode(minimal_project: Path) -> Path:
    """Host talks throughout; Guest is room tone except "so the plan" (10.1 s) and an
    untranscribed remark at 13.0-13.5 s. A suppressed bleed word sits at 16 s.

    Host has clips h1 (0-8) and h2 (8-20, continuous source); Guest has g1 (0-20).
    """
    project = load_project(minimal_project)
    raw = project.raw_dir()
    _write_wav(raw / "host.wav", _tone(220))
    guest = np.random.default_rng(7).normal(0.0, 0.0003, int(DUR * SR))
    remark = _tone(330)
    for start, end in ((10.0, 11.0), (13.0, 13.5)):
        guest[int(start * SR) : int(end * SR)] = remark[int(start * SR) : int(end * SR)]
    _write_wav(raw / "guest.wav", guest)
    project.timeline.tracks = [
        Track(
            id=tid,
            label=name,
            speaker=name,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=DUR, sample_rate=SR),
        )
        for tid, name in (("host", "Host"), ("guest", "Guest"))
    ]
    project.timeline.clips = [
        Clip(id="h1", track_id="host", source_start=0.0, source_end=8.0, timeline_start=0.0),
        Clip(id="h2", track_id="host", source_start=8.0, source_end=20.0, timeline_start=8.0),
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=20.0, timeline_start=0.0),
    ]
    project.timeline.duration_sec = 20.0
    project.transcripts = [
        Transcript(
            track_id="host",
            words=_words(("hello", 1.0, 1.4, False), ("world", 9.0, 9.5, False)),
        ),
        Transcript(
            track_id="guest",
            words=_words(
                ("so", 10.1, 10.3, False),
                ("the", 10.35, 10.5, False),
                ("plan", 10.55, 10.9, False),
                ("bleed", 16.0, 16.3, True),
            ),
        ),
    ]
    save_project(project)
    return minimal_project


def _clips(path: Path) -> dict[str, tuple[str, float, float, float]]:
    return {
        c.id: (c.track_id, c.source_start, c.source_end, c.timeline_start)
        for c in load_project(path).clips
    }


def _geometry(path: Path) -> list[tuple[str, float, float, float]]:
    return sorted(
        (c.track_id, c.source_start, c.source_end, c.timeline_start)
        for c in load_project(path).clips
    )


def _timeline_at(path: Path, track_id: str, source_sec: float) -> float | None:
    mapped = SessionTimeline(load_project(path)).source_to_timeline(track_id, SourceSec(source_sec))
    return None if mapped is None else round(float(mapped), 6)


def _assert_in_sync(path: Path, probes: tuple[float, ...], shift: float) -> None:
    """Every dialogue track maps the same surviving source time to the same place."""
    for sec in probes:
        expected = round(sec + shift, 6)
        assert _timeline_at(path, "host", sec) == expected, sec
        assert _timeline_at(path, "guest", sec) == expected, sec


def _offsets(path: Path, probes: tuple[float, ...]) -> list[float]:
    """Host minus guest timeline position of each source time: their relative timing."""
    out = []
    for sec in probes:
        host, guest = _timeline_at(path, "host", sec), _timeline_at(path, "guest", sec)
        assert host is not None and guest is not None, sec
        out.append(round(host - guest, 6))
    return out


def _trim(
    path: Path,
    clip_id: str,
    edge: str,
    source_sec: float,
    mode: EditMode,
    *,
    confirm: bool = False,
) -> dict:
    ws = ProjectWorkspace.open(path)
    token = boundary_context(
        ws.project, TrimBoundaryTarget(clip_id=clip_id, edge=edge, mode=mode)
    ).token
    return EditService(ws).trim_clip_edge(
        clip_id, edge, source_sec, mode=mode, expected_token=token, confirm_cut_speech=confirm
    )


def _history_len(path: Path) -> int:
    return len(load_project(path).history.entries)


# --- Ripple scope: every dialogue track moves together -----------------------------


def test_ripple_trim_shortening_moves_every_dialogue_track_by_the_same_amount(episode):
    out = _trim(episode, "h1", "out", 6.0, EditMode.RIPPLE)

    assert "needs_confirmation" not in out
    assert out["affected_tracks"] == ["host", "guest"]
    clips = _clips(episode)
    assert clips["h1"] == ("host", 0.0, 6.0, 0.0)
    assert clips["h2"] == ("host", 8.0, 20.0, 6.0)
    _assert_in_sync(episode, (8.5, 10.2, 19.0), -2.0)
    assert _timeline_at(episode, "guest", 0.5) == 0.5
    assert _timeline_at(episode, "guest", 7.0) is None


def test_ripple_trim_extending_opens_silence_on_tracks_without_an_edge_there(episode):
    project = load_project(episode)
    project.clips = [
        Clip(id="h1", track_id="host", source_start=0.0, source_end=8.0, timeline_start=0.0),
        Clip(id="h2", track_id="host", source_start=8.0, source_end=20.0, timeline_start=8.0),
        Clip(id="h3", track_id="host", source_start=22.0, source_end=27.0, timeline_start=20.0),
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=25.0, timeline_start=0.0),
    ]
    save_project(project)
    before = _offsets(episode, (23.0, 24.0))

    out = _trim(episode, "h2", "out", 21.0, EditMode.RIPPLE)

    assert out["affected_tracks"] == ["host", "guest"]
    assert _clips(episode)["h3"] == ("host", 22.0, 27.0, 21.0)
    assert _offsets(episode, (23.0, 24.0)) == before
    assert _timeline_at(episode, "guest", 19.5) == 19.5
    assert _timeline_at(episode, "guest", 20.5) == 21.5  # one second of silence at 20 s


def test_ripple_trim_at_a_session_join_moves_each_tracks_own_edge(episode):
    """After a session-wide cut every track has an edge at the join; extending one
    reveals each track's own cut material, so nobody gets inserted silence."""
    project = load_project(episode)
    project.clips = [
        Clip(id="h1", track_id="host", source_start=0.0, source_end=8.0, timeline_start=0.0),
        Clip(id="h2", track_id="host", source_start=10.0, source_end=20.0, timeline_start=8.0),
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=8.0, timeline_start=0.0),
        Clip(id="g2", track_id="guest", source_start=10.0, source_end=20.0, timeline_start=8.0),
    ]
    save_project(project)

    _trim(episode, "h1", "out", 9.0, EditMode.RIPPLE)

    assert _geometry(episode) == [
        ("guest", 0.0, 9.0, 0.0),
        ("guest", 10.0, 20.0, 9.0),
        ("host", 0.0, 9.0, 0.0),
        ("host", 10.0, 20.0, 9.0),
    ]


# --- The speech guard -------------------------------------------------------------


def test_ripple_trim_over_another_speakers_words_asks_first_and_changes_nothing(episode):
    before, entries = _geometry(episode), _history_len(episode)

    out = _trim(episode, "h2", "out", 10.0, EditMode.RIPPLE)

    confirmation = out["needs_confirmation"]
    assert out["unchanged"] is True
    assert confirmation["reason"] == "cuts_other_speech"
    assert confirmation["message"] == GUEST_WORDS + CUT_ANYWAY
    assert confirmation["confirm_label"] == "Cut anyway"
    assert confirmation["confirm_field"] == "confirm_cut_speech"
    (track,) = confirmation["speech"]["tracks"]
    assert track["track_id"] == "guest"
    assert [(w["text"], w["timeline_start"]) for w in track["words"]] == [
        ("so", 10.1),
        ("the", 10.35),
        ("plan", 10.55),
    ]
    assert confirmation["speech"]["spans"] == [{"start": 10.0, "end": 20.0}]
    assert _geometry(episode) == before
    assert _history_len(episode) == entries


def test_confirmed_ripple_trim_cuts_the_speech_and_records_it(episode):
    project = load_project(episode)
    project.clips[2].source_end = 25.0  # the guest talks on past the host's clip
    save_project(project)

    out = _trim(episode, "h2", "out", 10.0, EditMode.RIPPLE, confirm=True)

    assert "needs_confirmation" not in out
    assert out["cut_speech"]["tracks"][0]["speaker"] == "Guest"
    assert _geometry(episode) == [
        ("guest", 0.0, 10.0, 0.0),
        ("guest", 20.0, 25.0, 10.0),
        ("host", 0.0, 8.0, 0.0),
        ("host", 8.0, 10.0, 8.0),
    ]
    project = load_project(episode)
    record = project.editorial.edit_log[-1]
    assert record.operation == "trim_clip_edge"
    assert [w["text"] for w in record.params["cut_speech"]["tracks"][0]["words"]] == [
        "so",
        "the",
        "plan",
    ]
    guest = next(t for t in project.transcripts if t.track_id == "guest")
    assert [w.text for w in guest.words] == []
    assert [a.word.text for a in guest.archived_words] == ["so", "the", "plan", "bleed"]


def test_own_sound_without_words_needs_confirmation(episode):
    out = _trim(episode, "h2", "out", 12.5, EditMode.RIPPLE)

    confirmation = out["needs_confirmation"]
    assert confirmation["message"] == "This also cuts Guest's speech at 0:13.0. " + CUT_ANYWAY
    (track,) = confirmation["speech"]["tracks"]
    assert track["words"] == []
    assert track["sound_spans"] == [{"start": 13.0, "end": 13.5}]


def test_room_tone_and_suppressed_bleed_words_need_no_confirmation(episode):
    out = _trim(episode, "h2", "out", 14.0, EditMode.RIPPLE)

    assert "needs_confirmation" not in out
    assert _clips(episode)["h2"] == ("host", 8.0, 14.0, 8.0)
    assert _geometry(episode)[0] == ("guest", 0.0, 14.0, 0.0)


def test_deleting_touching_clips_on_two_tracks_asks_for_an_unselected_clips_words(episode):
    """Each selected clip owns only its own extent: Host's h1 does not make Host's "world"
    in the unselected h2 part of the cut, even though Guest's gB touches h1."""
    project = load_project(episode)
    project.timeline.clips = [c for c in project.clips if c.id != "g1"] + [
        Clip(id=cid, track_id="guest", source_start=s, source_end=e, timeline_start=s)
        for cid, s, e in (("gA", 0.0, 8.0), ("gB", 8.0, 12.0), ("gC", 12.0, 20.0))
    ]
    save_project(project)
    service = EditService(ProjectWorkspace.open(episode))
    before = _geometry(episode)

    out = service.delete_clips(["h1", "gB"], mode=EditMode.RIPPLE)

    (track,) = out["needs_confirmation"]["speech"]["tracks"]
    assert track["track_id"] == "host"
    assert [(w["text"], w["timeline_start"]) for w in track["words"]] == [("world", 9.0)]
    assert _geometry(episode) == before


def _quiet_guest(path: Path) -> None:
    """Guest says "so the plan" below the speech level, so only the words show it."""
    guest = np.random.default_rng(7).normal(0.0, 0.0003, int(DUR * SR))
    guest[int(10.0 * SR) : int(11.0 * SR)] = 0.02 * _tone(330)[int(10.0 * SR) : int(11.0 * SR)]
    _write_wav(load_project(path).raw_dir() / "guest.wav", guest)


def test_approving_a_suggested_remove_asks_for_words_the_transcript_has_now(episode):
    _quiet_guest(episode)
    project = load_project(episode)
    guest = next(t for t in project.transcripts if t.track_id == "guest")
    words, guest.words = guest.words, []
    save_project(project)
    service = EditService(ProjectWorkspace.open(episode))
    edit = service.suggest_pending_edit("host", 10.0, 11.0, author="commenter")
    project = load_project(episode)
    next(t for t in project.transcripts if t.track_id == "guest").words = words
    save_project(project)
    before = _geometry(episode)

    direct = service.cut_range(
        10.0, 11.0, mode=EditMode.RIPPLE, track_ids=["host"], use_inaudible_opt=False
    )
    assert direct["needs_confirmation"]["message"] == GUEST_WORDS + CUT_ANYWAY
    asked = service.approve([edit["id"]])

    assert not isinstance(asked, int)
    assert asked.message == GUEST_WORDS + CUT_ANYWAY
    assert _geometry(episode) == before
    assert service.approve([edit["id"]], confirm_cut_speech=True) == 1
    _assert_in_sync(episode, (12.0, 19.0), -1.0)


@pytest.mark.parametrize(
    ("cut", "chosen"),
    [((10.0, 11.0), (10.0, 11.0)), ((12.5, 14.0), (13.0, 13.5))],
    ids=["words", "own-sound"],
)
def test_speech_another_edit_in_the_same_approval_cuts_does_not_ask(episode, cut, chosen):
    """Guest's "so the plan" (words) and untranscribed remark (sound) are cut by a
    Guest decision in the same batch, so Host's ripple over them is not unasked."""
    project = load_project(episode)
    removal = plan_ripple_delete(project, *cut, edited_track_ids=["host"])

    alone = clear_ripple(project, removal, confirm_cut_speech=False)
    batched = clear_ripple(
        project,
        removal,
        confirm_cut_speech=False,
        also_chosen=[SourceExtent("guest", *chosen)],
    )

    assert isinstance(alone, CutSpeechConfirmation)
    assert [t.track_id for t in alone.speech.tracks] == ["guest"]
    assert batched == SpeechClearance(removal)


def test_auto_apply_leaves_a_remove_over_other_words_pending(episode):
    _quiet_guest(episode)
    project = load_project(episode)
    project.edit_decisions = [
        EditDecision(
            id="um",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=10.0,
            end=11.0,
            reason="filler:um",
            review_required=False,
        )
    ]
    before = _geometry(episode)

    assert apply_auto_edits(project) == 0
    assert [e.id for e in project.edit_decisions] == ["um"]
    save_project(project)
    assert _geometry(episode) == before


def test_auto_apply_does_not_count_a_held_back_edit_as_chosen(episode):
    """Guest's cut asks (it would cut Host's "later") and stays pending, so Host's cut
    may not ripple away Guest's "so the plan" as if Guest's cut had chosen it.

    Both speak softly over 10-12 s, so neither cut turns into a track-local punch."""
    _quiet_guest(episode)
    host = _tone(220)
    host[int(10.0 * SR) : int(12.0 * SR)] *= 0.02
    _write_wav(load_project(episode).raw_dir() / "host.wav", host)
    project = load_project(episode)
    host = next(t for t in project.transcripts if t.track_id == "host")
    host.words.append(TranscriptWord(text="later", start=11.5, end=11.8))
    project.edit_decisions = [
        EditDecision(
            id=eid,
            track_id=tid,
            type=EditDecisionType.REMOVE,
            start=start,
            end=end,
            reason="pause:1.0s",
            review_required=False,
        )
        for eid, tid, start, end in (
            ("guest-pause", "guest", 10.0, 12.0),
            ("host-um", "host", 10.0, 11.0),
        )
    ]
    before = _geometry(episode)

    assert apply_auto_edits(project) == 0
    assert sorted(e.id for e in project.edit_decisions) == ["guest-pause", "host-um"]
    save_project(project)
    assert _geometry(episode) == before


def _word_at_the_cut_end(path: Path, guest_in_cut: str, host_until: float) -> None:
    """Guest's "yes" runs 11.2-12.4 by word time, but its voice starts at 11.8.

    Host talks until ``host_until``. Inside the 11.0-11.7 cut, Guest's track holds
    ``guest_in_cut``: room tone, digital silence (a gated Zoom track), or the soft onset
    of "yes" from 11.55.
    """
    noise = np.random.default_rng(7).normal(0.0, 0.0003, int(DUR * SR))
    host = noise.copy()
    host[: int(host_until * SR)] = _tone(220)[: int(host_until * SR)]
    guest = noise.copy()
    voice = slice(int(11.8 * SR), int(12.4 * SR))
    guest[voice] = _tone(330)[voice]
    if guest_in_cut == "onset":
        onset = slice(int(11.55 * SR), int(11.8 * SR))
        guest[onset] = 0.1 * _tone(330)[onset]
    elif guest_in_cut == "digital_silence":
        guest[int(11.0 * SR) : int(11.7 * SR)] = 0.0
    raw = load_project(path).raw_dir()
    _write_wav(raw / "host.wav", host)
    _write_wav(raw / "guest.wav", guest)
    project = load_project(path)
    guest_words = next(t for t in project.transcripts if t.track_id == "guest").words
    guest_words.append(TranscriptWord(text="yes", start=11.2, end=12.4))
    save_project(project)


@pytest.mark.parametrize(
    ("guest_in_cut", "host_until", "asks"),
    [
        ("room_tone", 11.7, False),
        ("digital_silence", 11.7, False),
        ("onset", 11.4, True),
    ],
    ids=["room-tone", "digital-silence", "clipped-onset"],
)
def test_a_word_counts_only_where_its_own_track_sounds_inside_the_cut(
    episode, guest_in_cut, host_until, asks
):
    """Word times run past the voice (Whisper stretches them over silence), so a word
    counts only where its own track has its own sound inside the cut."""
    _word_at_the_cut_end(episode, guest_in_cut, host_until)
    project = load_project(episode)
    removal = plan_ripple_delete(
        project, 11.0, 11.7, edited_track_ids=["host"], use_inaudible_opt=False
    )

    cleared = clear_ripple(project, removal, confirm_cut_speech=False)

    if asks:
        assert isinstance(cleared, CutSpeechConfirmation)
        (track,) = cleared.speech.tracks
        assert [(w.text, w.timeline_start) for w in track.words] == [("yes", 11.2)]
    else:
        assert cleared == SpeechClearance(removal)


def _word_with_a_soft_edge(path: Path, edge: str, below_peak_db: float) -> None:
    """Guest's "okay" has a soft ``edge`` ``below_peak_db`` under its peak, in the cut.

    Host talks from 10.9 to 12.0, through the 11.0-11.7 cut. A ``tail`` word runs
    10.4-11.25 with its peak before the cut and its last 250 ms inside it. An
    ``onset`` word runs 11.2-12.4 with its peak after the cut and its first 150 ms
    inside it.
    """
    noise = np.random.default_rng(7).normal(0.0, 0.0003, int(DUR * SR))
    host = noise.copy()
    talk = slice(int(10.9 * SR), int(12.0 * SR))
    host[talk] = _tone(220)[talk]
    soft = 10 ** (-below_peak_db / 20)
    guest = noise.copy()
    spans = {
        "tail": ((10.4, 11.0), (11.0, 11.25), (10.4, 11.25)),
        "onset": ((11.8, 12.4), (11.55, 11.8), (11.2, 12.4)),
    }
    (a, b), (c, d), word = spans[edge]
    loud, quiet = slice(int(a * SR), int(b * SR)), slice(int(c * SR), int(d * SR))
    guest[loud] = _tone(330)[loud]
    guest[quiet] = soft * _tone(330)[quiet]
    raw = load_project(path).raw_dir()
    _write_wav(raw / "host.wav", host)
    _write_wav(raw / "guest.wav", guest)
    project = load_project(path)
    guest_words = next(t for t in project.transcripts if t.track_id == "guest").words
    guest_words.append(TranscriptWord(text="okay", start=word[0], end=word[1]))
    save_project(project)


@pytest.mark.parametrize("below_peak_db", [6.0, 12.0])
@pytest.mark.parametrize("edge", ["onset", "tail"])
def test_a_soft_word_edge_in_the_cut_asks_while_the_cutting_speaker_talks(
    episode, edge, below_peak_db
):
    """Host's voice on Guest's mic is no reason to drop Guest's quiet start or end of a
    word: only the word's own track being silent in the cut lets the cut through."""
    _word_with_a_soft_edge(episode, edge, below_peak_db)
    project = load_project(episode)
    removal = plan_ripple_delete(
        project, 11.0, 11.7, edited_track_ids=["host"], use_inaudible_opt=False
    )

    cleared = clear_ripple(project, removal, confirm_cut_speech=False)

    assert isinstance(cleared, CutSpeechConfirmation)
    (track,) = cleared.speech.tracks
    assert [w.text for w in track.words] == ["okay"]


def test_ripple_delete_clip_over_another_speakers_words_asks_first(episode):
    service = EditService(ProjectWorkspace.open(episode))
    before = _geometry(episode)

    out = service.delete_clips(["h2"], mode=EditMode.RIPPLE)
    assert out["needs_confirmation"]["message"] == GUEST_WORDS + CUT_ANYWAY
    assert _geometry(episode) == before

    service.delete_clips(["h2"], mode=EditMode.RIPPLE, confirm_cut_speech=True)
    assert _geometry(episode) == [("guest", 0.0, 8.0, 0.0), ("host", 0.0, 8.0, 0.0)]


@pytest.mark.parametrize(
    ("track_ids", "asks"),
    [(["host"], True), (["host", "guest"], False)],
    ids=["host-only", "both-speakers"],
)
def test_ripple_cut_range_protects_only_the_tracks_it_does_not_name(episode, track_ids, asks):
    out = EditService(ProjectWorkspace.open(episode)).cut_range(
        10.0, 11.0, mode=EditMode.RIPPLE, track_ids=track_ids, use_inaudible_opt=False
    )

    assert ("needs_confirmation" in out) is asks
    if not asks:
        _assert_in_sync(episode, (12.0, 19.0), -1.0)


ALL_SPEECH = (
    "This cuts Host's speech at 0:10.0 and Guest's speech at 0:10.1 "
    '("so the plan"). Cut anyway, or choose which tracks to cut.'
)


def test_a_ripple_range_cut_naming_no_tracks_asks_before_cutting_anyones_speech(episode):
    service = EditService(ProjectWorkspace.open(episode))
    before = _geometry(episode)

    asked = service.cut_range(10.0, 11.0, mode=EditMode.RIPPLE, use_inaudible_opt=False)
    assert asked["needs_confirmation"]["message"] == ALL_SPEECH
    assert _geometry(episode) == before

    service.cut_range(
        10.0, 11.0, mode=EditMode.RIPPLE, use_inaudible_opt=False, confirm_cut_speech=True
    )
    _assert_in_sync(episode, (12.0, 19.0), -1.0)


# --- Every command in both modes --------------------------------------------------


def test_ripple_delete_clip_closes_the_span_on_every_track(episode):
    out = EditService(ProjectWorkspace.open(episode)).delete_clips(["h1"], mode=EditMode.RIPPLE)

    assert out["operation"] == "ripple_delete_clips"
    _assert_in_sync(episode, (8.5, 10.2, 19.0), -8.0)


def test_ripple_cut_range_closes_the_span_on_every_track(episode):
    EditService(ProjectWorkspace.open(episode)).cut_range(
        2.0, 4.0, mode=EditMode.RIPPLE, track_ids=["host"], use_inaudible_opt=False
    )

    _assert_in_sync(episode, (4.5, 10.2, 19.0), -2.0)
    assert _timeline_at(episode, "host", 1.0) == 1.0


def test_ripple_paste_opens_time_on_every_track(episode):
    extract = {"track_id": "host", "source_start": 1.0, "source_end": 3.0}
    EditService(ProjectWorkspace.open(episode)).paste_segment(
        5.0, 2.0, [extract], mode=EditMode.RIPPLE
    )

    _assert_in_sync(episode, (6.0, 10.2, 19.0), 2.0)
    assert _timeline_at(episode, "guest", 4.0) == 4.0
    assert ("host", 1.0, 3.0, 5.0) in _geometry(episode)


@pytest.mark.parametrize(
    ("run", "host_after"),
    [
        (
            lambda path: _trim(path, "h2", "out", 18.0, EditMode.GAP),
            [("host", 0.0, 8.0, 0.0), ("host", 8.0, 18.0, 8.0)],
        ),
        (
            lambda path: _trim(path, "h2", "in", 9.0, EditMode.GAP),
            [("host", 0.0, 8.0, 0.0), ("host", 9.0, 20.0, 9.0)],
        ),
        (
            lambda path: EditService(ProjectWorkspace.open(path)).delete_clips(
                ["h1"], mode=EditMode.GAP
            ),
            [("host", 8.0, 20.0, 8.0)],
        ),
        (
            lambda path: EditService(ProjectWorkspace.open(path)).cut_range(
                2.0, 4.0, mode=EditMode.GAP, track_ids=["host"]
            ),
            [("host", 0.0, 2.0, 0.0), ("host", 4.0, 8.0, 4.0), ("host", 8.0, 20.0, 8.0)],
        ),
        (
            lambda path: EditService(ProjectWorkspace.open(path)).paste_segment(
                2.0,
                2.0,
                [{"track_id": "host", "source_start": 12.0, "source_end": 14.0}],
                mode=EditMode.GAP,
            ),
            [
                ("host", 0.0, 2.0, 0.0),
                ("host", 4.0, 8.0, 4.0),
                ("host", 8.0, 20.0, 8.0),
                ("host", 12.0, 14.0, 2.0),
            ],
        ),
    ],
    ids=["trim-out", "trim-in", "delete", "cut", "paste-over"],
)
def test_gap_mode_leaves_an_exact_gap_and_moves_nothing_downstream(episode, run, host_after):
    out = run(episode)

    assert "needs_confirmation" not in out
    geometry = _geometry(episode)
    assert [row for row in geometry if row[0] == "guest"] == [("guest", 0.0, 20.0, 0.0)]
    assert [row for row in geometry if row[0] == "host"] == host_after


def test_gap_trim_cannot_extend_into_the_next_clip(episode):
    out = _trim(episode, "h2", "out", 25.0, EditMode.GAP)
    assert _clips(episode)["h2"] == ("host", 8.0, 25.0, 8.0)

    out = _trim(episode, "h1", "out", 9.0, EditMode.GAP)
    assert out == {"operation": "trim_clip_edge", "unchanged": True}


# --- Document command, undo, Commenter suggestions, CLI, guest MCP ----------------


def _submit(path: Path, command_type: str, payload: dict, **kwargs) -> dict:
    return DocumentSyncService.open(path).submit(
        DocumentCommand(
            type=command_type, payload=payload, client_id="t", client_seq=None, role="viewer"
        ),
        **kwargs,
    )


def _undo(path: Path) -> None:
    _submit(path, "UndoHistory", history_move(path))


def _trim_payload(path: Path, mode: EditMode, **extra) -> dict:
    token = boundary_context(
        load_project(path), TrimBoundaryTarget(clip_id="h2", edge="out", mode=mode)
    ).token
    return {
        "clip_id": "h2",
        "edge": "out",
        "source_sec": 10.0,
        "mode": mode.value,
        "expected_token": token,
        **extra,
    }


def test_document_command_returns_the_confirmation_then_applies_and_undoes(episode):
    before = _geometry(episode)

    asked = _submit(episode, "TrimClipEdge", _trim_payload(episode, EditMode.RIPPLE))
    assert asked["ok"] is True
    assert asked["needs_confirmation"]["message"] == GUEST_WORDS + CUT_ANYWAY
    assert _geometry(episode) == before

    applied = _submit(
        episode,
        "TrimClipEdge",
        _trim_payload(episode, EditMode.RIPPLE, confirm_cut_speech=True),
    )
    assert "needs_confirmation" not in applied
    assert _geometry(episode) != before

    _undo(episode)
    assert _geometry(episode) == before


@pytest.mark.parametrize(
    ("command_type", "payload"),
    [
        ("DeleteClip", {"clip_id": "h1", "mode": "ripple"}),
        ("DeleteClip", {"clip_id": "h1", "mode": "gap"}),
        ("CutRange", {"start": 2.0, "end": 4.0, "mode": "ripple", "track_ids": ["host"]}),
        ("CutRange", {"start": 2.0, "end": 4.0, "mode": "gap", "track_ids": ["host"]}),
        (
            "PasteSegment",
            {
                "insert_at": 5.0,
                "duration": 2.0,
                "mode": "ripple",
                "extracts": [{"track_id": "host", "source_start": 1.0, "source_end": 3.0}],
            },
        ),
        (
            "PasteSegment",
            {
                "insert_at": 5.0,
                "duration": 2.0,
                "mode": "gap",
                "extracts": [{"track_id": "host", "source_start": 1.0, "source_end": 3.0}],
            },
        ),
    ],
    ids=["delete-ripple", "delete-gap", "cut-ripple", "cut-gap", "paste-ripple", "paste-gap"],
)
def test_each_mode_of_each_command_undoes_in_one_step(episode, command_type, payload):
    before = _geometry(episode)

    _submit(episode, command_type, payload)
    assert _geometry(episode) != before

    _undo(episode)
    assert _geometry(episode) == before


def test_gap_trim_undoes_in_one_step(episode):
    before = _geometry(episode)
    _submit(episode, "TrimClipEdge", _trim_payload(episode, EditMode.GAP))
    assert _clips(episode)["h2"] == ("host", 8.0, 10.0, 8.0)
    _undo(episode)
    assert _geometry(episode) == before


def test_a_commenters_ripple_suggestion_records_that_approval_must_confirm(episode):
    service = EditService(ProjectWorkspace.open(episode))
    suggestion = service.delete_clips(["h2"], mode=EditMode.RIPPLE, propose=True)
    (edit,) = suggestion["edits"]
    assert edit["scope"] == "session"
    assert [w["text"] for w in edit["cut_speech"]["tracks"][0]["words"]] == ["so", "the", "plan"]
    before = _geometry(episode)

    asked = service.approve([edit["id"]])
    assert asked.message == GUEST_WORDS + CUT_ANYWAY
    assert _geometry(episode) == before

    assert service.approve([edit["id"]], confirm_cut_speech=True) == 1
    assert _geometry(episode) == [("guest", 0.0, 8.0, 0.0), ("host", 0.0, 8.0, 0.0)]


def test_cli_trim_asks_for_yes_before_cutting_speech(episode):
    runner = CliRunner()
    args = ["edit", "trim-clip", "--project", str(episode), "--clip", "h2"]
    args += ["--edge", "out", "--source-sec", "10", "--mode", "ripple"]
    before = _geometry(episode)

    refused = runner.invoke(app, args)
    assert refused.exit_code == 1
    assert GUEST_WORDS + CUT_ANYWAY in refused.stderr
    assert "Run again with --yes to cut anyway." in refused.stderr
    assert _geometry(episode) == before

    applied = runner.invoke(app, [*args, "--yes"])
    assert applied.exit_code == 0, applied.output
    assert json.loads(applied.stdout)["cut_speech"]["tracks"][0]["track_id"] == "guest"


def test_guest_mcp_returns_the_confirmation_and_accepts_the_flag(episode, sample_wav, monkeypatch):
    from podcast_mcp.edits.share_capabilities import capabilities_for_role
    from test_guest_document_gate import _mcp_call, _mcp_share

    token = _mcp_share(
        episode, sample_wav, monkeypatch, capabilities_for_role("editor", with_mcp=True)
    )
    before = _geometry(episode)

    def delete(**extra) -> dict:
        body = {"type": "DeleteClip", "payload": {"clip_id": "h2", "mode": "ripple", **extra}}
        reply = _mcp_call(token, "guest_submit_document_command", body)
        return json.loads(reply["result"]["content"][0]["text"])

    asked = delete()
    assert asked["needs_confirmation"]["message"] == GUEST_WORDS + CUT_ANYWAY
    assert _geometry(episode) == before

    applied = delete(confirm_cut_speech=True)
    assert "needs_confirmation" not in applied
    assert _geometry(episode) == [("guest", 0.0, 8.0, 0.0), ("host", 0.0, 8.0, 0.0)]


@pytest.mark.parametrize(("answer", "cuts"), [("n\n", False), ("y\n", True)], ids=["no", "yes"])
def test_cli_asks_at_a_terminal_before_a_range_cut_naming_no_tracks(
    episode, monkeypatch, answer, cuts
):
    from types import SimpleNamespace

    import podcast_mcp.cli.cut_speech as cli_cut_speech

    monkeypatch.setattr(
        cli_cut_speech, "sys", SimpleNamespace(stdin=SimpleNamespace(isatty=lambda: True))
    )
    args = ["edit", "ripple-delete", "--project", str(episode), "--start", "10", "--end", "11"]
    before = _geometry(episode)

    result = CliRunner().invoke(app, [*args, "--no-inaudible-opt"], input=answer)

    assert f"{ALL_SPEECH}\nCut anyway? [y/N]: " in result.stdout
    if cuts:
        assert result.exit_code == 0, result.output
        _assert_in_sync(episode, (12.0, 19.0), -1.0)
    else:
        assert result.exit_code == 1
        assert "Nothing changed. Run again with --yes to cut anyway." in result.stderr
        assert _geometry(episode) == before


def test_guest_mcp_commenter_suggests_a_ripple_and_the_editor_confirms_it(
    episode, sample_wav, monkeypatch
):
    from podcast_mcp.edits.share_capabilities import capabilities_for_role
    from test_guest_document_gate import _mcp_call, _mcp_share

    def share(role: str) -> str:
        caps = capabilities_for_role(role, with_mcp=True)
        return _mcp_share(episode, sample_wav, monkeypatch, caps)

    def submit(token: str, command_type: str, payload: dict) -> dict:
        body = {"type": command_type, "payload": payload}
        reply = _mcp_call(token, "guest_submit_document_command", body)
        return json.loads(reply["result"]["content"][0]["text"])

    commenter, editor = share("commenter"), share("editor")
    before = _geometry(episode)

    submit(commenter, "DeleteClip", {"clip_id": "h2", "mode": "ripple"})
    (suggestion,) = load_project(episode).edit_decisions
    assert suggestion.cut_speech is not None
    assert _geometry(episode) == before

    asked = submit(editor, "ApproveEdits", {"ids": [suggestion.id]})
    assert asked["needs_confirmation"]["message"] == GUEST_WORDS + CUT_ANYWAY
    assert _geometry(episode) == before

    applied = submit(editor, "ApproveEdits", {"ids": [suggestion.id], "confirm_cut_speech": True})
    assert "needs_confirmation" not in applied
    assert _geometry(episode) == [("guest", 0.0, 8.0, 0.0), ("host", 0.0, 8.0, 0.0)]


def test_host_mcp_delete_clips_ripple_asks_then_cuts_when_confirmed(episode):
    from podcast_mcp.mcp.tools import timeline as mcp_timeline

    before = _geometry(episode)

    asked = json.loads(mcp_timeline.delete_clips_tool(str(episode), ["h2"], mode="ripple"))
    assert asked["needs_confirmation"]["message"] == GUEST_WORDS + CUT_ANYWAY
    assert _geometry(episode) == before

    mcp_timeline.delete_clips_tool(str(episode), ["h2"], mode="ripple", confirm_cut_speech=True)
    assert _geometry(episode) == [("guest", 0.0, 8.0, 0.0), ("host", 0.0, 8.0, 0.0)]


def test_cli_delete_clips_ripple_asks_for_yes_before_cutting_speech(episode):
    runner = CliRunner()
    args = ["edit", "delete-clips", "--project", str(episode), "--ids", "h2", "--mode", "ripple"]
    before = _geometry(episode)

    refused = runner.invoke(app, args)
    assert refused.exit_code == 1
    assert GUEST_WORDS + CUT_ANYWAY in refused.stderr
    assert _geometry(episode) == before

    applied = runner.invoke(app, [*args, "--yes"])
    assert applied.exit_code == 0, applied.output
    assert _geometry(episode) == [("guest", 0.0, 8.0, 0.0), ("host", 0.0, 8.0, 0.0)]
