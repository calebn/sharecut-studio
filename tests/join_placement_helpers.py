"""Shared helper: pin which edge placement wins a join's nine-way worst-placement search."""

from __future__ import annotations

import itertools


def force_placement(monkeypatch, index: int) -> dict:
    """Make the placement at 0-based `index` the winner of the join's worst-placement search
    (order: dl in (0, -tol, +tol), dr in (0, -tol, +tol)).

    The real scores sit within ~0.002 of each other, so which placement wins is CPU
    dependent. The search still scores every placement for real; only the choice is
    overridden, and the chosen placement keeps its own real risk and detector hits, so
    every pinned number stays the real one. The calibration sweep (inaudible=False) and
    inaudible splices are left alone.

    Returns {"scored": [placements scored per forced join, ...]}."""
    from podcast_mcp.edits import join_continuity as jc

    original_wp = jc._worst_placement
    original_score = jc.score_splice_samples
    state: dict = {"join": False, "recorded": [], "scored": []}

    def score(*args, **kwargs):
        result = original_score(*args, **kwargs)
        if state["join"]:
            state["recorded"].append(result)
        return result

    def worst_placement(samples, sr, left_i, right_i, cfg, *, inaudible=True):
        # the join's own call uses the default inaudible=True; calibration passes False
        state["join"], state["recorded"] = bool(inaudible), []
        try:
            found = original_wp(samples, sr, left_i, right_i, cfg, inaudible=inaudible)
        finally:
            recorded, state["join"] = state["recorded"], False
        if not inaudible or found.inaudible:
            return found
        state["scored"].append(len(recorded))
        shifts = jc._edge_shifts(cfg, sr)
        dl, dr = list(itertools.product(shifts, shifts))[index]
        risk, hits = recorded[index]
        return jc._Placement(risk, hits, False, dl, dr)

    monkeypatch.setattr(jc, "score_splice_samples", score)
    monkeypatch.setattr(jc, "_worst_placement", worst_placement)
    return state
