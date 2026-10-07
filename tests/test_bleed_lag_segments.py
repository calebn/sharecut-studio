"""Piecewise lane latency (#1071): steps found at silences, applied as clip pieces, undone."""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Callable

import numpy as np
import pytest

import bleed_helpers as bh
from podcast_mcp.edits.bleed_lag_segments import LagSegment, lag_segments
from podcast_mcp.edits.conversation_align import plan_conversation_alignment
from podcast_mcp.models import SpeakerIngestAlignment
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.history import HistoryService
from podcast_mcp.services.pipeline.service import PipelineService

# Audra is silent from 152.5 s to 212.9 s of the synthetic session; her track's latency
# steps from 120 ms to 200 ms when she resumes, like a jitter buffer after a pause.
RESUMES_SEC = 212.9


def _stepped() -> dict[str, np.ndarray]:
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    audio["audra"] = bh.relatency(audio["audra"], lambda t: 0.12 if t < RESUMES_SEC else 0.2)
    return audio


def _clips(ws: ProjectWorkspace, track_id: str) -> list[tuple[str, float, float, float]]:
    return [
        (c.id, round(c.source_start, 4), round(c.source_end, 4), round(c.timeline_start, 4))
        for c in sorted(ws.project.clips, key=lambda c: c.timeline_start)
        if c.track_id == track_id
    ]


def test_latency_step_at_a_silence_is_two_segments() -> None:
    levels = bh.levels(_stepped())

    segments = lag_segments(
        levels["audra"], levels["caleb"], heard=levels["audra"], around_sec=0.14, deadband_sec=0.02
    )

    assert segments is not None
    assert [(round(s.start_sec, 2), s.shift_sec, s.gap_sec) for s in segments] == [
        (0.0, -0.12, None),
        (182.81, -0.2, (152.535, 213.09)),
    ]


def _worst_error_ms(
    segments: tuple[LagSegment, ...] | None, direct: np.ndarray, latency: Callable[[float], float]
) -> float:
    """Largest gap between a talk spurt's true latency and the latency its segment plays at."""
    assert segments is not None
    starts = [segment.start_sec for segment in segments]
    errors = []
    for first, _last in bh.spurts(direct):
        at = first / bh.RATE
        segment = segments[bisect_right(starts, at) - 1]
        errors.append(abs(-segment.shift_sec - latency(at)))
    return round(max(errors) * 1000, 1)


def test_a_step_is_judged_against_its_merged_neighbours() -> None:
    # After a 21 s pause Audra's latency jumps from 140 to 185 ms on a noisy stretch, then
    # eases to 200 ms after a 7 s pause. 185 and 200 sit inside the 20 ms deadband of each
    # other, so they are one piece, and the step into it belongs in the 21 s pause. Judged
    # against the 185 ms piece alone, a 200 ms piece next to it was forbidden, so the solver
    # moved the step into an earlier silence and played the speech before the pause 30 ms
    # late to make the pieces differ.
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    direct = audio["audra"]

    def latency(t: float) -> float:
        return 0.14 if t < 120.0 else (0.185 if t < 140.0 else 0.2)

    audio["audra"] = bh.relatency(direct, latency)
    t = np.arange(audio["caleb"].size) / bh.RATE
    noisy = (t >= 132.0) & (t < 142.3)
    audio["caleb"] += np.where(noisy, 0.003, 0.0) * np.random.default_rng(1).standard_normal(t.size)
    levels = bh.levels(audio)

    segments = lag_segments(
        levels["audra"], levels["caleb"], heard=levels["audra"], around_sec=0.15, deadband_sec=0.02
    )

    assert segments is not None
    assert [(round(s.start_sec, 1), round(-s.shift_sec * 1000)) for s in segments] == [
        (0.0, 140),
        (121.6, 200),
    ]
    assert _worst_error_ms(segments, direct, latency) <= 20.0


def test_jitter_inside_the_deadband_is_one_segment() -> None:
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    rng = np.random.default_rng(3)
    audio["audra"] = bh.relatency(audio["audra"], lambda _t: 0.12 + rng.uniform(-0.008, 0.008))
    levels = bh.levels(audio)

    assert (
        lag_segments(
            levels["audra"],
            levels["caleb"],
            heard=levels["audra"],
            around_sec=0.12,
            deadband_sec=0.02,
        )
        is None
    )


@pytest.fixture
def stepped(tmp_path) -> ProjectWorkspace:
    return bh.workspace(tmp_path, _stepped())


def test_align_tracks_splits_the_lane_in_the_silence_and_undo_restores(
    stepped: ProjectWorkspace,
) -> None:
    PipelineService(stepped).run(only_step="align_tracks", unattended=True)

    pieces = _clips(stepped, "audra")
    # The step sits mid-silence (182.81 s of Audra's file): the first piece plays her
    # file 120 ms early, the second 200 ms early, and the 80 ms between them is silence.
    assert [tuple(geometry) for _id, *geometry in pieces] == [
        (0.12, 182.7725, 0.0),
        (182.8525, 240.0, 182.6525),
    ]
    assert not np.any(_stepped()["audra"][round(182.7725 * bh.RATE) : round(182.8525 * bh.RATE)])
    labels = [entry.label for entry in stepped.project.history.entries]
    assert labels == ["initial", "before pipeline run", "after align_tracks"]

    HistoryService(stepped).goto(labels.index("before pipeline run"))

    assert _clips(stepped, "audra") == [("clip_audra", 0.0, 240.0, 0.0)]


def test_rerun_keeps_the_pieces_where_they_are(stepped: ProjectWorkspace) -> None:
    PipelineService(stepped).run(only_step="align_tracks", unattended=True)
    once = _clips(stepped, "audra")

    result = PipelineService(stepped).run(only_step="align_tracks", unattended=True)

    assert _clips(stepped, "audra") == once
    assert "kept audra" in (result.steps[-1].message or "")


def test_drifting_lane_is_flagged_and_not_split(tmp_path) -> None:
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    index = np.arange(audio["audra"].size)
    late = (0.02 + 0.12 * index / index.size) * bh.RATE
    audio["audra"] = np.interp(index - late, index, audio["audra"], left=0.0)
    ws = bh.workspace(tmp_path, audio)

    result = plan_conversation_alignment(ws.project)

    audra = [(p.method, p.offset_sec, p.steps) for p in result.plans if p.track_id == "audra"]
    assert audra == [("hold", 0.0, ())]
    assert "bleed lag drifting: audra (left in place)" in result.summary()


def test_manifest_pin_proposes_one_shift_and_keeps_the_clip_whole(
    stepped: ProjectWorkspace,
) -> None:
    stepped.project.meta.ingest_alignment = {
        "Audra": SpeakerIngestAlignment(
            session_start_in_file_sec=0.0, content_align_sec=0.0, align_method="manual"
        )
    }

    result = plan_conversation_alignment(stepped.project)

    audra = [
        (p.method, p.offset_sec, round(p.candidate_offset_sec or 0.0, 2), p.steps)
        for p in result.plans
        if p.track_id == "audra"
    ]
    assert audra == [("manual", 0.0, -0.12, ())]
