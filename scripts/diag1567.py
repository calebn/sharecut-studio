#!/usr/bin/env python3
"""Profile the bleed-gate plan build the Play around Suggested side pays (#1567).

Run on a CLONE of the episode (never the live project). Read-only: nothing is saved.
  nice -n 10 python scripts/diag1567.py <episode.project.json> [--edit EDIT_ID] [--top 25]
"""

from __future__ import annotations

import argparse
import cProfile
import pstats
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
from podcast_mcp.engines import bleed_gate
from podcast_mcp.project_store import load_project
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.project_state import snapshot_project


def _plans(project, label: str, *, profile: cProfile.Profile | None = None) -> float:
    gated = [t.id for t in project.tracks if t.transcript_gate]
    bleed_gate._cached_bleed_gate_plan.cache_clear()
    start = time.perf_counter()
    if profile:
        profile.enable()
    for tid in gated:
        t0 = time.perf_counter()
        plan = bleed_gate.build_bleed_gate_plan(project, tid, source_clock=True)
        print(
            f"  {label} {tid}: {time.perf_counter() - t0:6.2f} s  spans={len(plan.attenuation_spans)}"
        )
    if profile:
        profile.disable()
    return time.perf_counter() - start


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("project", type=Path)
    ap.add_argument("--edit", default=None)
    ap.add_argument("--top", type=int, default=25)
    args = ap.parse_args()
    project = load_project(args.project)
    edit_id = args.edit or next(
        e.id
        for e in project.edit_decisions
        if resolve_pending_preview(project, e.id).suggest_reason is None
    )
    print("gated tracks:", [t.id for t in project.tracks if t.transcript_gate], "edit:", edit_id)
    with batch_scope():
        current = snapshot_project(project)
        print(f"Current, cold (pays decode): {_plans(current, 'cur'):.2f} s")
        print(f"Current, warm decode:        {_plans(current, 'cur'):.2f} s")
        suggested = snapshot_project(project)
        window = resolve_pending_preview(suggested, edit_id)
        apply_for_suggested(suggested, window)
        prof = cProfile.Profile()
        print(f"Suggested, decode shared:    {_plans(suggested, 'sug', profile=prof):.2f} s")
        again = _plans(suggested, "sug")
        print(f"Suggested, same project twice (cache hit upper bound): {again:.2f} s")
    pstats.Stats(prof).sort_stats("cumulative").print_stats(args.top)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
