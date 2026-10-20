"""A batch's cuts are each proved as a fresh build of the current timeline would prove them (#1596).

The evidence builds the timeline caches once and carries them across the cuts of a batch.
Every answer it gives is checked against a fresh build: the decision exactly, the measured
levels within ``PROFILE_TOLERANCE_DB``.
"""

from __future__ import annotations

import copy

import pytest

from batch_evidence_helpers import Oracle, Scenario, build_project, random_project
from pause_policy_public_helpers import configure, defaults
from podcast_mcp.edits import cut_proof
from podcast_mcp.edits.cut_application import apply_prefix_edits
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.engines.level_profile import PROFILE_TOLERANCE_DB
from podcast_mcp.models import save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync.handlers import edits as handlers

pytestmark = pytest.mark.refine_gate


def _config() -> dict:
    cfg = defaults(acoustic=True)
    cfg["tighten"]["filler_words"] = ["um"]
    return cfg


def _approve(tmp_path, monkeypatch, scenario: Scenario, *, tolerance: float | None = None):
    configure(monkeypatch, _config())
    if tolerance is not None:
        monkeypatch.setattr(cut_proof, "PROFILE_TOLERANCE_DB", tolerance)
    project = build_project(tmp_path, scenario)
    ids = [e.id for e in project.edit_decisions]
    REFINE_GATE.mark_done(project, notes="Known synthetic transcript fixture; no real-project test")
    ws = ProjectWorkspace.open(save_project(project))
    oracle = Oracle()
    oracle.install(monkeypatch, PROFILE_TOLERANCE_DB)
    result = handlers.approve_edits(ws, {"ids": ids, "hold_blocked": True})
    return result, oracle, ids


def test_every_cut_of_a_batch_is_proved_as_a_fresh_build_would_prove_it(tmp_path, monkeypatch):
    # The guest's clip starts 2 s into its recording, so source order is not timeline order;
    # the host's 40 s pause goes first (right to left) and moves every level on every track.
    result, oracle, ids = _approve(
        tmp_path, monkeypatch, Scenario(seconds=400, long_pause=(300.0, 340.0))
    )

    assert result["count"] >= 8
    assert oracle.observations >= len(ids)
    assert oracle.mismatches == []
    assert oracle.outside_spread == []
    assert oracle.profile_error_db <= PROFILE_TOLERANCE_DB


def test_the_profile_carried_across_cuts_is_the_profile_of_the_cut_timeline(tmp_path, monkeypatch):
    # A tolerance too loose to ever measure again: every answer after the first rests on the
    # carried profile alone.
    result, oracle, _ids = _approve(
        tmp_path, monkeypatch, Scenario(seconds=400, long_pause=(300.0, 340.0)), tolerance=100.0
    )

    assert result["count"] >= 8
    assert oracle.rebuilds < oracle.observations
    assert oracle.mismatches == []
    assert oracle.outside_spread == []
    assert oracle.profile_error_db <= PROFILE_TOLERANCE_DB


def test_cuts_closer_than_the_read_reach_still_match_a_fresh_build(tmp_path, monkeypatch):
    result, oracle, _ids = _approve(
        tmp_path,
        monkeypatch,
        Scenario(
            seconds=150,
            speakers=("host", "guest", "third"),
            filler_every_sec=2.5,
            long_pause=None,
            bleed_db=None,
        ),
    )

    assert result["count"] >= 8
    assert oracle.mismatches == []
    assert oracle.outside_spread == []


def test_a_cut_held_in_the_middle_of_the_batch_leaves_the_rest_as_a_fresh_build_would(
    tmp_path, monkeypatch
):
    result, oracle, _ids = _approve(
        tmp_path, monkeypatch, Scenario(seconds=300, long_pause=None, overlap_at=150.0)
    )

    assert result["held"] != []
    assert result["count"] >= 6
    assert oracle.mismatches == []
    assert oracle.outside_spread == []


def test_a_chained_track_is_measured_without_its_chain_each_time(tmp_path, monkeypatch):
    result, oracle, _ids = _approve(
        tmp_path, monkeypatch, Scenario(seconds=200, chain_on="guest", long_pause=(120.0, 150.0))
    )

    assert result["count"] >= 4
    assert oracle.mismatches == []
    assert oracle.outside_spread == []


def test_apply_prefix_edits_proves_its_cuts_through_the_batch_evidence(tmp_path, monkeypatch):
    cfg = _config()
    configure(monkeypatch, cfg)
    project = build_project(tmp_path, Scenario(seconds=300, long_pause=(200.0, 230.0)))
    REFINE_GATE.mark_done(project, notes="Known synthetic transcript fixture; no real-project test")
    oracle = Oracle()
    oracle.install(monkeypatch, PROFILE_TOLERANCE_DB)

    applied = apply_prefix_edits(
        project, ("filler:", "pause:"), config_key="tighten", defaults=copy.deepcopy(cfg)
    )

    assert applied >= 6
    assert oracle.observations >= applied
    assert oracle.mismatches == []
    assert oracle.outside_spread == []


@pytest.mark.parametrize("seed", [23, 209])
def test_projects_whose_whole_track_levels_moved_enough_to_change_a_decision(
    tmp_path, monkeypatch, seed
):
    configure(monkeypatch, _config())
    project = random_project(tmp_path, seed)
    ids = [e.id for e in project.edit_decisions]
    REFINE_GATE.mark_done(project, notes="Known synthetic transcript fixture; no real-project test")
    ws = ProjectWorkspace.open(save_project(project))
    oracle = Oracle()
    oracle.install(monkeypatch, PROFILE_TOLERANCE_DB)

    result = handlers.approve_edits(ws, {"ids": ids, "hold_blocked": True})

    assert result["count"] >= 4
    assert oracle.observations >= result["count"]
    assert oracle.mismatches == []
    assert oracle.outside_spread == []
