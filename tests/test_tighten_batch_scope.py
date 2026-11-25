"""Tighten's read-only gather and analysis share one batch scope; its apply does not (#2364).

Every candidate used to resolve the same paths, stat the same recordings and decode the
same files again. The gather and analysis only read the project, so one
:func:`~podcast_mcp.util.batch_scope.batch_scope` lets each of those happen once per run,
for the workers too. The apply mutates a copy, so it stays outside the scope.
"""

from __future__ import annotations

import pytest

import benchmark_tighten as bench
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import propose_tighten_edits
from podcast_mcp.edits.tighten import prepare, propose
from podcast_mcp.util.batch_scope import scoped

_PROBE = ("test_tighten_batch_scope", "probe")


def _probe() -> object:
    """The scope's probe object; a new one on every call outside a scope."""
    return scoped(_PROBE, object)


@pytest.mark.parametrize("max_workers", [1, 4])
def test_gather_and_analysis_share_one_scope_and_apply_runs_outside_it(
    tmp_path, monkeypatch, max_workers
):
    project = bench._synthetic_filler_project(24, tmp_path)
    defaults = load_defaults()
    defaults.setdefault("performance", {})["max_workers"] = max_workers
    seen_by_candidates: list[object] = []
    seen_by_apply: list[tuple[object, object]] = []

    original_prepare = prepare._prepare_candidate

    def prepare_candidate(*args, **kwargs):
        seen_by_candidates.append(_probe())
        return original_prepare(*args, **kwargs)

    original_apply = propose._apply_analyzed_cut

    def apply_analyzed_cut(*args, **kwargs):
        seen_by_apply.append((_probe(), _probe()))
        return original_apply(*args, **kwargs)

    monkeypatch.setattr(prepare, "_prepare_candidate", prepare_candidate)
    monkeypatch.setattr(propose, "_apply_analyzed_cut", apply_analyzed_cut)

    proposal = propose_tighten_edits(project, defaults, replace_existing=True)

    assert proposal.decisions
    assert len(seen_by_candidates) > 1
    assert all(seen is seen_by_candidates[0] for seen in seen_by_candidates)
    assert seen_by_apply
    assert all(first is not second for first, second in seen_by_apply)
    assert _probe() is not _probe()
