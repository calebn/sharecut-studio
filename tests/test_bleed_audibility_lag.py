"""Stepped recorder latency and per-word copy lag (#1333)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.bleed_lag_segments import LagSegment, LagSteps
from podcast_mcp.engines import audio_audit as aa
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    CopyPath,
    build_track_rms_caches,
    compute_word_audibility_map,
)
from podcast_mcp.engines.bleed_audibility_lag import copy_lag_at_timeline, effective_copy_lag_sec
from test_bleed_attenuation import _episode


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_segment_lag_flips_bleed_verdict_when_peer_track_opens_late(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Per-word copy lag drives dominance: a longer segment lag marks bleed, steady lag does not."""
    project = _episode(tmp_path, direct_lag_sec=0.14)
    caches = build_track_rms_caches(project, defaults=load_defaults())
    steady_lag = caches.copy_path("guest", "host").lag_sec
    assert steady_lag > 0.05

    steps = LagSteps(
        (
            LagSegment(start_sec=0.0, shift_sec=-0.12, frames=100, correlation=0.9),
            LagSegment(
                start_sec=0.85,
                shift_sec=-0.28,
                frames=100,
                correlation=0.9,
                gap_sec=(0.8, 0.9),
            ),
        ),
        step_cost=1.0,
    )
    segment_lag = effective_copy_lag_sec(steady_lag, steps, 1.2)
    assert segment_lag > steady_lag + 0.1

    def _levels(project, track_ids, t_start, t_end, lags, caches, offsets, *, word_dur=None, **_kw):
        guest_lag = lags.get("guest", 0.0)
        if guest_lag >= segment_lag - 0.01:
            return {"host": -30.0, "guest": 0.0}
        return {"host": -30.0, "guest": -30.0}

    monkeypatch.setattr(aa, "_track_levels", _levels)
    guest_path = CopyPath(lag_sec=steady_lag, likeness=0.4)
    caches.leak_paths = lambda track_id: {"guest": guest_path} if track_id == "host" else {}
    caches.copy_match = lambda *args, **kwargs: 1.0

    with patch.object(
        caches, "lane_lag_steps", lambda _project, lane_id: steps if lane_id == "guest" else None
    ):
        stepped = compute_word_audibility_map(
            project,
            track_id="host",
            policy=AnalysisPolicy(),
            caches=caches,
            defaults=load_defaults(),
        )
    assert next(r for r in stepped if r["text"] == "and")["audibility_status"] == "bleed"

    caches.leak_paths = lambda track_id: {"guest": guest_path} if track_id == "host" else {}
    with patch(
        "podcast_mcp.engines.bleed_audibility_lag.lag_steps_for_lane",
        return_value=None,
    ):
        steady = compute_word_audibility_map(
            project,
            track_id="host",
            policy=AnalysisPolicy(),
            caches=caches,
            defaults=load_defaults(),
        )
    assert next(r for r in steady if r["text"] == "and")["audibility_status"] != "bleed"


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_copy_lag_at_timeline_uses_lane_lag_steps(tmp_path: Path) -> None:
    """``copy_lag_at_timeline`` reads segment shifts from cached lane steps."""
    project = _episode(tmp_path, direct_lag_sec=0.14)
    caches = build_track_rms_caches(project, defaults=load_defaults())
    steady = caches.copy_path("guest", "host").lag_sec
    steps = LagSteps(
        (
            LagSegment(start_sec=0.0, shift_sec=-0.12, frames=1, correlation=0.9),
            LagSegment(start_sec=1.0, shift_sec=-0.24, frames=1, correlation=0.9),
        ),
        step_cost=1.0,
    )
    with patch.object(caches, "lane_lag_steps", lambda _p, _lid: steps):
        adjusted = copy_lag_at_timeline(
            project, caches, "guest", "host", 1.5, lag_steps={"guest": steps}
        )
    assert adjusted == pytest.approx(steady + 0.12)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
@pytest.mark.parametrize("timeline_sec", [10_000.0, -50.0])
def test_copy_lag_outside_the_source_lane_keeps_the_steady_lag(
    tmp_path: Path, timeline_sec: float
) -> None:
    """A word judged past the source lane's end has no step to read: steady lag, no raise."""
    project = _episode(tmp_path, direct_lag_sec=0.14)
    caches = build_track_rms_caches(project, defaults=load_defaults())
    steady = caches.copy_path("guest", "host").lag_sec
    steps = LagSteps(
        (
            LagSegment(start_sec=0.0, shift_sec=-0.12, frames=1, correlation=0.9),
            LagSegment(start_sec=1.0, shift_sec=-0.24, frames=1, correlation=0.9),
        ),
        step_cost=1.0,
    )
    adjusted = copy_lag_at_timeline(
        project, caches, "guest", "host", timeline_sec, lag_steps={"guest": steps}
    )
    assert adjusted == pytest.approx(steady)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_a_lane_with_no_lag_steps_is_measured_once_per_reconcile(tmp_path: Path) -> None:
    """Steady copy lag, no steps: ``None`` means measured, so no word re-measures the lane (#1685)."""
    project = _episode(tmp_path, direct_lag_sec=0.14)
    caches = build_track_rms_caches(project, defaults=load_defaults())
    guest_path = CopyPath(lag_sec=caches.copy_path("guest", "host").lag_sec, likeness=0.4)
    caches.leak_paths = lambda track_id: {"guest": guest_path} if track_id == "host" else {}
    caches.copy_match = lambda *args, **kwargs: 1.0

    with patch(
        "podcast_mcp.engines.bleed_audibility_lag.measure_lane_lag_steps", return_value=None
    ) as measure:
        rows = compute_word_audibility_map(
            project,
            track_id="host",
            policy=AnalysisPolicy(),
            caches=caches,
            defaults=load_defaults(),
        )
        copy_lag_at_timeline(project, caches, "guest", "host", 1.0)
    assert len(rows) > 1
    assert measure.call_count == 1
