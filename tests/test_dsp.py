"""Shared numpy DSP primitives (util/dsp.py)."""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.util.dsp import (
    autocorr_peak,
    bool_runs,
    bridge_short_dips,
    db_to_amplitude,
    frame_rms_db,
    rms_db,
)


def test_rms_db_levels_and_floor() -> None:
    assert rms_db(np.full(100, 0.1)) == pytest.approx(-20.0)
    assert rms_db(np.array([])) == -80.0
    assert rms_db(np.zeros(10), floor_db=-200.0) == -200.0


def test_frame_rms_db_matches_scalar_rms_and_caps_frames() -> None:
    x = np.concatenate([np.zeros(400), np.full(400, 0.1)]).astype(np.float32)

    levels = frame_rms_db(x, 400, 400)

    assert levels.tolist() == [-200.0, pytest.approx(-20.0)]
    assert frame_rms_db(x, 400, 100, max_frames=2).size == 2
    assert frame_rms_db(x[:10], 400, 100).size == 0
    assert frame_rms_db(x, 0, 100).size == 0


def test_autocorr_peak_finds_pitch_and_rejects_degenerate_frames() -> None:
    sr = 16_000
    t = np.arange(640) / sr
    peak = autocorr_peak(np.sin(2 * np.pi * 200 * t), sr, fmin=70, fmax=400)

    assert peak is not None
    assert peak[0] == pytest.approx(200.0, rel=0.02)
    assert peak[1] > 0.8
    assert autocorr_peak(np.zeros(640), sr, fmin=70, fmax=400) is None
    # Too short to cover the lag range.
    assert autocorr_peak(np.sin(2 * np.pi * 200 * t[:40]), sr, fmin=70, fmax=400) is None


def test_bool_runs_and_dip_bridging() -> None:
    mask = np.array([1, 1, 0, 1, 0, 0, 0, 1, 0], dtype=bool)

    assert bool_runs(mask) == [(0, 2), (3, 4), (7, 8)]
    assert bool_runs(np.array([], dtype=bool)) == []
    # Interior dips of <= 1 frame are filled; longer dips and edge runs are not.
    assert bridge_short_dips(mask, 1).tolist() == [1, 1, 1, 1, 0, 0, 0, 1, 0]
    assert bridge_short_dips(mask, 3).tolist() == [1, 1, 1, 1, 1, 1, 1, 1, 0]
    assert bridge_short_dips(mask, 0).tolist() == mask.tolist()


def test_db_to_amplitude() -> None:
    assert db_to_amplitude(0.0) == 1.0
    assert db_to_amplitude(-20.0) == pytest.approx(0.1)
    assert db_to_amplitude(6.0) == pytest.approx(1.9953, rel=1e-4)
    assert db_to_amplitude(-6.0) * db_to_amplitude(6.0) == pytest.approx(1.0)
