"""``complete_effect_receipts`` checks every row a multi-span removal wrote, not the first."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.cut_effects import complete_effect_receipts
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    Track,
    TrackRole,
)


def _edit() -> EditDecision:
    return EditDecision(
        id="e",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1.0,
        end=3.0,
        scope="session",
        boundary_mode="exact",
    )


def _row(
    row_id: str, tl_start: float, tl_end: float, *, src: tuple[float, float]
) -> AppliedEditRecord:
    return AppliedEditRecord(
        id=row_id,
        applied_at="2026-01-01T00:00:00Z",
        operation="ripple_delete",
        decision_ids=["e"],
        track_ids=["host"],
        source_start=src[0],
        source_end=src[1],
        timeline_start=tl_start,
        timeline_end=tl_end,
    )


def _projects(rows: list[AppliedEditRecord]) -> tuple[EpisodeProject, EpisodeProject]:
    before = EpisodeProject.create("receipts", "/tmp/receipts")
    before.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    before.clips = [Clip(id="c", track_id="host", source_start=0, source_end=6, timeline_start=0)]
    candidate = before.model_copy(deep=True)
    candidate.clips = [
        Clip(id="c", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="c2", track_id="host", source_start=3, source_end=6, timeline_start=1),
    ]
    candidate.editorial.edit_log = rows
    return before, candidate


def test_a_two_span_removal_with_matching_rows_is_accepted() -> None:
    before, candidate = _projects(
        [_row("late", 2.0, 3.0, src=(1.0, 3.0)), _row("early", 1.0, 1.5, src=(1.0, 3.0))]
    )
    assert complete_effect_receipts(before, candidate, [_edit()]) == []


@pytest.mark.parametrize("bad_row", ["late", "early"])
def test_a_later_span_row_that_does_not_match_the_edit_is_held(bad_row: str) -> None:
    rows = {
        "late": _row("late", 2.0, 3.0, src=(1.0, 3.0)),
        "early": _row("early", 1.0, 1.5, src=(1.0, 3.0)),
    }
    rows[bad_row] = rows[bad_row].model_copy(update={"source_end": 2.0})
    before, candidate = _projects(list(rows.values()))

    holds = complete_effect_receipts(before, candidate, [_edit()])

    assert [h.edit_id for h in holds] == ["e"]
