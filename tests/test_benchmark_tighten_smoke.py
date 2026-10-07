"""Smoke-run each scenario in ``tests/benchmark_tighten.py`` on a tiny project (#1129).

The benchmark file is not named ``test_*`` and its tests are ``slow``, so nothing in the
normal suite ran it and it rotted until it hung on ``main``. These tests run the same
helpers on a few dozen words and assert only structure (no ffmpeg window spawns, cuts
applied, tracks in step), never wall-clock time.
"""

from __future__ import annotations

import pytest

import benchmark_tighten as bench

_WORDS = 40


@pytest.fixture
def project(tmp_path):
    return bench._synthetic_filler_project(_WORDS, tmp_path)


def test_ripple_benchmark_runs_on_a_tiny_project(project):
    result = bench.run_tighten_benchmark(project)

    assert result.decisions_proposed > 0
    assert result.ffmpeg_window_calls == 0
    assert (
        0
        < result.rebuild_combined_calls
        <= bench.MAX_REBUILDS_PER_MERGED_RANGE * result.merged_ranges
    )
    assert len(set(result.clip_counts.values())) == 1


def test_word_only_apply_benchmark_runs_on_a_tiny_project(project):
    result = bench.run_tighten_apply_word_only_benchmark(project)

    assert result.decisions_proposed > 0
    assert result.ffmpeg_window_calls == 0
    assert len(set(result.clip_counts.values())) == 1


def test_warm_full_mode_benchmark_runs_on_a_tiny_project(project):
    first_calls, warm_sec = bench.run_tighten_apply_full_mode_warm_benchmark(project)

    assert first_calls > 0
    assert warm_sec >= 0.0
