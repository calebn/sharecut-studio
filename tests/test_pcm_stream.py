"""Forward-only windowed sample reads (util/pcm_stream.py)."""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.util.pcm_stream import SequentialWindowReader


def _chunks(samples: np.ndarray, size: int) -> list[np.ndarray]:
    return [samples[i : i + size] for i in range(0, samples.size, size)]


def test_window_spans_chunk_boundaries():
    samples = np.arange(100, dtype=np.float32)
    reader = SequentialWindowReader(_chunks(samples, 7), sample_rate=10)

    window, t0 = reader.window(0.25, 0.95)

    np.testing.assert_array_equal(window, samples[2:10])
    assert t0 == pytest.approx(0.2)


def test_overlapping_nondecreasing_windows_ok_and_earlier_start_raises():
    samples = np.arange(100, dtype=np.float32)
    reader = SequentialWindowReader(_chunks(samples, 7), sample_rate=10)

    reader.window(1.0, 3.0)
    reader.window(1.0, 4.0)

    with pytest.raises(
        ValueError, match=r"window start 0\.500s \(sample 5\) precedes the previous start sample 10"
    ):
        reader.window(0.5, 1.0)


def test_end_sec_and_windows_past_eof():
    samples = np.arange(100, dtype=np.float32)
    reader = SequentialWindowReader(_chunks(samples, 7), sample_rate=10)

    assert reader.end_sec is None

    window, _t0 = reader.window(9.5, 20.0)
    np.testing.assert_array_equal(window, samples[95:100])
    assert reader.end_sec == pytest.approx(10.0)

    window, t0 = reader.window(12.0, 13.0)
    assert window.size == 0
    assert t0 == pytest.approx(10.0)  # empty: t0 is the (clamped) media end


def test_resident_samples_stay_bounded():
    def gen():
        for i in range(1000):
            yield (np.arange(100, dtype=np.float32) + i * 100)

    full = np.arange(100_000, dtype=np.float32)
    reader = SequentialWindowReader(gen(), sample_rate=100)

    peak = 0
    for start in range(0, 1000, 10):
        window, t0 = reader.window(float(start), float(start + 2))
        i0 = round(t0 * 100)
        np.testing.assert_array_equal(window, full[i0 : i0 + window.size])
        peak = max(peak, reader.buffered_samples)

    assert peak <= 2 * 100 + 100 + 1


def test_skips_chunks_wholly_before_first_window():
    def gen():
        for i in range(1000):
            yield (np.arange(100, dtype=np.float32) + i * 100)

    full = np.arange(100_000, dtype=np.float32)
    reader = SequentialWindowReader(gen(), sample_rate=100)

    window, t0 = reader.window(500.0, 502.0)

    i0 = round(t0 * 100)
    np.testing.assert_array_equal(window, full[i0 : i0 + window.size])
    assert reader.buffered_samples <= 2 * 100 + 100


def test_window_samples_serves_exact_index_ranges():
    samples = np.arange(100, dtype=np.float32)
    reader = SequentialWindowReader(_chunks(samples, 7), sample_rate=10)

    window, first = reader.window_samples(3, 17)
    np.testing.assert_array_equal(window, samples[3:17])
    assert first == 3

    window, first = reader.window_samples(17, 17)
    assert window.size == 0
    assert first == 17


def test_window_samples_clamps_negative_start_and_eof():
    samples = np.arange(100, dtype=np.float32)
    reader = SequentialWindowReader(_chunks(samples, 7), sample_rate=10)

    window, first = reader.window_samples(-5, 4)
    np.testing.assert_array_equal(window, samples[0:4])
    assert first == 0

    window, first = reader.window_samples(95, 200)
    np.testing.assert_array_equal(window, samples[95:100])
    assert first == 95
    assert reader.end_sec == pytest.approx(10.0)

    window, first = reader.window_samples(120, 130)
    assert window.size == 0
    assert first == 100


def test_window_samples_earlier_start_raises():
    samples = np.arange(100, dtype=np.float32)
    reader = SequentialWindowReader(_chunks(samples, 7), sample_rate=10)

    reader.window_samples(10, 20)

    with pytest.raises(
        ValueError, match=r"window start sample 5 precedes the previous start sample 10"
    ):
        reader.window_samples(5, 8)


def test_window_and_window_samples_share_the_ordering_rule():
    samples = np.arange(100, dtype=np.float32)
    reader = SequentialWindowReader(_chunks(samples, 7), sample_rate=10)

    reader.window(1.0, 3.0)

    with pytest.raises(ValueError, match="precedes the previous start sample"):
        reader.window_samples(5, 8)


def test_close_closes_generator():
    closed = {"flag": False}

    def gen():
        try:
            yield np.zeros(10, dtype=np.float32)
            yield np.zeros(10, dtype=np.float32)
        finally:
            closed["flag"] = True

    reader = SequentialWindowReader(gen(), sample_rate=10)
    reader.window(0.0, 0.5)
    reader.close()

    assert closed["flag"] is True

    list_reader = SequentialWindowReader([np.zeros(10, dtype=np.float32)], sample_rate=10)
    list_reader.close()  # no-op, does not raise
