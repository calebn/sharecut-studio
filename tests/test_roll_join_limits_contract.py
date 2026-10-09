"""Literal roll intervals and clamps shared with the DAW client."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from contract_project_helpers import contract_project
from podcast_mcp.edits.clips_ops import roll_clip_join, roll_join_limits
from podcast_mcp.models import Clip

CONTRACT = Path(__file__).resolve().parents[1] / "contracts" / "roll-join-limits.json"
DATA = json.loads(CONTRACT.read_text(encoding="utf-8"))
CASES = DATA["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_roll_join_limits_and_clamps(case: dict) -> None:
    project = contract_project(
        DATA["tracks"],
        DATA["sources"],
        [
            Clip(
                id=cid,
                track_id="host",
                source_id=source_id,
                timeline_start=ts,
                source_start=ss,
                source_end=se,
            )
            for cid, ts, ss, se, source_id in case["clips"]
        ],
    )
    left_id, right_id = case["left_clip_id"], case["right_clip_id"]
    if case.get("error"):
        with pytest.raises(ValueError):
            roll_join_limits(project, left_id, right_id)
        return
    assert roll_join_limits(project, left_id, right_id) == pytest.approx(case["limits"], abs=1e-9)
    for requested, expected in case["clamps"]:
        working = project.model_copy(deep=True)
        original_left = next(c for c in project.clips if c.id == left_id)
        original_right = next(c for c in project.clips if c.id == right_id)
        left, right = roll_clip_join(working, left_id, right_id, requested)
        assert left.source_end - original_left.source_end == pytest.approx(expected, abs=1e-9)
        assert right.source_start - original_right.source_start == pytest.approx(expected, abs=1e-9)
