"""contracts/ripple-scope.json: the DAW ripple preview matches what a trim saves.

The DAW draws a ripple trim on every track ``ripple_track_ids`` names before it
saves (gui/web/src/edit/ripplePreview.ts). These cases pin that scope rule and
each lane after ``plan_trim`` + ``apply_trim_geometry``; the Vitest suite reads
the same cases against the preview.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from contract_project_helpers import contract_project
from podcast_mcp.edits.ripple import apply_trim_geometry, plan_trim, ripple_track_ids
from podcast_mcp.models import Clip, EditMode

CONTRACT = Path(__file__).resolve().parents[1] / "contracts" / "ripple-scope.json"
DATA = json.loads(CONTRACT.read_text(encoding="utf-8"))
SCOPE_CASES = DATA["scope_cases"]
TRIM_CASES = DATA["trim_cases"]


@pytest.mark.parametrize("case", SCOPE_CASES, ids=[c["name"] for c in SCOPE_CASES])
def test_ripple_scope(case: dict) -> None:
    assert ripple_track_ids(contract_project(case["tracks"]), case["edited"]) == case["scope"]


@pytest.mark.parametrize("case", TRIM_CASES, ids=[c["name"] for c in TRIM_CASES])
def test_trim_lanes(case: dict) -> None:
    p = contract_project(
        DATA["trim_tracks"],
        DATA["trim_sources"],
        [
            Clip(
                id=cid,
                track_id=tid,
                source_id=source_id[0] if source_id else None,
                timeline_start=ts,
                source_start=ss,
                source_end=se,
            )
            for tid, rows in case["clips"].items()
            for cid, ts, ss, se, *source_id in rows
        ],
    )
    trim = case["trim"]
    plan = plan_trim(p, trim["clip_id"], trim["edge"], trim["source_sec"], EditMode(trim["mode"]))
    apply_trim_geometry(p, plan)
    lanes = {
        tid: [
            [c.timeline_start, c.timeline_end, c.source_start, c.source_end]
            for c in sorted(
                (c for c in p.clips if c.track_id == tid), key=lambda c: c.timeline_start
            )
        ]
        for tid in case["lanes"]
    }
    assert lanes.keys() == case["lanes"].keys()
    for tid, rows in case["lanes"].items():
        assert len(lanes[tid]) == len(rows), tid
        for got, want in zip(lanes[tid], rows, strict=True):
            assert got == pytest.approx(want, abs=1e-9), tid
    for tid, ids in case.get("clip_ids", {}).items():
        output = sorted((c for c in p.clips if c.track_id == tid), key=lambda c: c.timeline_start)
        assert [c.id for c in output] == ids
        assert [c.source_id for c in output] == case["source_ids"][tid]
