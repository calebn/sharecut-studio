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
from podcast_mcp.util.timebase import clock_label

# A gate that opens this far into a word cuts that much of its start off.
GATE_LATE_SEC = 0.15
# A track that plays this far behind its copy on the other mic.
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


LATE_TAIL = (
    "on Audra's track but plays that late in the mix, so this is left over from alignment, "
    "not a clipped start. Aligning Audra's track there would fix it; re-running Align "
    "tracks then withdraws this comment."
)


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

    The turn's first syllable is long, so the gate cuts into it: her track opens mid-word,
    straight at the word's level, in step with the copy on Caleb's mic.
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
    """Audra on time, but her gate cuts the first 150 ms off one turn; Caleb's mic has it."""
    ws, clipped = _gated_ws(tmp_path)
    normal = ws.project.transcript_for_track("audra").words[1].start
    return ws, clipped, normal


def test_a_gate_that_cuts_off_a_word_s_start_flags_it_and_snaps_its_start(
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


def _late_word_ws(path: Path) -> tuple[ProjectWorkspace, float]:
    """One of Audra's turns is whole on her track but plays ``LANE_LATE_SEC`` late there.

    Her track opens with the word's own attack; its sound matches Caleb's copy shifted back
    by the lead. Her words sit where her own track has them.
    """
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    turn = _turn_starts(audio["audra"], first_syllable_sec=0.22)[1]
    audio["audra"] = bh.relatency(
        audio["audra"], lambda start: LANE_LATE_SEC if abs(start - turn) < 1e-3 else 0.0
    )
    ws = bh.workspace(path, audio)
    ws.project.transcripts.append(
        Transcript(track_id="audra", words=[_word("And", turn + LANE_LATE_SEC)])
    )
    ws.save()
    return ws, turn


def test_a_word_whole_but_late_on_its_own_track_is_an_alignment_residual(
    tmp_path: Path,
) -> None:
    ws, turn = _late_word_ws(tmp_path)

    report = flag_clipped_word_starts(ws.project)

    assert report.flagged == []
    [late] = report.late
    assert late.lead.late_sec == pytest.approx(LANE_LATE_SEC, abs=0.01)
    assert late.lead.copy_sec == pytest.approx(turn, abs=0.04)
    assert (
        report.note()
        == "audra: 1 word start late on its own track (150 ms; alignment residual, see comments)"
    )
    word = ws.project.transcript_for_track("audra").words[0]
    assert (word.start, word.snapped_from) == (round(turn + LANE_LATE_SEC, 3), None)
    [comment] = ws.project.comments
    assert comment.id.startswith("onset-lane-")
    assert comment.track_ids == ["audra"]
    assert comment.body == (
        "Audra's track runs late against Caleb's mic at 1 word start: "
        f"{clock_label(late.lead.copy_sec)} “And” (150 ms). The word is whole " + LATE_TAIL
    )


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


def test_a_lane_left_late_gets_one_alignment_comment_and_no_word_moves(
    unsolved: tuple[ProjectWorkspace, list[float]],
) -> None:
    ws, turns = unsolved

    summary = _align(ws)

    [comment] = [c for c in ws.project.comments if c.author == "Align tracks"]
    assert comment.id.startswith("onset-lane-")
    assert comment.track_ids == ["audra"]
    assert comment.timeline_start == pytest.approx(turns[0] - LANE_LATE_SEC, abs=0.04)
    assert comment.timeline_end == pytest.approx(turns[0], abs=0.04)
    assert comment.body.startswith("Audra's track runs late against Caleb's mic at 3 word starts: ")
    assert comment.body.count(" ms)") == comment.body.count("(150 ms)") == 3
    assert comment.body.endswith(
        "Each word is whole on Audra's track but plays that late in the mix, so this is left "
        "over from alignment, not a clipped start. Aligning Audra's track there would fix "
        "them; re-running Align tracks then withdraws this comment."
    )
    words = ws.project.transcript_for_track("audra").words
    assert [(w.start, w.snapped_from) for w in words] == [
        (round(t - ASR_EARLY_SEC, 3), None) for t in turns
    ]
    assert summary.endswith(
        "; audra: 3 word starts late on its own track (150 ms; alignment residual, see comments)"
    )
    assert "missing from" not in summary


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

    report = flag_clipped_word_starts(ws.project)
    assert (report.flagged, report.late) == ([], [])
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


@pytest.mark.parametrize("mic_word", [True, False])
def test_the_mics_own_sound_before_the_turn_is_not_flagged(tmp_path: Path, mic_word: bool) -> None:
    """Audra's track opens with her word's own attack, so the earlier sound isn't its start."""
    ws, turn = _crosstalk_ws(tmp_path, mic_word=mic_word)

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


def _gated_with_filler(path: Path) -> tuple[ProjectWorkspace, float]:
    """The gated fixture with a filler right after the clipped "And", for merging edits."""
    ws, clipped = _gated_ws(path)
    ws.project.transcript_for_track("audra").words.insert(1, _word("um", clipped + 0.45))
    ws.save()
    return ws, clipped


def _correct_phrase(ws: ProjectWorkspace, last_index: int, text: str) -> None:
    EditService(ws).correct_phrase("audra", 0, last_index, text)


def _find_replace(ws: ProjectWorkspace, search: str, text: str) -> None:
    service = EditService(ws)
    preview = service.preview_transcript_replacement(search, text, match_case=True)
    assert service.replace_transcript_matches(
        search, text, preview["preview_token"], match_case=True
    )


# Each rebuilds the clipped "And": one word, split into more words, or merged with the next.
PHRASE_EDITS = {
    "correct-phrase-same": lambda ws: _correct_phrase(ws, 0, "and"),
    "correct-phrase-more": lambda ws: _correct_phrase(ws, 0, "And then"),
    "correct-phrase-fewer": lambda ws: _correct_phrase(ws, 1, "And"),
    "replace-more": lambda ws: _find_replace(ws, "And", "And then"),
    "replace-fewer": lambda ws: _find_replace(ws, "And um", "And"),
}


@pytest.mark.parametrize("edit", PHRASE_EDITS.values(), ids=PHRASE_EDITS.keys())
def test_a_phrase_edit_keeps_a_persons_word_timing_through_the_next_align(
    tmp_path: Path, edit
) -> None:
    ws, _clipped = _gated_with_filler(tmp_path)
    _align(ws)
    start = round(_first_word(ws).start + 0.05, 3)
    _edit_by_service(ws, start, round(start + 0.3, 3))

    edit(ProjectWorkspace.open(ws.path))
    ws = ProjectWorkspace.open(ws.path)
    assert (_first_word(ws).start, _first_word(ws).timing_edited) == (start, True)
    _align(ws)
    ws = ProjectWorkspace.open(ws.path)

    word = _first_word(ws)
    assert (word.start, word.snapped_from, word.timing_edited) == (start, None, True)
    assert _onset_comments(ws) == []


def _demote_other_lanes(ws: ProjectWorkspace) -> None:
    for track in ws.project.tracks:
        if track.id != "audra":
            track.role = TrackRole.MUSIC
    ws.save()


@pytest.mark.parametrize("edit", PHRASE_EDITS.values(), ids=PHRASE_EDITS.keys())
def test_a_phrase_edit_keeps_a_snap_that_the_next_runs_restore(tmp_path: Path, edit) -> None:
    ws, clipped = _gated_with_filler(tmp_path)
    _align(ws)
    snapped = (_first_word(ws).start, round(clipped, 3))
    [comment] = _onset_comments(ws)

    edit(ProjectWorkspace.open(ws.path))
    ws = ProjectWorkspace.open(ws.path)
    assert (_first_word(ws).start, _first_word(ws).snapped_from) == snapped
    _align(ws)
    ws = ProjectWorkspace.open(ws.path)

    # Judged again from the original start: the same snap and the same one comment.
    assert (_first_word(ws).start, _first_word(ws).snapped_from) == snapped
    assert [c[:3] for c in _onset_comments(ws)] == [comment[:3]]
    _demote_other_lanes(ws)
    _align(ws)
    ws = ProjectWorkspace.open(ws.path)
    # Nothing flags it any more, so the start goes back to where it was before any snap.
    assert (_first_word(ws).start, _first_word(ws).snapped_from) == (round(clipped, 3), None)


def test_a_rebuilt_phrase_carries_timing_provenance_by_rule() -> None:
    from podcast_mcp.edits.transcript_correct import build_phrase_replacement

    snapped = TranscriptWord(text="And", start=2.0, end=2.4, snapped_from=1.9)
    later = TranscriptWord(text="so", start=2.4, end=2.8, snapped_from=2.3)
    timed = TranscriptWord(text="um", start=2.8, end=3.2, timing_edited=True)

    split = build_phrase_replacement([snapped, later], "And then so")
    merged = build_phrase_replacement([snapped, later], "And")
    with_person = build_phrase_replacement([snapped, timed], "And um")

    # A snap moves to the rebuilt word on its start; one with no such word ends with it.
    assert [(w.snapped_from, w.timing_edited) for w in split] == [
        (1.9, False),
        (None, False),
        (None, False),
    ]
    assert [(w.snapped_from, w.timing_edited) for w in merged] == [(1.9, False)]
    # Any person-timed word makes the whole rebuilt span the person's, with no snap.
    assert [(w.snapped_from, w.timing_edited) for w in with_person] == [(None, True)] * 2
