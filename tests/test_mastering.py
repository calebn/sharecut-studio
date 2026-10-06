from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine
from podcast_mcp.engines.mastering import (
    LimiterPlan,
    LimiterReport,
    LoudnormPlan,
    plan_master,
)


def _stats(input_i: float, input_tp: float) -> dict[str, float]:
    return {
        "input_i": input_i,
        "input_tp": input_tp,
        "input_lra": 7.0,
        "input_thresh": input_i - 10.0,
        "target_offset": 0.0,
    }


@pytest.mark.parametrize(
    ("stats", "plan"),
    [
        # The demo premix: +5.1 dB would put peaks at +4.1 dBTP.
        (_stats(-21.1, -1.0), LimiterPlan(gain_db=5.1)),
        (_stats(-20.0, -1.0), LimiterPlan(gain_db=4.0)),
        # +0.5 dB lands the peak exactly on the ceiling: linear loudnorm reaches it.
        (_stats(-16.5, -2.0), LoudnormPlan()),
        (_stats(-16.5, -1.9), LimiterPlan(gain_db=0.5)),
        # Turning a hot premix down never needs the limiter.
        (_stats(-12.0, 0.0), LoudnormPlan()),
        (None, LoudnormPlan()),
    ],
)
def test_plan_master_limits_only_when_linear_gain_crosses_the_ceiling(stats, plan):
    assert plan_master(stats, integrated_lufs=-16.0, true_peak_db=-1.5) == plan


@pytest.fixture
def eng() -> FFmpegEngine:
    engine = FFmpegEngine()
    if not engine.check_available()[0]:
        pytest.skip("ffmpeg not available")
    return engine


def test_peaky_premix_is_limited_onto_the_target_under_the_ceiling(
    eng: FFmpegEngine, peaky_wav: Path, tmp_path: Path
):
    out = tmp_path / "out" / "mastered.wav"
    result = eng.master_loudness(peaky_wav, out, integrated_lufs=-16.0, true_peak_db=-1.5)

    assert result.plan == LimiterPlan(gain_db=6.0)
    assert result.input_stats == {
        "input_i": -22.0,
        "input_tp": -0.5,
        "input_lra": 0.0,
        "input_thresh": -32.0,
        "target_offset": 0.0,
    }
    assert result.normalization_type is None
    assert result.limiter == LimiterReport(
        gain_db=6.0,
        drive_db=7.7,
        limit_db=-2.0,
        renders=2,
        trim_db=0.2,
        peak_reduction_db=9.2,
        loudness_reduction_lu=1.9,
    )
    measured = eng.measure_loudness_full(out)
    assert measured is not None
    assert measured["integrated_lufs"] == -16.0
    assert measured["true_peak_db"] == -1.8
    assert eng.probe(out) == AudioProbe(
        duration_sec=6.0, sample_rate=48000, channels=1, audio_duration_sec=6.0
    )
    assert [p.name for p in out.parent.iterdir()] == ["mastered.wav"]


def test_gentle_premix_keeps_linear_loudnorm(eng: FFmpegEngine, gentle_wav: Path, tmp_path: Path):
    out = tmp_path / "mastered.wav"
    result = eng.master_loudness(gentle_wav, out, integrated_lufs=-16.0, true_peak_db=-1.5)

    assert result.plan == LoudnormPlan()
    assert result.normalization_type == "linear"
    assert result.limiter is None
    measured = eng.measure_loudness_full(out)
    assert measured is not None
    assert (measured["integrated_lufs"], measured["true_peak_db"]) == (-16.0, -10.0)


def test_an_unmeasurable_limited_master_raises(eng: FFmpegEngine, peaky_wav: Path, tmp_path: Path):
    stats = {
        "input_i": -22.0,
        "input_tp": -0.5,
        "input_lra": 0.0,
        "input_thresh": -32.0,
        "target_offset": 0.0,
    }
    with (
        patch.object(eng, "loudnorm_input_stats", return_value=stats),
        patch.object(eng, "measure_loudness_full", return_value=None),
        pytest.raises(RuntimeError, match="could not measure the limited master"),
    ):
        eng.master_loudness(peaky_wav, tmp_path / "mastered.wav")
    assert list(tmp_path.iterdir()) == []
