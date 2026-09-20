"""Unit tests for Vepa/King-style spectral join costs."""

from __future__ import annotations

import numpy as np

from podcast_mcp.edits.join_cost_spectral import (
    lpc_burg,
    lpc_to_lsf,
    mfcc_vector,
    score_spectral_join,
)


def test_lpc_burg_stable_on_tone() -> None:
    sr = 16000
    t = np.arange(int(0.05 * sr)) / sr
    x = np.sin(2 * np.pi * 220 * t)
    a = lpc_burg(x, 16)
    assert a.shape == (16,)
    assert np.all(np.isfinite(a))


def test_lpc_to_lsf_in_unit_interval() -> None:
    sr = 16000
    t = np.arange(int(0.04 * sr)) / sr
    x = np.sin(2 * np.pi * 300 * t)
    a = lpc_burg(x, 12)
    lsf = lpc_to_lsf(a)
    assert lsf.shape == (12,)
    assert np.all(lsf > 0)
    assert np.all(lsf < np.pi)


def test_mfcc_vector_shape() -> None:
    sr = 16000
    x = np.random.default_rng(0).normal(0, 0.1, sr // 40)
    v = mfcc_vector(x, sr)
    assert v.shape == (13,)


def test_smooth_join_lower_than_spectral_mismatch() -> None:
    sr = 16000
    n = int(0.08 * sr)
    t = np.arange(n) / sr
    left = 0.3 * np.sin(2 * np.pi * 200 * t)
    right_same = 0.3 * np.sin(2 * np.pi * 200 * t)
    right_noise = np.random.default_rng(1).normal(0, 0.3, n)
    good = score_spectral_join(left, right_same, sample_rate=sr)
    bad = score_spectral_join(left, right_noise, sample_rate=sr)
    assert bad.weighted > good.weighted
    assert bad.mfcc >= good.mfcc * 0.9


def test_weighted_fusion_uses_paper_weights() -> None:
    sr = 16000
    n = int(0.06 * sr)
    left = np.sin(2 * np.pi * 180 * np.arange(n) / sr)
    right = np.random.default_rng(2).normal(0, 0.4, n)
    s = score_spectral_join(left, right, sample_rate=sr)
    expected = 0.15 * s.mfcc + 0.35 * s.lsf + 0.5 * s.mca
    assert abs(s.weighted - min(1.0, expected)) < 1e-6


def test_lsf_fires_on_formant_ish_mismatch() -> None:
    sr = 16000
    n = int(0.05 * sr)
    t = np.arange(n) / sr
    # Two-tone “formant” vs broadband noise
    left = 0.4 * np.sin(2 * np.pi * 400 * t) + 0.2 * np.sin(2 * np.pi * 1200 * t)
    right = np.random.default_rng(3).normal(0, 0.35, n)
    s = score_spectral_join(left, right, sample_rate=sr)
    assert s.lsf > 0.15
