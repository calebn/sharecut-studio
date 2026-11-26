"""Tighten's speaker guard and first cut scope run only for candidates that survive (#2364).

Both embed peer speech. They used to run before the gate and the pause checks, so every
candidate those later rejected paid for them. They now run once, after those rejections,
on the spans captured early in ``_prepare_candidate``: the accepted set must not move.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest

import benchmark_tighten as bench
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import propose_tighten_edits
from podcast_mcp.edits.cut_placement import CutRejected
from podcast_mcp.edits.tighten import prepare

# Decisions and skip counts of ``_synthetic_filler_project(600, ...)`` as develop produced
# them before the guard and first scope moved; ids are random per run and left out.
_DEVELOP_600_DIGEST = "0ec8b08f96f93feb031b5e1ae54ec84abfa5db7de58f699926710186b88d07cf"
_DEVELOP_600_SKIPS = {"acoustic:breath": 172, "breath": 2}
_DEVELOP_600_DECISIONS = 124


def _rounded(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return {key: _rounded(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_rounded(item) for item in value]
    return value


def _defaults() -> dict[str, Any]:
    defaults = load_defaults()
    # One worker keeps the call order, and so the frame stack below, deterministic.
    defaults.setdefault("performance", {})["max_workers"] = 1
    return defaults


class _Frames:
    """Which ``_prepare_candidate`` call (outer or retention retry) a patched check runs in."""

    def __init__(self) -> None:
        self.stack: list[tuple[str, bool]] = []
        self.rejected: list[tuple[str, str, int, int]] = []
        self.retried: list[str] = []
        self.guard_calls = 0
        self.scope_calls = 0


@contextmanager
def _watched(
    monkeypatch: pytest.MonkeyPatch, *, owner_fails_in: str | None = None
) -> Iterator[_Frames]:
    frames = _Frames()
    original_prepare = prepare._prepare_candidate
    original_guard = prepare._cut_span_is_bleed_not_owner
    original_scope = prepare._cut_scope

    def prepare_candidate(project, candidate, *args, **kwargs):
        retry = bool(kwargs.get("_retention_retry"))
        if retry:
            frames.retried.append(candidate.hit_id)
        frames.stack.append((candidate.hit_id, retry))
        guards, scopes = frames.guard_calls, frames.scope_calls
        try:
            result = original_prepare(project, candidate, *args, **kwargs)
        finally:
            frames.stack.pop()
        if not retry and isinstance(result, CutRejected):
            frames.rejected.append(
                (
                    candidate.hit_id,
                    result.skip,
                    frames.guard_calls - guards,
                    frames.scope_calls - scopes,
                )
            )
        return result

    def guard(*args, **kwargs):
        frames.guard_calls += 1
        if owner_fails_in is not None and frames.stack[-1] == (owner_fails_in, False):
            return True
        return original_guard(*args, **kwargs)

    def scope(*args, **kwargs):
        frames.scope_calls += 1
        return original_scope(*args, **kwargs)

    monkeypatch.setattr(prepare, "_prepare_candidate", prepare_candidate)
    monkeypatch.setattr(prepare, "_cut_span_is_bleed_not_owner", guard)
    monkeypatch.setattr(prepare, "_cut_scope", scope)
    yield frames


def test_synthetic_benchmark_decisions_match_what_develop_proposed(tmp_path):
    proposal = propose_tighten_edits(
        bench._synthetic_filler_project(600, tmp_path), _defaults(), replace_existing=True
    )

    decisions = [
        {key: value for key, value in d.model_dump(mode="json").items() if key != "id"}
        for d in proposal.decisions
    ]
    digest = hashlib.sha256(json.dumps(_rounded(decisions), sort_keys=True).encode()).hexdigest()
    assert len(decisions) == _DEVELOP_600_DECISIONS
    assert digest == _DEVELOP_600_DIGEST
    assert proposal.skip_counts == _DEVELOP_600_SKIPS


def test_a_candidate_the_gate_rejects_never_runs_the_guard_or_first_scope(tmp_path, monkeypatch):
    project = bench._synthetic_filler_project(60, tmp_path)

    with _watched(monkeypatch) as frames:
        proposal = propose_tighten_edits(project, _defaults(), replace_existing=True)

    gate_rejected = [row for row in frames.rejected if row[1] == "breath"]
    assert gate_rejected
    assert [(row[2], row[3]) for row in frames.rejected] == [(0, 0)] * len(frames.rejected)
    # An accepted candidate still pays for the guard once and the first scope once.
    assert frames.guard_calls == len(proposal.decisions)
    assert frames.scope_calls > 0


def test_a_parent_the_guard_rejects_stays_rejected_when_its_narrower_retry_passes(
    tmp_path, monkeypatch
):
    # The retention retry rebuilds a narrower cut that carries its own guard; it must not
    # stand in for the guard the parent span failed.
    with _watched(monkeypatch) as accepted:
        control = propose_tighten_edits(
            bench._synthetic_filler_project(400, tmp_path / "control"),
            _defaults(),
            replace_existing=True,
        )
    (parent,) = set(accepted.retried)
    assert parent in {decision.id for decision in control.decisions}

    with _watched(monkeypatch, owner_fails_in=parent) as frames:
        proposal = propose_tighten_edits(
            bench._synthetic_filler_project(400, tmp_path / "failed"),
            _defaults(),
            replace_existing=True,
        )

    assert parent in frames.retried
    assert parent not in {decision.id for decision in proposal.decisions}
    row = next(r for r in frames.rejected if r[0] == parent)
    # The child passes its guard and the parent then fails its own: two guard calls.
    assert row[:3] == (parent, "not_owner", 2)
    assert proposal.skip_counts == {**control.skip_counts, "not_owner": 1}
    assert len(proposal.decisions) == len(control.decisions) - 1


def test_a_candidate_failing_the_gate_and_the_guard_keeps_the_gate_label(tmp_path, monkeypatch):
    with _watched(monkeypatch) as control:
        expected = propose_tighten_edits(
            bench._synthetic_filler_project(60, tmp_path / "control"),
            _defaults(),
            replace_existing=True,
        )
    assert not control.retried

    monkeypatch.setattr(prepare, "_cut_span_is_bleed_not_owner", lambda *_a, **_k: True)
    proposal = propose_tighten_edits(
        bench._synthetic_filler_project(60, tmp_path / "failed"),
        _defaults(),
        replace_existing=True,
    )

    assert proposal.decisions == []
    assert proposal.skip_counts == {**expected.skip_counts, "not_owner": control.guard_calls}
