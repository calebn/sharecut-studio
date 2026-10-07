"""Word starts still missing from their own track after alignment (#1059)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

import bleed_helpers as bh
from podcast_mcp.models import SpeakerIngestAlignment, Transcript, TranscriptWord
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline.service import PipelineService

GATE_LATE_SEC = 0.1
LANE_LATE_SEC = 0.15


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


@pytest.fixture
def gated(tmp_path: Path) -> tuple[ProjectWorkspace, float, float]:
    """Audra on time, but her gate opens 100 ms into one turn; Caleb's mic has the copy."""
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    clipped = _turn_starts(audio["audra"], first_syllable_sec=0.22)[1]
    normal = next(t for t in _turn_starts(audio["audra"]) if t > clipped + 10.0)
    first = round(clipped * bh.RATE)
    audio["audra"][first : first + round(GATE_LATE_SEC * bh.RATE)] = 0.0
    ws = bh.workspace(tmp_path, audio)
    ws.project.transcripts.append(
        Transcript(track_id="audra", words=[_word("And", clipped), _word("So", normal)])
    )
    ws.save()
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
    assert word.trimmed_from == (round(clipped, 3), round(clipped + 0.4, 3))
    assert "1 word start missing from its own track (see comments)" in summary


def test_word_whose_track_opens_with_its_voice_is_not_flagged(
    gated: tuple[ProjectWorkspace, float, float],
) -> None:
    ws, _clipped, normal = gated

    _align(ws)

    assert [c for c in _onset_comments(ws) if abs(c[0] - normal) < 1.0] == []
    word = ws.project.transcript_for_track("audra").words[1]
    assert (word.start, word.trimmed_from) == (round(normal, 3), None)


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


@pytest.fixture
def unsolved(tmp_path: Path) -> tuple[ProjectWorkspace, list[float]]:
    """Audra's whole track plays 150 ms late and her manifest pin keeps it there."""
    audio = bh.tracks(
        bleed={"caleb": {"audra": 0.0}}, latency={"audra": LANE_LATE_SEC}, gated=("audra",)
    )
    turns = _turn_starts(audio["audra"])[2:5]
    ws = bh.workspace(tmp_path, audio)
    ws.project.meta.ingest_alignment = {
        "Audra": SpeakerIngestAlignment(
            session_start_in_file_sec=0.0, content_align_sec=0.0, align_method="manual"
        )
    }
    ws.project.transcripts.append(
        Transcript(track_id="audra", words=[_word(f"w{i}", t) for i, t in enumerate(turns)])
    )
    ws.save()
    return ws, turns


def test_unsolved_offset_flags_each_word_and_names_the_lag(
    unsolved: tuple[ProjectWorkspace, list[float]],
) -> None:
    ws, turns = unsolved

    summary = _align(ws)

    comments = _onset_comments(ws)
    assert [round(c[1] or 0.0, 2) for c in comments] == pytest.approx(turns, abs=0.04)
    assert [round(c[1] - c[0], 2) for c in comments if c[1]] == pytest.approx(
        [LANE_LATE_SEC] * 3, abs=0.04
    )
    assert all(
        "Audra's track runs about 150 ms behind Caleb's mic here; aligning it would fix this."
        in c[3]
        for c in comments
    )
    assert [w.trimmed_from for w in ws.project.transcript_for_track("audra").words] == [None] * 3
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
