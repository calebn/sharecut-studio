"""contracts/trim-edge-limits.json: the DAW's trim clamp matches ``trim_edge_limits``.

Every client clamp of a clip edge (a held strip nudge, a handle drag, the peer a
ripple preview moves) reads gui/web/src/edit/trimLimits.ts. These cases pin the
server's answer, across recordings and takes; the Vitest suite reads the same cases
against the mirror.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from contract_project_helpers import contract_project
from podcast_mcp.edits.clips_ops import trim_edge_limits
from podcast_mcp.models import Clip, EditMode

CONTRACT = Path(__file__).resolve().parents[1] / "contracts" / "trim-edge-limits.json"
DATA = json.loads(CONTRACT.read_text(encoding="utf-8"))
CASES = DATA["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_trim_edge_limits(case: dict) -> None:
    track_id = case.get("track", "host")
    p = contract_project(
        DATA["tracks"],
        DATA["sources"],
        [
            Clip(
                id=cid,
                track_id=track_id,
                source_id=source_id,
                timeline_start=ts,
                source_start=ss,
                source_end=se,
            )
            for cid, ts, ss, se, source_id in case["clips"]
        ],
    )
    clip = next(c for c in p.clips if c.id == case["clip_id"])
    limits = trim_edge_limits(p, clip, case["edge"], EditMode(case["mode"]))
    assert limits == pytest.approx(case["limits"], abs=1e-9)
