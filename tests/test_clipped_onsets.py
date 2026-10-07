"""Word starts still missing from their own track after alignment (#1059)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

import bleed_helpers as bh
from podcast_mcp.edits import clipped_onsets
from podcast_mcp.edits.clipped_onsets import flag_clipped_word_starts
from podcast_mcp.edits.comments import add_reply, resolve_comment
from podcast_mcp.edits.transcript_timing import WordTimingTarget
from podcast_mcp.mcp.tools.timeline import set_word_timing_tool
from podcast_mcp.models import (
    Clip,
    SpeakerIngestAlignment,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.pipeline import steps
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.pipeline.service import PipelineService

GATE_LATE_SEC = 0.1
LANE_LATE_SEC = 0.15
# A word ASR places this far before where its own track opens.
ASR_EARLY_SEC = 0.1


def _turn_starts(direct: np.ndarray, *, first_syllable_sec: float = 0.0) -> list[float]:
    """Seconds where a gated track starts talking after at least 0.5 s of silence."""
    starts = []
    last_end = -1.0
    for first, last in bh.spurts(direct):
        syllable = bh.spurts(direct[first:last], gap_sec=0.001)[0]
        if first / bh.RATE - last_end >= 0.5 and syllable[1] / bh.RATE >= first_syllable_sec:
            starts.append(first / bh.RATE)
        last_end = last / bh.RATE
    return starts


def _word(text: str, start: float) -> TranscriptWord:
    return TranscriptWord(text=text, start=round(start, 3), end=round(start + 0.4, 3))


def _align(ws: ProjectWorkspace, **config: object) -> str:
    result = PipelineService(ws).run(
        only_step="align_tracks", unattended=True, config={"align": config} if config else None
    )
    return next(s.message for s in result.steps if s.step == "align_tracks") or ""


def _onset_comments(ws: ProjectWorkspace) -> list[tuple[float, float | None, list[str], str]]:
    return [
        (c.timeline_start, c.timeline_end, c.track_ids, c.body)
        for c in ws.project.comments
        if c.author == "Align tracks"
    ]


def _state(ws: ProjectWorkspace) -> tuple[list[dict], list[tuple]]:
    """Every word and every Align tracks comment, without timestamps."""
    words = [w.model_dump() for t in ws.project.transcripts for w in t.words]
    comments = [
        (c.id, c.body, c.timeline_start, c.timeline_end, c.track_ids, c.resolved)
        for c in ws.project.comments
        if c.author == "Align tracks"
    ]
    return words, comments


def _gated_ws(
    path: Path, gate_late_sec: float = GATE_LATE_SEC, *, turn: int = 1
) -> tuple[ProjectWorkspace, float]:
    """Audra on time, but her gate opens ``gate_late_sec`` into one turn.

    The turn's first syllable is long, so the gate cuts into it; Caleb's mic has the copy.
    """
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    clipped = _turn_starts(audio["audra"], first_syllable_sec=0.22)[turn]
    first = round(clipped * bh.RATE)
    audio["audra"][first : first + round(gate_late_sec * bh.RATE)] = 0.0
    ws = bh.workspace(path, audio)
    normal = next(t for t in _turn_starts(audio["audra"]) if t > clipped + 10.0)
    ws.project.transcripts.append(
        Transcript(track_id="audra", words=[_word("And", clipped), _word("So", normal)])
    )
    ws.save()
    return ws, clipped


@pytest.fixture
def gated(tmp_path: Path) -> tuple[ProjectWorkspace, float, float]:
    """Audra on time, but her gate opens 100 ms into one turn; Caleb's mic has the copy."""
    ws, clipped = _gated_ws(tmp_path)
    normal = ws.project.transcript_for_track("audra").words[1].start
    return ws, clipped, normal


def test_late_gate_flags_the_word_and_snaps_its_start(
    gated: tuple[ProjectWorkspace, float, float],
) -> None:
    ws, clipped, _normal = gated

    summary = _align(ws)

    [(start, end, tracks, body)] = _onset_comments(ws)
    assert start == pytest.approx(clipped, abs=0.04)
    assert end == pytest.approx(clipped + GATE_LATE_SEC, abs=0.04)
    assert tracks == ["audra"]
    assert body.startswith("Audra's “And” starts ")
    assert body.endswith(
        " ms before Audra's track opens. That start is only on Caleb's mic, and another "
        "mic is never used as Audra's audio, so the word may sound clipped. Listen, then "
        "re-record it, keep it, or edit around it."
    )
    word = ws.project.transcript_for_track("audra").words[0]
    assert word.start == pytest.approx(clipped + GATE_LATE_SEC, abs=0.03)
    assert (word.snapped_from, word.trimmed_from) == (round(clipped, 3), None)
    assert "1 word start missing from its own track (see comments)" in summary


def test_word_whose_track_opens_with_its_voice_is_not_flagged(
    gated: tuple[ProjectWorkspace, float, float],
) -> None:
    ws, _clipped, normal = gated

    _align(ws)

    assert [c for c in _onset_comments(ws) if abs(c[0] - normal) < 1.0] == []
    word = ws.project.transcript_for_track("audra").words[1]
    assert (word.start, word.snapped_from) == (normal, None)


def test_rerun_keeps_one_comment_and_the_snapped_start(
    gated: tuple[ProjectWorkspace, float, float],
) -> None:
    ws, clipped, _normal = gated

    _align(ws)
    first = [(c.id, c.created_at, c.updated_at) for c in ws.project.comments]
    snapped = ws.project.transcript_for_track("audra").words[0].model_dump()
    _align(ws)

    assert len(first) == 1
    assert [(c.id, c.created_at, c.updated_at) for c in ws.project.comments] == first
    assert snapped["start"] > clipped
    assert ws.project.transcript_for_track("audra").words[0].model_dump() == snapped


@pytest.mark.parametrize("touch", ["reply", "resolve"])
def test_a_moved_opening_keeps_an_answered_comment_and_adds_none(
    tmp_path: Path, touch: str
) -> None:
    """The comment follows the word, not where its track happens to open this run."""
    # This turn opens at 142.35 s with an 80 ms gate and at 142.38 s with a 110 ms one.
    ws, _clipped = _gated_ws(tmp_path / "a", gate_late_sec=0.08, turn=2)
    _align(ws)
    [comment] = ws.project.comments
    if touch == "reply":
        add_reply(ws.project, comment.id, body="Keeping it.", author="Host")
    else:
        resolve_comment(ws.project, comment.id, by="Host")
    ws.save()
    # The same take, but the gate opens 30 ms later.
    later, _ = _gated_ws(tmp_path / "b", gate_late_sec=0.11, turn=2)
    later_audio = Path(later.project.meta.workspace_dir) / "raw" / "audra.wav"
    (Path(ws.project.meta.workspace_dir) / "raw" / "audra.wav").write_bytes(
        later_audio.read_bytes()
    )

    _align(ws)

    [kept] = ws.project.comments
    assert (kept.id, kept.body, kept.timeline_start) == (
        comment.id,
        comment.body,
        comment.timeline_start,
    )
    assert (len(kept.replies), kept.resolved) == ((1, False) if touch == "reply" else (0, True))


def _unsolved_ws(path: Path) -> tuple[ProjectWorkspace, list[float]]:
    """Audra's whole track plays 150 ms late and her manifest pin keeps it there.

    Her words start ``ASR_EARLY_SEC`` before her track opens, as ASR often places them.
    """
    audio = bh.tracks(
        bleed={"caleb": {"audra": 0.0}}, latency={"audra": LANE_LATE_SEC}, gated=("audra",)
    )
    turns = _turn_starts(audio["audra"])[2:5]
    ws = bh.workspace(path, audio)
    ws.project.meta.ingest_alignment = {
        "Audra": SpeakerIngestAlignment(
            session_start_in_file_sec=0.0, content_align_sec=0.0, align_method="manual"
        )
    }
    ws.project.transcripts.append(
        Transcript(
            track_id="audra",
            words=[_word(f"w{i}", t - ASR_EARLY_SEC) for i, t in enumerate(turns)],
        )
    )
    ws.save()
    return ws, turns


@pytest.fixture
def unsolved(tmp_path: Path) -> tuple[ProjectWorkspace, list[float]]:
    return _unsolved_ws(tmp_path)


def test_unsolved_offset_leaves_one_comment_for_the_lane(
    unsolved: tuple[ProjectWorkspace, list[float]],
) -> None:
    ws, turns = unsolved

    summary = _align(ws)

    [comment] = [c for c in ws.project.comments if c.author == "Align tracks"]
    assert comment.id.startswith("onset-lane-")
    assert comment.track_ids == ["audra"]
    assert comment.timeline_start == pytest.approx(turns[0] - LANE_LATE_SEC, abs=0.04)
    assert comment.timeline_end == pytest.approx(turns[0], abs=0.04)
    assert comment.body.startswith(
        "Audra's track runs about 150 ms behind Caleb's mic, so 3 word starts are only on "
        "Caleb's mic: "
    )
    assert comment.body.count("“w") == 3
    assert comment.body.endswith(
        "Another mic is never used as Audra's audio, so these words may sound clipped. "
        "Aligning Audra's track would fix them; re-running Align tracks then withdraws this "
        "comment. Otherwise listen, then re-record, keep, or edit around each word."
    )
    words = ws.project.transcript_for_track("audra").words
    assert [w.start for w in words] == pytest.approx(turns, abs=0.03)
    assert [w.snapped_from for w in words] == [round(t - ASR_EARLY_SEC, 3) for t in turns]
    assert "3 word starts missing from their own track (see comments)" in summary


def test_aligning_the_lane_withdraws_its_open_flags_and_keeps_resolved_ones(
    unsolved: tuple[ProjectWorkspace, list[float]],
) -> None:
    ws, _turns = unsolved
    _align(ws)
    kept = ws.project.comments[0]
    kept.resolved, kept.resolved_by = True, "host"
    ws.save()

    _align(ws, realign=True)

    assert [c.id for c in ws.project.comments] == [kept.id]


def test_default_then_realign_equals_a_fresh_realign(tmp_path: Path) -> None:
    rerun, turns = _unsolved_ws(tmp_path / "rerun")
    fresh, _ = _unsolved_ws(tmp_path / "fresh")

    _align(rerun)
    _align(rerun, realign=True)
    _align(fresh, realign=True)

    assert [c.model_dump() for c in rerun.project.clips] == [
        c.model_dump() for c in fresh.project.clips
    ]
    assert _state(rerun) == _state(fresh)
    words = rerun.project.transcript_for_track("audra").words
    assert [(w.start, w.snapped_from) for w in words] == [
        (round(t - ASR_EARLY_SEC, 3), None) for t in turns
    ]


def _place_audra(ws: ProjectWorkspace, *, aligned: bool) -> None:
    """Audra's clip where her pin keeps it, or slipped onto her copy on Caleb's mic."""
    shift = LANE_LATE_SEC if aligned else 0.0
    ws.project.clips = [
        c
        if c.track_id != "audra"
        else Clip(
            id=c.id,
            track_id="audra",
            source_start=shift,
            source_end=bh.DURATION_SEC,
            timeline_start=0.0,
        )
        for c in ws.project.clips
    ]


@pytest.mark.parametrize("first_aligned", [False, True])
def test_the_pass_depends_only_on_where_the_lanes_sit_now(
    tmp_path: Path, first_aligned: bool
) -> None:
    rerun, _ = _unsolved_ws(tmp_path / "rerun")
    fresh, _ = _unsolved_ws(tmp_path / "fresh")

    _place_audra(rerun, aligned=first_aligned)
    flag_clipped_word_starts(rerun.project)
    _place_audra(rerun, aligned=not first_aligned)
    flag_clipped_word_starts(rerun.project)
    _place_audra(fresh, aligned=not first_aligned)
    flag_clipped_word_starts(fresh.project)

    assert _state(rerun) == _state(fresh)
    assert bool(_state(fresh)[1]) is first_aligned


def test_fewer_than_two_dialogue_tracks_withdraws_open_flags_and_restores_starts(
    gated: tuple[ProjectWorkspace, float, float],
) -> None:
    ws, clipped, _normal = gated
    _align(ws)
    for track in ws.project.tracks:
        if track.id != "audra":
            track.role = TrackRole.MUSIC
    ws.save()

    _align(ws)

    assert _onset_comments(ws) == []
    word = ws.project.transcript_for_track("audra").words[0]
    assert (word.start, word.snapped_from) == (round(clipped, 3), None)


def test_unreadable_audio_leaves_flags_and_starts_alone(
    gated: tuple[ProjectWorkspace, float, float],
) -> None:
    ws, _clipped, _normal = gated
    _align(ws)
    before = _state(ws)
    (Path(ws.project.meta.workspace_dir) / "raw" / "caleb.wav").write_bytes(b"not audio")

    assert flag_clipped_word_starts(ws.project) == []
    assert _state(ws) == before


def test_a_failing_pass_restores_the_clips_align_moved(
    unsolved: tuple[ProjectWorkspace, list[float]], monkeypatch: pytest.MonkeyPatch
) -> None:
    ws, _turns = unsolved
    before = [c.model_dump() for c in ws.project.clips]

    def fail(*_args: object) -> list:
        raise RuntimeError("boom")

    monkeypatch.setattr(clipped_onsets, "flag_clipped_word_starts", fail)
    with pytest.raises(RuntimeError):
        steps.align_tracks(ws.project, {"align": {"realign": True}})

    assert [c.model_dump() for c in ws.project.clips] == before


def _crosstalk_ws(path: Path, *, mic_word: bool) -> tuple[ProjectWorkspace, float]:
    """Caleb makes a quiet sound, at his copy of Audra's level, that runs into her turn."""
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    turn = _turn_starts(audio["audra"])[3]
    first, last = round((turn - 0.25) * bh.RATE), round((turn + 0.1) * bh.RATE)
    noise = np.random.default_rng(3).standard_normal(last - first)
    audio["caleb"][first:last] += noise * np.hanning(last - first) * 0.02
    ws = bh.workspace(path, audio)
    ws.project.transcripts.append(Transcript(track_id="audra", words=[_word("Right", turn)]))
    if mic_word:
        ws.project.transcripts.append(
            Transcript(
                track_id="caleb",
                words=[TranscriptWord(text="Mm.", start=round(turn - 0.25, 3), end=round(turn, 3))],
            )
        )
    ws.save()
    return ws, turn


def test_the_mics_own_transcribed_sound_before_the_turn_is_not_flagged(tmp_path: Path) -> None:
    ws, turn = _crosstalk_ws(tmp_path, mic_word=True)

    _align(ws)

    assert [c for c in _onset_comments(ws) if abs(c[0] - turn) < 1.0] == []
    assert ws.project.transcript_for_track("audra").words[0].snapped_from is None


def test_a_transcribed_copy_of_the_same_word_still_flags(
    tmp_path: Path,
) -> None:
    """ASR on the other mic often writes the copy down too; same word, so still a copy."""
    ws, clipped = _gated_ws(tmp_path)
    ws.project.transcripts.append(
        Transcript(
            track_id="caleb",
            words=[
                TranscriptWord(text="and,", start=round(clipped, 3), end=round(clipped + 0.4, 3))
            ],
        )
    )
    ws.save()

    _align(ws)

    assert [round(c[0], 1) for c in _onset_comments(ws)] == [pytest.approx(clipped, abs=0.1)]


def test_a_third_speaker_in_the_lead_is_not_flagged(tmp_path: Path) -> None:
    """Lana talks just before Audra's turn; Caleb's mic hears Lana's copy, not Audra's."""
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0, "lana": 0.0}}, gated=("audra",))
    turn = _turn_starts(audio["audra"])[3]
    first, last = round((turn - 0.25) * bh.RATE), round((turn + 0.05) * bh.RATE)
    burst = np.random.default_rng(5).standard_normal(last - first) * np.hanning(last - first) * 0.2
    audio["lana"][first:last] += burst
    audio["caleb"][first:last] += 0.1 * burst
    ws = bh.workspace(tmp_path, audio)
    ws.project.transcripts.append(Transcript(track_id="audra", words=[_word("Right", turn)]))
    ws.save()

    _align(ws)

    assert [c for c in _onset_comments(ws) if abs(c[0] - turn) < 1.0] == []


def _first_word(ws: ProjectWorkspace) -> TranscriptWord:
    return ws.project.transcript_for_track("audra").words[0]


def _edit_by_service(ws: ProjectWorkspace, start: float, end: float) -> None:
    target = WordTimingTarget("audra", None, 0)
    service = EditService(ws)
    context = service.word_timing_context(target)
    service.set_word_timing(target, context["expected_token"], start, end)


def _edit_by_mcp_tool(ws: ProjectWorkspace, start: float, end: float) -> None:
    set_word_timing_tool(str(ws.path), "audra", 0, start, end)


@pytest.mark.parametrize("edit", [_edit_by_service, _edit_by_mcp_tool])
@pytest.mark.parametrize("after_opening", [True, False])
def test_a_person_s_word_timing_survives_the_next_align_run(
    gated: tuple[ProjectWorkspace, float, float], edit, after_opening: bool
) -> None:
    ws, clipped, _normal = gated
    _align(ws)
    snapped = _first_word(ws)
    assert snapped.snapped_from is not None and len(_onset_comments(ws)) == 1
    # Either side of where the track opens: the pass must not move the person's start.
    start = round(snapped.start + 0.05, 3) if after_opening else round(clipped - 0.02, 3)
    end = round(start + 0.4, 3)

    edit(ws, start, end)
    ws = ProjectWorkspace.open(ws.path)
    _align(ws)
    ws = ProjectWorkspace.open(ws.path)

    word = _first_word(ws)
    assert (word.start, word.end) == (start, end)
    assert word.snapped_from is None
    assert _onset_comments(ws) == []
    _align(ws)
    assert (_first_word(ws).start, _first_word(ws).snapped_from) == (start, None)


def test_a_pass_that_retimes_a_word_clears_its_snap_and_a_persons_edit_mark() -> None:
    from podcast_mcp.engines.word_align import apply_word_spans

    word = TranscriptWord(text="And", start=2.0, end=2.4, snapped_from=1.9, timing_edited=True)

    apply_word_spans([word], [(2.1, 2.5)])

    assert (word.start, word.end, word.snapped_from, word.timing_edited) == (2.1, 2.5, None, False)
