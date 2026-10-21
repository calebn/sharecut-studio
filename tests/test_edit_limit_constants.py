"""The shared geometry constants in contracts/*.json are the numbers the server edits with."""

from __future__ import annotations

import json
import re
from pathlib import Path

from podcast_mcp.edits import ripple
from podcast_mcp.engines import clips_ops, ranges

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "contracts"


def _constants(name: str) -> dict[str, float]:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))["constants"]


def test_trim_edge_constants() -> None:
    assert _constants("trim-edge-limits.json") == {"min_clip_span_sec": 0.05, "time_eps_sec": 1e-9}
    assert clips_ops._MIN_CLIP_SPAN_SEC == 0.05
    assert ranges.SPAN_EPS_S == 1e-9


def test_join_gap_tolerance_constant() -> None:
    assert _constants("join-length-limits.json") == {"join_gap_tolerance_sec": 0.05}
    assert clips_ops.JOIN_GAP_TOLERANCE_SEC == 0.05


def test_ripple_edge_epsilon_constant() -> None:
    assert _constants("ripple-scope.json") == {"edge_eps_sec": 1e-3}
    assert ripple._EDGE_EPS_SEC == 1e-3


def test_gui_constants_are_the_server_constants() -> None:
    ts = (ROOT / "gui/web/src/types/limits.generated.ts").read_text(encoding="utf-8")
    generated = {
        name: float(value) for name, value in re.findall(r"export const (\w+) = ([\d.e-]+);", ts)
    }
    assert generated == {
        "MIN_EDGE_SPAN_SEC": clips_ops._MIN_CLIP_SPAN_SEC,
        "TIME_EPS_SEC": ranges.SPAN_EPS_S,
        "JOIN_GAP_TOLERANCE_SEC": clips_ops.JOIN_GAP_TOLERANCE_SEC,
        "RIPPLE_EDGE_EPS_SEC": ripple._EDGE_EPS_SEC,
    }
