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


def test_a_gate_rejection_keeps_its_label_and_only_survivors_report_not_owner(
    tmp_path, monkeypatch
):
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


def test_the_guard_runs_on_the_breath_extended_span_and_the_scope_on_the_paced_one():
    from unittest.mock import patch

    from podcast_mcp.edits.breath_detect import BreathSpan
    from podcast_mcp.edits.cut_safety import ResolvedCutScope
    from podcast_mcp.edits.filler_pacing import FillerPacingResult
    from podcast_mcp.edits.tighten.candidate import _CutCandidate
    from podcast_mcp.edits.tighten.gate import _GatedCut
    from podcast_mcp.edits.tighten.prepare import _analyze_candidate
    from podcast_mcp.models import (
        Clip,
        EpisodeProject,
        MediaAsset,
        Track,
        TrackRole,
        Transcript,
        TranscriptWord,
    )

    project = EpisodeProject.create("spans", "/tmp/ws")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/host.wav", duration_sec=30.0),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=30.0, timeline_start=0.0)
    ]
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="um", start=1.0, end=1.3)])
    ]
    candidate = _CutCandidate(
        track_id="host", start=1.0, end=1.3, reason="filler:um", cut_kind="filler"
    )
    opt = type("O", (), {"start": 1.0, "end": 1.3, "confidence": 1.0, "mode": "word"})()
    risk = type("R", (), {"too_risky": False})()
    defaults = load_defaults()
    # The breath moves the start to 0.9 and pacing then moves it again to 0.95: the two
    # checks must each see the span that existed when they would have run before.
    breath = BreathSpan(0.9, 1.0, "before")
    paced = FillerPacingResult(start=0.95, end=1.25)
    with (
        patch("podcast_mcp.edits.tighten.prepare.optimize_and_assess", return_value=(opt, risk)),
        patch("podcast_mcp.edits.tighten.prepare.assess_cut_risk", return_value=risk),
        patch("podcast_mcp.edits.tighten.prepare.detect_adjacent_breath", return_value=[breath]),
        patch("podcast_mcp.edits.tighten.prepare.apply_filler_pacing", return_value=paced),
        patch(
            "podcast_mcp.edits.tighten.prepare._gate_cut_edges",
            side_effect=lambda _project, _candidate, plan, **_kw: _GatedCut(plan, None, ()),
        ),
        patch(
            "podcast_mcp.edits.tighten.prepare._cut_span_is_bleed_not_owner", return_value=False
        ) as guard,
        patch(
            "podcast_mcp.edits.tighten.prepare._cut_scope",
            return_value=ResolvedCutScope("session_clear"),
        ) as scope,
    ):
        result = _analyze_candidate(project, candidate, defaults)

    assert not isinstance(result, CutRejected)
    assert guard.call_args.args[1:4] == ("host", 0.9, 1.3)
    assert scope.call_args.args[1:4] == ("host", 0.95, 1.25)
