"""Throwaway profile for #1554: where does one Approve all pass spend its time? Saves nothing.

usage: python scripts/profile_approve_1554.py <project.json> [ids_file]
Runs approve_edits (hold_blocked mode, like Approve all) on a deep copy under cProfile.
"""
from __future__ import annotations

import copy
import cProfile
import pstats
import sys
import time
from pathlib import Path

from podcast_mcp.edits import source_removals
from podcast_mcp.edits.decisions import approve_edits
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EditDecisionType, load_project
from podcast_mcp.util.batch_scope import batch_scope

project = load_project(Path(sys.argv[1]))
ids = (
    Path(sys.argv[2]).read_text().split()
    if len(sys.argv) > 2
    else [e.id for e in project.edit_decisions if e.type == EditDecisionType.REMOVE]
)

t = time.perf_counter()
for _ in range(5):
    SessionTimeline(project)
print(f"SessionTimeline(project): {(time.perf_counter() - t) / 5 * 1000:.0f} ms each")

per_cut: list[float] = []
real = source_removals.consume_source_remove


def timed(*a, **k):
    s = time.perf_counter()
    try:
        return real(*a, **k)
    finally:
        per_cut.append(time.perf_counter() - s)


import podcast_mcp.edits.decisions as decisions

decisions.consume_source_remove = timed

work = copy.deepcopy(project)
held, asked = [], []
prof = cProfile.Profile()
t = time.perf_counter()
prof.enable()
# The service wraps a batch in batch_scope(); without it nothing is shared across cuts.
with batch_scope():
    count = approve_edits(work, ids, allow_review=True, held_out=held, asked_out=asked)
prof.disable()
total = time.perf_counter() - t
print(f"\nids={len(ids)} applied={count} held={len(held)} asked={sum(len(a.edit_ids) for a in asked)} total={total:.1f}s")
if per_cut:
    per_cut.sort()
    print(f"per cut: n={len(per_cut)} median={per_cut[len(per_cut)//2]:.2f}s p90={per_cut[int(len(per_cut)*0.9)]:.2f}s max={per_cut[-1]:.2f}s sum={sum(per_cut):.1f}s")

st = pstats.Stats(prof)
print("\n== top 35 by cumulative time (podcast_mcp only) ==")
st.sort_stats("cumulative").print_stats(r"podcast_mcp", 35)
print("\n== top 25 by own time ==")
st.sort_stats("tottime").print_stats(25)
