from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine
from podcast_mcp.engines.mastering import (
    LimiterPlan,
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
    ("stats", "duration_sec", "plan"),
    [
        # The demo premix: +5.1 dB would put peaks at +4.1 dBTP.
        (_stats(-21.1, -1.0), 60.0, LimiterPlan(gain_db=5.1)),
        (_stats(-20.0, -1.0), 60.0, LimiterPlan(gain_db=4.0)),
        # +0.5 dB lands the peak exactly on the ceiling: linear loudnorm reaches it.
        (_stats(-16.5, -2.0), 60.0, LoudnormPlan(two_pass=True)),
        (_stats(-16.5, -1.9), 60.0, LimiterPlan(gain_db=0.5)),
        # Turning a hot premix down never needs the limiter.
        (_stats(-12.0, 0.0), 60.0, LoudnormPlan(two_pass=True)),
        (None, 60.0, LoudnormPlan(two_pass=False)),
        # No gated block: ebur128 reports its -70 LUFS floor, which would plan +54 dB.
        (_stats(-70.0, -1.0), 60.0, LoudnormPlan(two_pass=False)),
        # A premix shorter than the 400 ms gate has no integrated loudness either.
        (_stats(-40.0, -1.0), 0.3, LoudnormPlan(two_pass=False)),
        (_stats(-40.0, -1.0), 0.4, LimiterPlan(gain_db=24.0)),
    ],
)
def test_plan_master_limits_only_when_linear_gain_crosses_the_ceiling(stats, duration_sec, plan):
    assert (
        plan_master(stats, integrated_lufs=-16.0, true_peak_db=-1.5, duration_sec=duration_sec)
        == plan
    )


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

    # ffmpeg builds round ebur128 readings differently; measured values get that slack.
    measured_value = pytest.approx
    assert result.plan == LimiterPlan(gain_db=measured_value(6.0, abs=0.2))
    assert result.input_stats == {
        "input_i": measured_value(-22.0, abs=0.2),
        "input_tp": measured_value(-0.5, abs=0.2),
        "input_lra": measured_value(0.0, abs=0.2),
        "input_thresh": measured_value(-32.0, abs=0.2),
        "target_offset": 0.0,
    }
    assert result.normalization_type is None
    limiter = result.limiter
    assert limiter is not None
    assert (limiter.limit_db, limiter.renders, limiter.converged) == (-2.0, 2, True)
    assert (
        limiter.gain_db,
        limiter.drive_db,
        limiter.trim_db,
        limiter.peak_reduction_db,
        limiter.loudness_reduction_lu,
    ) == (
        measured_value(6.0, abs=0.2),
        measured_value(7.7, abs=0.3),
        measured_value(0.2, abs=0.2),
        measured_value(9.2, abs=0.3),
        measured_value(1.9, abs=0.3),
    )
    measured = eng.measure_loudness_full(out)
    assert measured is not None
    assert measured["integrated_lufs"] == measured_value(-16.0, abs=0.1)
    assert measured["true_peak_db"] <= -1.5
    assert eng.probe(out) == AudioProbe(
        duration_sec=6.0,
        sample_rate=48000,
        channels=1,
        audio_duration_sec=6.0,
        sample_fmt="s16",
    )
    assert [p.name for p in out.parent.iterdir()] == ["mastered.wav"]


def test_gentle_premix_keeps_linear_loudnorm(eng: FFmpegEngine, gentle_wav: Path, tmp_path: Path):
    out = tmp_path / "mastered.wav"
    result = eng.master_loudness(gentle_wav, out, integrated_lufs=-16.0, true_peak_db=-1.5)

    assert result.plan == LoudnormPlan(two_pass=True)
    assert result.normalization_type == "linear"
    assert result.limiter is None
    measured = eng.measure_loudness_full(out)
    assert measured is not None
    assert measured["integrated_lufs"] == pytest.approx(-16.0, abs=0.1)
    assert measured["true_peak_db"] == pytest.approx(-10.0, abs=0.2)


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


def test_a_premix_shorter_than_the_gate_keeps_single_pass_loudnorm(
    eng: FFmpegEngine, short_peaky_wav: Path, tmp_path: Path
):
    out = tmp_path / "mastered.wav"
    with patch.object(eng, "_limit_to_target") as limit:
        result = eng.master_loudness(short_peaky_wav, out, integrated_lufs=-16.0, true_peak_db=-1.5)

    limit.assert_not_called()
    assert result.plan == LoudnormPlan(two_pass=False)
    assert result.limiter is None
    assert out.is_file()


def test_a_limiter_that_cannot_reach_the_target_reports_that_it_did_not_converge(
    eng: FFmpegEngine, dense_clicks_wav: Path, tmp_path: Path
):
    out = tmp_path / "mastered.wav"
    result = eng.master_loudness(dense_clicks_wav, out, integrated_lufs=-16.0, true_peak_db=-1.5)

    assert result.plan == LimiterPlan(gain_db=1.1)
    assert result.limiter is not None
    assert (result.limiter.renders, result.limiter.converged) == (3, False)
    measured = eng.measure_loudness_full(out)
    assert measured is not None
    assert measured["integrated_lufs"] == -17.7
    assert measured["true_peak_db"] <= -1.5
