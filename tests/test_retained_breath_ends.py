from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.filler_pacing import FillerPacingResult
from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate
from podcast_mcp.engines.audio_audit import TrackRmsCache
from test_breath_detect import _fake_windows, _host_project, _shaped_noise
from test_fillers import _passthrough_opt, _safe_risk


def _cache() -> TrackAudioCache:
    samples = _fake_windows(placed=((_shaped_noise(3840, 0.026), 5.1),))(None, 0, 10.2)
    return TrackAudioCache(
        jump=TrackRmsCache(samples[::2], sample_rate=8000),
        waveform=TrackRmsCache(samples, sample_rate=16000),
    )


@pytest.mark.parametrize("adjustment", ["max_end", "pacing"])
@pytest.mark.parametrize("kind", ["pause", "filler"])
def test_final_cut_end_retreats_to_retained_breath_onset(adjustment: str, kind: str) -> None:
    candidate = _CutCandidate(
        track_id="host",
        start=5.0,
        end=5.5,
        reason=f"{kind}:candidate",
        cut_kind=kind,
        max_end=5.2 if adjustment == "max_end" else None,
    )
    measured = []

    def assess(project, track_id, start, end, **kwargs):
        measured.append((start, end))
        return _safe_risk()

    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(5.0, 5.5), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(5.0, 5.5 if adjustment == "max_end" else 5.2),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=("session", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", side_effect=assess),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
    ):
        result = _analyze_candidate(
            _host_project(), candidate, {"tighten": {}}, audio_cache=_cache()
        )

    assert result is not None
    assert (result.start, result.end) == pytest.approx((5.0, 5.1))
    assert measured == [(5.0, pytest.approx(5.1))]
    assert result.crossfade_ms == 20


@pytest.mark.parametrize("start", [5.0, 5.15])
def test_retreat_that_removes_entire_cut_skips_proposal(start: float) -> None:
    candidate = _CutCandidate("host", start, 5.2, "pause:0.9s", "pause", max_end=5.2)
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(start, 5.2), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(start, 5.2),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=("session", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=_safe_risk()),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
    ):
        result = _analyze_candidate(
            _host_project(), candidate, {"tighten": {}}, audio_cache=_cache()
        )

    if start > 5.1:
        assert result is None
    else:
        assert result is not None
        assert (result.start, result.end) == pytest.approx((5.0, 5.1))
