"""A windowed read of a track is the whole-track read, bit for bit, or a miss (#2357)."""

from __future__ import annotations

import copy
import shutil
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import audio_audit, track_evidence, windowed_rms
from podcast_mcp.engines.audio import (
    At,
    Audio,
    CrossfadeAudio,
    MaskAudio,
    MixAudio,
    MuteEnvelope,
    OffSpeakerAudio,
    SequenceAudio,
    SilenceAudio,
    SourceAudio,
    SourceMuteEnvelope,
)
from podcast_mcp.engines.audio_audit import TrackRmsCache, build_track_rms_caches
from podcast_mcp.engines.audio_eval import ArrayReader, evaluate_resampled, plan_audio
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.level_profile import LevelProfile, track_profile
from podcast_mcp.engines.track_evidence import Declined
from podcast_mcp.engines.ungated_audio import resampler_grid, resampler_locality
from podcast_mcp.engines.windowed_rms import (
    WindowedTrackRmsCache,
    WindowMiss,
    resampled_window,
)
from podcast_mcp.models import Clip, EpisodeProject
from podcast_mcp.util import project_state
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.project_state import project_state_lock
from test_audio_eval import (
    CLIP_LAYOUTS,
    _chained,
    _convert,
    _ffmpeg_or_skip,
    _project,
    _with_envelope,
    _with_second_source,
)

SOURCE_RATE = 48_000
RATE = 8_000
GRID = SOURCE_RATE // RATE
PATHS = (Path("a"), Path("b"))


def _bits(array: np.ndarray) -> np.ndarray:
    return np.ascontiguousarray(array, dtype=np.float32).view(np.uint32)


def _same(got: np.ndarray, want: np.ndarray) -> bool:
    return got.shape == want.shape and np.array_equal(_bits(got), _bits(want))


def _whole(piece_samples: np.ndarray) -> np.ndarray:
    return FFmpegEngine.resample_streams(iter([piece_samples]), SOURCE_RATE, [RATE])[RATE]


def _noise(seed: int, seconds: float) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(round(seconds * SOURCE_RATE)) / SOURCE_RATE
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 3 * t)
    return (rng.standard_normal(t.size) * 0.1 * envelope).astype(np.float32)


class _Array:
    """A ``Piece`` of a plain array, so the resampling is tested apart from the evaluator."""

    def __init__(self, samples: np.ndarray) -> None:
        self.size = samples.size
        self._samples = samples

    def read(self, start: int, stop: int) -> np.ndarray:
        assert 0 <= start <= stop <= self.size
        return self._samples[start:stop].copy()


def _windows(total: int, rng: np.random.Generator) -> list[tuple[int, int]]:
    """Output ranges at the places a restart or a cut can go wrong, and random ones."""
    warm_up, guard = resampler_locality(SOURCE_RATE, RATE) or (0, 0)
    edges = {0, 1, warm_up // GRID - 1, warm_up // GRID, warm_up // GRID + 1, guard // GRID}
    edges |= {total - 1, total, total + 1, total + 40, total - guard // GRID, total - 3}
    ranges = [(a, a + 1) for a in sorted(edges) if a >= 0]
    ranges += [(0, total), (0, 10), (total - 10, total + 10), (total + 5, total + 9)]
    for _ in range(14):
        first = int(rng.integers(0, total))
        ranges.append((first, first + int(rng.integers(1, 6000))))
    return ranges


@pytest.mark.parametrize("extra", range(GRID))
def test_a_window_of_the_resampled_track_is_the_whole_resample_there(extra: int) -> None:
    """Every residue of the input length mod the grid, so the stream's end takes each shape."""
    _ffmpeg_or_skip()
    samples = _noise(7 + extra, 9.0)[: 9 * SOURCE_RATE - 3 + extra]
    whole = _whole(samples)
    rng = np.random.default_rng(extra)

    for first, last in _windows(whole.size, rng):
        got = resampled_window(_Array(samples), SOURCE_RATE, RATE, first, last)
        assert got is not None
        window, at, total = got
        assert total == whole.size, (first, last)
        assert at == min(max(first, 0), total)
        want = whole[at : min(last, total)]
        assert _same(window, want), f"window {first}..{last} of {total}"


CD_RATE = 44_100


def _cd_noise(seed: int, length: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(length) / CD_RATE
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 3 * t)
    return (rng.standard_normal(length) * 0.1 * envelope).astype(np.float32)


def _cd_windows(total: int, rng: np.random.Generator) -> list[tuple[int, int]]:
    """Output ranges around the restart, the cut and the end of a 441:80 resample, and random ones."""
    found = resampler_locality(CD_RATE, RATE)
    assert found is not None
    warm_up, guard = found
    inputs, outputs = resampler_grid(CD_RATE, RATE)
    warm_out, guard_out = warm_up // inputs * outputs, guard // inputs * outputs
    edges = {
        0,
        1,
        outputs - 1,
        outputs,
        outputs + 1,
        warm_out - 1,
        warm_out,
        warm_out + 1,
        guard_out,
    }
    edges |= {
        total - 1,
        total,
        total + 1,
        total + 40,
        total - guard_out,
        total - 3,
        total - outputs - 1,
    }
    ranges = [(a, a + 1) for a in sorted(edges) if a >= 0]
    ranges += [(0, total), (0, 10), (total - 10, total + 10), (total + 5, total + 9), (-5, 10)]
    for _ in range(14):
        first = int(rng.integers(0, total))
        ranges.append((first, first + int(rng.integers(1, 6000))))
    return ranges


@pytest.mark.parametrize("extra", [0, 1, 80, 220, 440])
def test_a_window_of_a_44_1_khz_track_is_the_whole_resample_there(extra: int) -> None:
    """Five kinds of end for a 441:80 stream: the input length mod 441 sets the last period."""
    _ffmpeg_or_skip()
    samples = _cd_noise(5 + extra, 9 * CD_RATE - 7 + extra)
    whole = FFmpegEngine.resample_streams(iter([samples]), CD_RATE, [RATE])[RATE]
    rng = np.random.default_rng(extra)

    for first, last in _cd_windows(whole.size, rng):
        got = resampled_window(_Array(samples), CD_RATE, RATE, first, last)
        assert got is not None, (first, last)
        window, at, total = got
        assert total == whole.size, (first, last)
        assert at == min(max(first, 0), total)
        assert _same(window, whole[at : min(last, total)]), f"window {first}..{last} of {total}"


def test_a_window_of_a_short_44_1_khz_track_is_the_whole_resample_for_residues_across_a_period() -> (
    None
):
    """Every seventh input length mod 441 on a track just over the shortest run."""
    _ffmpeg_or_skip()
    inputs, _ = resampler_grid(CD_RATE, RATE)
    for extra in range(0, inputs, 7):
        samples = _cd_noise(extra, 12 * inputs + extra)
        whole = FFmpegEngine.resample_streams(iter([samples]), CD_RATE, [RATE])[RATE]
        for first, last in [
            (0, 5),
            (whole.size // 2, whole.size // 2 + 9),
            (whole.size - 4, whole.size + 4),
        ]:
            got = resampled_window(_Array(samples), CD_RATE, RATE, first, last)
            assert got is not None, (extra, first, last)
            window, at, total = got
            assert total == whole.size, (extra, first, last)
            assert _same(window, whole[at : min(last, total)]), (extra, first, last)


def test_a_44_1_khz_window_is_built_from_the_calibrated_warm_up_and_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Narrower widths change the bits at 441:80 as well."""
    _ffmpeg_or_skip()
    samples = _cd_noise(11, 6 * CD_RATE)
    whole = FFmpegEngine.resample_streams(iter([samples]), CD_RATE, [RATE])[RATE]
    found = resampler_locality(CD_RATE, RATE)
    assert found is not None
    warm_up, guard = found
    inputs, _ = resampler_grid(CD_RATE, RATE)
    first, last = 4000, 6000

    def narrower(warm: int, tail: int) -> np.ndarray:
        monkeypatch.setattr(windowed_rms, "resampler_locality", lambda *_: (warm, tail))
        got = resampled_window(_Array(samples), CD_RATE, RATE, first, last)
        assert got is not None
        return got[0]

    assert _same(narrower(warm_up, guard), whole[first:last])
    assert not _same(narrower(warm_up - inputs, guard), whole[first:last])
    assert not _same(narrower(warm_up, guard - inputs), whole[first:last])


@pytest.mark.parametrize("length", [441, 882, 1000, 1999, 4800, 4801, 44_100, 123_457, 300_001])
def test_the_length_of_a_44_1_khz_resample_is_found_from_a_restart_near_the_end(
    length: int,
) -> None:
    _ffmpeg_or_skip()
    samples = _cd_noise(length, length)
    whole = FFmpegEngine.resample_streams(iter([samples]), CD_RATE, [RATE])[RATE]
    got = resampled_window(_Array(samples), CD_RATE, RATE, 0, 3)
    assert got is not None, length
    assert got[2] == whole.size, length


def test_the_length_of_the_whole_resample_is_found_from_a_restart_near_the_end() -> None:
    _ffmpeg_or_skip()
    for length in [*range(4, 40), 1999, 4800, 4801, 48_005, 96_007, 123_457, 300_001]:
        samples = _noise(length, 7.0)[:length] if length <= 7 * SOURCE_RATE else _noise(1, 7.0)
        samples = np.resize(samples, length)
        whole = _whole(samples)
        got = resampled_window(_Array(samples), SOURCE_RATE, RATE, 0, 3)
        if got is None:
            continue
        assert got[2] == whole.size, length


def test_a_window_the_same_rate_is_a_slice_of_the_track() -> None:
    samples = _noise(3, 2.0)[:RATE]
    window, at, total = resampled_window(_Array(samples), RATE, RATE, 100, 300) or (None, 0, 0)
    assert window is not None
    assert (at, total) == (100, samples.size)
    assert _same(window, samples[100:300])
    beyond, at, total = resampled_window(_Array(samples), RATE, RATE, 7000, 9000) or (None, 0, 0)
    assert beyond is not None and _same(beyond, samples[7000:]) and at == 7000


def test_a_rate_the_resampler_is_not_calibrated_for_has_no_window() -> None:
    assert resampled_window(_Array(_noise(1, 1.0)), 22_050, RATE, 0, 10) is None
    assert resampled_window(_Array(_noise(1, 1.0)), 16_000, RATE, 0, 10) is None


def test_a_conversion_shorter_than_its_input_implies_has_no_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ffmpeg_or_skip()
    samples = _noise(5, 6.0)
    first, last = 4000, 6000
    _, guard = resampler_locality(SOURCE_RATE, RATE) or (0, 0)
    missing = guard // GRID + 2  # more than the guard feeds past the last output wanted
    real = FFmpegEngine.resample_streams
    assert resampled_window(_Array(samples), SOURCE_RATE, RATE, first, last) is not None

    def shorter(streams, from_rate, rates):  # type: ignore[no-untyped-def]
        converted = real(streams, from_rate, rates)
        return {rate: out[: out.size - missing] for rate, out in converted.items()}

    monkeypatch.setattr(FFmpegEngine, "resample_streams", staticmethod(shorter))

    assert resampled_window(_Array(samples), SOURCE_RATE, RATE, first, last) is None


def test_a_conversion_one_sample_short_of_what_the_window_needs_has_no_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ffmpeg_or_skip()
    samples = _noise(5, 6.0)
    first, last = 4000, 6000
    _, guard = resampler_locality(SOURCE_RATE, RATE) or (0, 0)
    real = FFmpegEngine.resample_streams
    results = []
    for short in range(guard // GRID + 4):

        def shorter(streams, from_rate, rates, short=short):  # type: ignore[no-untyped-def]
            converted = real(streams, from_rate, rates)
            return {rate: out[: out.size - short] for rate, out in converted.items()}

        monkeypatch.setattr(FFmpegEngine, "resample_streams", staticmethod(shorter))
        results.append(resampled_window(_Array(samples), SOURCE_RATE, RATE, first, last))

    assert results[0] is not None
    assert results[-1] is None
    # a window is the whole length asked for, or there is none: never one sample short
    assert all(r is None or r[0].size == last - first for r in results)


@pytest.mark.parametrize("extra", range(GRID))
def test_a_one_sample_read_inside_and_at_the_end_of_the_resampled_track_is_the_whole_resample(
    extra: int,
) -> None:
    _ffmpeg_or_skip()
    samples = _noise(9 + extra, 1.0)[: SOURCE_RATE // 2 - 3 + extra]
    whole = _whole(samples)

    for first in [*range(1, whole.size, 211), *range(whole.size - 60, whole.size)]:
        got = resampled_window(_Array(samples), SOURCE_RATE, RATE, first, first + 1)
        assert got is not None, first
        window, at, total = got
        assert total == whole.size, first
        assert _same(window, whole[at : min(first + 1, total)]), first


@pytest.mark.parametrize("extra", [0, 1, 80, 220, 440])
def test_a_one_sample_read_inside_and_at_the_end_of_a_44_1_khz_track_is_the_whole_resample(
    extra: int,
) -> None:
    _ffmpeg_or_skip()
    samples = _cd_noise(9 + extra, CD_RATE // 2 - 3 + extra)
    whole = FFmpegEngine.resample_streams(iter([samples]), CD_RATE, [RATE])[RATE]

    for first in [*range(1, whole.size, 211), *range(whole.size - 60, whole.size)]:
        got = resampled_window(_Array(samples), CD_RATE, RATE, first, first + 1)
        assert got is not None, first
        window, at, total = got
        assert total == whole.size, first
        assert _same(window, whole[at : min(first + 1, total)]), first


def test_a_window_is_built_from_the_calibrated_warm_up_and_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Narrower widths change the bits: the test would fail if the window stopped short of them."""
    _ffmpeg_or_skip()
    samples = _noise(11, 6.0)
    whole = _whole(samples)
    warm_up, guard = resampler_locality(SOURCE_RATE, RATE) or (0, 0)
    assert warm_up >= GRID and guard >= GRID
    first, last = 4000, 6000

    def narrower(warm: int, tail: int) -> np.ndarray:
        monkeypatch.setattr(windowed_rms, "resampler_locality", lambda *_: (warm, tail))
        got = resampled_window(_Array(samples), SOURCE_RATE, RATE, first, last)
        assert got is not None
        return got[0]

    assert _same(narrower(warm_up, guard), whole[first:last])
    assert not _same(narrower(warm_up - GRID, guard), whole[first:last])
    assert not _same(narrower(warm_up, guard - GRID), whole[first:last])


# --- trees ------------------------------------------------------------------------------


def _leaf(rng: np.random.Generator, path: Path | None = None, *, start: float | None = None):
    path = path or PATHS[int(rng.integers(0, 2))]
    a = float(rng.uniform(0.0, 18.0)) if start is None else start
    b = a + float(rng.uniform(0.5, 5.0))
    fade_in = float(rng.choice([0.0, 0.003, 0.05, 0.4]))
    fade_out = float(rng.choice([0.0, 0.003, 0.05, 0.4]))
    mutes: tuple[MuteEnvelope, ...] = ()
    if rng.random() < 0.4:
        at = float(rng.uniform(0.0, (b - a) * 0.5))
        mutes = (MuteEnvelope(at, at + float(rng.uniform(0.05, 0.6)), 0.03, 0.03),)
    return SourceAudio(path, a, b, fade_in, fade_out, mutes)


def _piece_of_tree(rng: np.random.Generator) -> Audio:
    parts: list[Audio] = []
    for _ in range(int(rng.integers(1, 4))):
        kind = rng.random()
        if kind < 0.3:
            parts.append(SilenceAudio(float(rng.uniform(0.05, 1.2))))
        elif kind < 0.6:
            left = _leaf(rng, PATHS[0])
            right = _leaf(rng, PATHS[0], start=left.src_start + float(rng.uniform(0.6, 3.0)))
            parts.append(CrossfadeAudio(left, right, float(rng.choice([0.002, 0.02, 0.2]))))
        else:
            parts.append(_leaf(rng))
    return parts[0] if len(parts) == 1 else SequenceAudio(parts[0], tuple(parts[1:]))


def _random_tree(rng: np.random.Generator) -> Audio:
    body = _piece_of_tree(rng)
    if rng.random() < 0.4:
        body = MixAudio(
            At(0.0, body),
            tuple(
                At(float(rng.uniform(0.0, 4.0)) + 1.0 / SOURCE_RATE * k, _piece_of_tree(rng))
                for k in range(int(rng.integers(1, 3)))
            ),
        )
    if rng.random() < 0.3:
        primary = next(iter(_sources_of(body)))
        body = OffSpeakerAudio(
            body,
            primary,
            (SourceMuteEnvelope(primary.src_start + 0.3, primary.src_start + 1.0, 0.05, 0.05),),
        )
    return body


def _sources_of(tree: Audio):
    from podcast_mcp.engines.audio import sources

    return sources(tree)


def plan_size(tree: Audio, readers: dict[Path, ArrayReader]) -> int:
    piece = plan_audio(
        tree, crossfade_curve="tri", reader=lambda path: readers[path], sample_rate=SOURCE_RATE
    )
    assert piece is not None
    return piece.size


def _readers() -> dict[Path, ArrayReader]:
    return {PATHS[0]: ArrayReader(_noise(1, 30.0)), PATHS[1]: ArrayReader(_noise(2, 30.0))}


@pytest.mark.parametrize("residue", range(GRID))
@pytest.mark.parametrize("seed", range(8))
def test_a_window_of_an_evaluated_tree_is_the_whole_evaluation_there(
    seed: int, residue: int
) -> None:
    """Random trees, each padded so its length takes every residue mod the grid.

    The evidence tree is the track's clips, fades, joins, pads and mutes; the effects chain is
    not in it (``timeline_render.unfiltered_track_audio``), so no chain parameters enter here.
    """
    _ffmpeg_or_skip()
    rng = np.random.default_rng(1000 + seed)
    readers = _readers()
    body = _random_tree(rng)
    tree = SequenceAudio(body, (SilenceAudio((SOURCE_RATE // 2 + residue) / SOURCE_RATE),))
    whole = evaluate_resampled(
        tree,
        crossfade_curve="tri",
        reader=lambda path: readers[path],
        sample_rate=SOURCE_RATE,
        target_rates=(RATE, 16_000),
        resample=FFmpegEngine.resample_streams,
    )
    piece = plan_audio(
        tree, crossfade_curve="tri", reader=lambda path: readers[path], sample_rate=SOURCE_RATE
    )
    assert whole is not None and piece is not None, "the seeded tree must be evaluable"
    assert piece.size % GRID == (plan_size(body, readers) + SOURCE_RATE // 2 + residue) % GRID
    expected = whole[RATE]

    for first, last in _windows(expected.size, rng):
        got = resampled_window(piece, SOURCE_RATE, RATE, first, last)
        assert got is not None
        window, at, total = got
        assert total == expected.size
        assert _same(window, expected[at : min(last, total)]), f"{first}..{last} of {total}"


# --- the cache --------------------------------------------------------------------------

BASE = LevelProfile(room_db=-60.0, speech_db=-20.0, loud_db=-12.0)


def _cache_pair(first: int, size: int) -> tuple[TrackRmsCache, WindowedTrackRmsCache, np.ndarray]:
    rng = np.random.default_rng(5)
    samples = (rng.standard_normal(RATE * 60) * 0.05).astype(np.float32)
    whole = TrackRmsCache(samples=samples, sample_rate=RATE, recording_profile=BASE)
    window = WindowedTrackRmsCache(
        samples[first : first + size].copy(),
        first_index=first,
        total_size=samples.size,
        sample_rate=RATE,
        profile=BASE,
    )
    return whole, window, samples


def test_a_read_inside_the_window_is_the_whole_track_read() -> None:
    whole, window, _ = _cache_pair(RATE * 20, RATE * 20)
    rng = np.random.default_rng(9)
    for _ in range(200):
        t0 = float(rng.uniform(20.0, 39.5))
        t1 = t0 + float(rng.uniform(0.0, 40.0 - t0))
        assert _same(window.window(t0, t1), whole.window(t0, t1))
        assert window.rms_db(t0, t1) == whole.rms_db(t0, t1)
        assert window.speech_rms_db(t0, t1) == whole.speech_rms_db(t0, t1)


def test_a_read_that_leaves_the_window_raises_rather_than_returning_a_part() -> None:
    _, window, _ = _cache_pair(RATE * 20, RATE * 20)
    for t0, t1 in [(19.99, 21.0), (39.0, 40.01), (10.0, 12.0), (50.0, 51.0), (0.0, 60.0)]:
        with pytest.raises(WindowMiss):
            window.window(t0, t1)
        with pytest.raises(WindowMiss):
            window.rms_db(t0, t1)


def test_a_read_past_the_end_of_the_track_is_empty_as_it_is_whole() -> None:
    """Where the whole-track cache has no samples, the window has none either, covered or not."""
    whole, window, _ = _cache_pair(RATE * 50, RATE * 8)
    for t0, t1 in [(60.0, 61.0), (61.0, 65.0), (70.0, 90.0)]:
        assert window.window(t0, t1).size == whole.window(t0, t1).size == 0
        assert window.rms_db(t0, t1) is None and whole.rms_db(t0, t1) is None
    with pytest.raises(WindowMiss):
        window.window(57.5, 60.5)  # the last seconds are not held
    assert _same(window.window(55.0, 57.9), whole.window(55.0, 57.9))


def test_a_profile_given_to_a_window_keeps_the_track_it_stands_for() -> None:
    whole, window, _ = _cache_pair(RATE * 20, RATE * 20)
    other = LevelProfile(room_db=-50.0, speech_db=-18.0, loud_db=-10.0)

    rebased = window.with_profile(other)

    assert isinstance(rebased, WindowedTrackRmsCache)
    assert rebased.total_size == window.total_size == RATE * 60
    assert rebased.coverage == window.coverage
    with pytest.raises(WindowMiss):
        rebased.window(10.0, 12.0)
    assert rebased.window(60.0, 61.0).size == 0 == whole.window(60.0, 61.0).size  # the track's end
    assert _same(rebased.window(25.0, 26.0), whole.window(25.0, 26.0))


def test_a_read_that_starts_before_the_track_is_clipped_at_its_start_as_it_is_whole() -> None:
    whole, window, _ = _cache_pair(0, RATE * 5)
    for t0, t1 in [(-1.0, 2.0), (-3.0, 0.5), (-0.001, 1.0)]:
        assert _same(window.window(t0, t1), whole.window(t0, t1))
        assert window.rms_db(t0, t1) == whole.rms_db(t0, t1)


def test_a_resampled_window_that_starts_before_the_track_is_the_start_of_it() -> None:
    _ffmpeg_or_skip()
    samples = _noise(3, 3.0)[: 3 * SOURCE_RATE - 1]
    whole = _whole(samples)
    for first, last in [(-5, 10), (-1, 1), (-100, 0)]:
        got = resampled_window(_Array(samples), SOURCE_RATE, RATE, first, last)
        assert got is not None
        window, at, total = got
        assert at == 0 and total == whole.size
        assert _same(window, whole[0 : max(0, min(last, total))])


def test_a_read_that_rounds_to_nothing_is_empty_as_it_is_whole() -> None:
    whole, window, _ = _cache_pair(RATE * 20, RATE * 20)
    assert window.window(25.0, 25.00001).size == whole.window(25.0, 25.00001).size
    assert window.window(30.0, 29.0).size == 0 == whole.window(30.0, 29.0).size


def test_the_windowed_cache_reports_the_profile_it_was_given_and_nothing_whole() -> None:
    _, window, _ = _cache_pair(RATE * 20, RATE * 20)
    assert window.profile is BASE
    for whole_track in (lambda: window.samples, lambda: window.speech_profile):
        with pytest.raises(WindowMiss):
            whole_track()
    other = LevelProfile(room_db=-50.0, speech_db=-18.0, loud_db=-10.0)
    assert window.with_profile(BASE) is window
    assert window.with_profile(other).profile is other
    assert window.with_profile(other).coverage == window.coverage
    assert not window.held.flags.writeable
    assert "WindowedTrackRmsCache" in repr(window)


def test_a_missing_window_is_not_an_error_a_consumer_may_swallow() -> None:
    """The checks tolerate an unreadable file; a miss must travel past them."""
    assert issubclass(WindowMiss, RuntimeError)
    assert not issubclass(WindowMiss, (OSError, ValueError, KeyError))


# --- the builder ------------------------------------------------------------------------


def _window(project, track_id: str, defaults, start: float, end: float):  # type: ignore[no-untyped-def]
    """The planned, built and verified window, as ``_windowed_caches`` takes it for one track."""
    plan = track_evidence.plan_window(project, track_id, defaults)
    if plan is None:
        return None
    cache = track_evidence.build_window(plan, start, end, profile=BASE)
    if cache is not None:
        plan.verify(cache)
    return cache


def _full(project) -> np.ndarray:
    entry = track_evidence._entry(project, "caleb", load_defaults(), locked=False)
    assert not isinstance(entry, Declined)
    return entry.samples[RATE]


@pytest.mark.parametrize("layout", list(CLIP_LAYOUTS))
def test_the_window_of_a_track_is_the_track_evidence_there(layout: str, tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, layout)
    whole = _full(project)
    seconds = whole.size / RATE
    rng = np.random.default_rng(len(layout))
    for _ in range(6):
        t0 = float(rng.uniform(0.0, seconds - 1.0))
        t1 = float(min(seconds + 1.0, t0 + rng.uniform(0.2, 8.0)))
        cache = _window(project, "caleb", load_defaults(), t0, t1)
        assert cache is not None
        assert cache.total_size == whole.size
        reference = TrackRmsCache(samples=whole, sample_rate=RATE)
        for a, b in [(t0, t1), (t0, (t0 + t1) / 2), ((t0 + t1) / 2, t1), (t0 + 0.01, t0 + 0.02)]:
            assert _same(cache.window(a, b), reference.window(a, b)), (layout, a, b)
            assert cache.rms_db(a, b) == reference.rms_db(a, b)


def test_a_window_reaching_the_ends_of_the_track_is_the_track_there(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    whole = _full(project)
    reference = TrackRmsCache(samples=whole, sample_rate=RATE)
    seconds = whole.size / RATE
    cache = _window(project, "caleb", load_defaults(), -3.0, seconds + 3.0)
    assert cache is not None and cache.coverage == (0, whole.size)
    assert _same(cache.window(0.0, seconds + 1.0), reference.window(0.0, seconds + 1.0))


def test_the_window_is_not_kept_with_the_tracks_whole_evidence(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    with batch_scope():
        _window(project, "caleb", load_defaults(), 2.0, 5.0)
        store = track_evidence._store()
        planned = track_evidence._plan(project, "caleb", load_defaults())
        assert not isinstance(planned, Declined)
        assert not store.holds(planned[0])


def test_a_window_holds_the_slack_either_side_of_the_seconds_asked(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    with batch_scope():
        found = _window(project, "caleb", load_defaults(), 2.0, 6.0)
    assert found is not None
    first, last = found.coverage
    assert first == 2 * RATE - track_evidence._WINDOW_SLACK
    assert last >= 6 * RATE + track_evidence._WINDOW_SLACK or last == found.total_size


def test_a_track_the_store_already_holds_is_read_whole(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    with batch_scope():
        _full(project)
        assert _window(project, "caleb", load_defaults(), 2.0, 5.0) is None


def test_verifying_evidence_compares_a_window_with_the_whole_track(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    monkeypatch.setenv(track_evidence.VERIFY_ENV, "1")
    project = _project(tmp_path, "mixed joins and pads")
    with batch_scope():
        assert _window(project, "caleb", load_defaults(), 2.0, 5.0) is not None
        # a corrupted window must be caught
        broken = WindowedTrackRmsCache(
            np.zeros(10, dtype=np.float32),
            first_index=0,
            total_size=4,
            sample_rate=RATE,
            profile=BASE,
        )
        entry = track_evidence._entry(project, "caleb", load_defaults(), locked=False)
        with pytest.raises(AssertionError):
            track_evidence._verify_window(broken, entry)


def test_a_44_1_khz_track_is_windowed_and_verified_against_the_whole_track(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    # With VERIFY_ENV set, the window check raises AssertionError on any difference from the whole.
    monkeypatch.setenv(track_evidence.VERIFY_ENV, "1")
    project = _project(tmp_path, "mixed joins and pads", mono_rate=44100)
    with batch_scope():
        assert _window(project, "caleb", load_defaults(), 2.0, 5.0) is not None


# --- declines: the full path serves them ------------------------------------------------


def _window_of(project, curve: str | None = None):
    defaults = load_defaults()
    if curve is not None:
        defaults = copy.deepcopy(defaults)
        defaults["render"]["crossfade_curve"] = curve
    return _window(project, "caleb", defaults, 2.0, 6.0)


def test_a_volume_envelope_keeps_the_render(tmp_path: Path) -> None:
    project = _project(tmp_path, "fade joins")
    _with_envelope(project)
    assert _window_of(project) is None


def test_a_non_triangular_curve_keeps_the_render(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "crossfade joins")
    assert _window_of(project, curve="qsin") is None
    assert _window_of(project) is not None


def test_a_mask_keeps_the_render(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "fade joins")
    real = track_evidence._plan

    def masked(project_, track_id, defaults):  # type: ignore[no-untyped-def]
        planned = real(project_, track_id, defaults)
        assert not isinstance(planned, Declined)
        return planned[0], MaskAudio(planned[1], 0.0, ((0.1, 0.2),))

    monkeypatch.setattr(track_evidence, "_plan", masked)
    assert _window_of(project) is None


def test_sources_at_different_rates_keep_the_render(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    _with_second_source(project, tmp_path / "project", rate=44100)
    assert _window_of(project) is None


def test_a_track_at_a_rate_the_resampler_is_not_calibrated_for_keeps_the_render(
    tmp_path: Path,
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads", mono_rate=22050)
    assert _window_of(project) is None


def test_bleed_restore_keeps_the_render(tmp_path: Path) -> None:
    from podcast_mcp.models import ClipBleedRestore
    from podcast_mcp.models.episode import SourceSpan
    from test_track_evidence import _with_off_speaker

    project = _project(tmp_path, "mixed joins and pads")
    _with_off_speaker(project, tmp_path / "project")
    for clip in [c for c in project.clips if c.track_id == "caleb"]:
        clip.bleed_restore = ClipBleedRestore(
            source_sha256="0" * 64,
            regions=[SourceSpan(start_s=clip.source_start + 0.2, end_s=clip.source_start + 0.3)],
        )
    assert _window_of(project) is None


def test_a_declined_track_is_built_whole_in_a_windowed_set(
    tmp_path: Path, render_calls: list[str]
) -> None:
    """``build_track_rms_caches`` takes the window where it can and the whole track where it cannot."""
    _ffmpeg_or_skip()
    project = _chained(_project(tmp_path, "fade joins"))
    _with_envelope(project)
    window = windowed_rms.TimelineWindow(2.0, 6.0, {"caleb": BASE})

    caches = build_track_rms_caches(
        project, track_ids=["caleb"], unprocessed=True, window=window, defaults=load_defaults()
    )

    cache = caches.caches["caleb"]
    assert not isinstance(cache, WindowedTrackRmsCache)
    assert cache.samples.size > 0
    assert render_calls == ["caleb"]


def test_a_chained_track_is_windowed_and_the_rest_are_not(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _chained(_project(tmp_path, "mixed joins and pads"))
    window = windowed_rms.TimelineWindow(2.0, 6.0, {"caleb": BASE})

    caches = build_track_rms_caches(
        project, track_ids=["caleb"], unprocessed=True, window=window, defaults=load_defaults()
    )
    unwindowed = build_track_rms_caches(
        project, track_ids=["caleb"], unprocessed=True, defaults=load_defaults()
    )

    cache = caches.caches["caleb"]
    assert isinstance(cache, WindowedTrackRmsCache)
    assert cache.profile is BASE
    assert _same(cache.window(2.0, 6.0), unwindowed.caches["caleb"].window(2.0, 6.0))
    # the whole-track build measures its own profile; the window must not
    assert unwindowed.caches["caleb"].profile != BASE
    assert track_profile(unwindowed.caches["caleb"].samples, RATE) != BASE


# --- the windows of one rebuild are built together (#2359) --------------------------------


def _alias_two_ids_by_patching_plan_window(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Patch ``plan_window`` so ids ``a`` and ``b`` both plan the project's one track (``caleb``)."""
    real = track_evidence.plan_window

    def plan(project, track_id, defaults, **kwargs):  # type: ignore[no-untyped-def]
        return real(project, "caleb", defaults, **kwargs)

    monkeypatch.setattr(track_evidence, "plan_window", plan)
    return ["a", "b"]


def _distinct_tracks(project, workspace: Path, rate: int | None) -> list[str]:
    """``caleb`` and ``audra``: different recordings under different clip layouts."""
    if rate is not None:
        source = workspace / "raw" / "audra.flac"
        _convert(source, workspace / "audra.tmp.flac", rate=rate)
        shutil.move(workspace / "audra.tmp.flac", source)
    project.timeline.clips = [c for c in project.clips if c.track_id != "audra"] + [
        Clip(
            id=f"audra{i}",
            track_id="audra",
            source_start=start,
            source_end=end,
            timeline_start=at,
            fade_in_ms=fade_in,
            fade_out_ms=fade_out,
            join_in_mode=mode,
        )
        for i, (start, end, at, fade_in, fade_out, mode) in enumerate(CLIP_LAYOUTS["fade joins"])
    ]
    return ["caleb", "audra"]


def _windowed(project, ids: list[str], *, private: bool = True) -> dict:
    window = windowed_rms.TimelineWindow(2.0, 6.0, {tid: BASE for tid in ids})
    return audio_audit._windowed_caches(project, ids, window, load_defaults(), private)


@pytest.mark.parametrize("mono_rate", [None, 44100])
def test_windows_built_together_are_those_built_one_after_another(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mono_rate: int | None
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads", mono_rate=mono_rate)
    ids = _alias_two_ids_by_patching_plan_window(monkeypatch)
    with monkeypatch.context() as serial:
        serial.setattr(audio_audit, "cpu_budget", lambda: 1)
        one_by_one = _windowed(project, ids)
    monkeypatch.setattr(audio_audit, "cpu_budget", lambda: 2)

    together = _windowed(project, ids)

    assert list(together) == list(one_by_one) == ids
    for tid in ids:
        got, want = together[tid], one_by_one[tid]
        assert isinstance(got, WindowedTrackRmsCache) and isinstance(want, WindowedTrackRmsCache)
        assert (got.coverage, got.total_size) == (want.coverage, want.total_size)
        assert _same(got.held, want.held)


@pytest.mark.parametrize("rate", [48000, 44100])
def test_windows_of_distinct_tracks_built_together_are_those_built_one_after_another(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, rate: int
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads", mono_rate=None if rate == 48000 else rate)
    ids = _distinct_tracks(project, tmp_path / "project", None if rate == 48000 else rate)
    with monkeypatch.context() as serial:
        serial.setattr(audio_audit, "cpu_budget", lambda: 1)
        one_by_one = _windowed(project, ids)
    monkeypatch.setattr(audio_audit, "cpu_budget", lambda: 2)

    together = _windowed(project, ids)

    assert list(together) == list(one_by_one) == ids
    for tid in ids:
        got, want = together[tid], one_by_one[tid]
        assert isinstance(got, WindowedTrackRmsCache) and isinstance(want, WindowedTrackRmsCache)
        assert (got.coverage, got.total_size) == (want.coverage, want.total_size)
        assert _same(got.held, want.held)
    assert not _same(together["caleb"].held, together["audra"].held)


def test_windows_are_built_while_the_caller_holds_the_project_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    ids = _alias_two_ids_by_patching_plan_window(monkeypatch)
    monkeypatch.setattr(audio_audit, "cpu_budget", lambda: 2)
    result: dict = {}
    failures: list[Exception] = []
    real = project_state.project_state_lock

    # A pool worker that blocked on the lock its caller holds would never return, and the pool's
    # non-daemon workers would keep pytest from exiting. The owner re-enters the RLock without
    # waiting; any other thread gets an error instead of a wait.
    @contextmanager
    def lock_or_fail(project: EpisodeProject) -> Iterator[None]:
        lock = real(project)
        if not lock.acquire(blocking=False):
            raise AssertionError("a window build waited for the lock its caller held")
        try:
            yield
        finally:
            lock.release()

    monkeypatch.setattr(project_state, "project_state_lock", lock_or_fail)
    monkeypatch.setattr(track_evidence, "project_state_lock", lock_or_fail)

    def approve() -> None:
        try:
            with real(project):
                result.update(_windowed(project, ids, private=False))
        except Exception as exc:  # handed to the test thread
            failures.append(exc)

    caller = threading.Thread(target=approve, daemon=True)
    caller.start()
    caller.join(timeout=60)

    assert not caller.is_alive(), "the window builds did not finish"
    assert not failures, failures
    assert list(result) == ids


@pytest.mark.parametrize("budget", [1, 2])
def test_window_builds_run_exactly_as_wide_as_the_cpu_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, budget: int
) -> None:
    project = _project(tmp_path, "mixed joins and pads")
    monkeypatch.setattr(track_evidence, "plan_window", lambda *args, **kwargs: object())
    monkeypatch.setattr(audio_audit, "cpu_budget", lambda: budget)
    gate = threading.Lock()
    saturated, overflow = threading.Event(), threading.Event()
    in_flight = peak = 0

    def build(
        plan: object, start: float, end: float, *, profile: LevelProfile
    ) -> WindowedTrackRmsCache | None:
        nonlocal in_flight, peak
        with gate:
            in_flight += 1
            peak = max(peak, in_flight)
            if in_flight >= budget:
                saturated.set()
            if in_flight > budget:
                overflow.set()
        try:
            # The pool must fill up to the budget (only a failure waits out this timeout)...
            assert saturated.wait(timeout=5), "the pool never reached the cpu budget"
            # ...and an extra build, if the cap is gone, starts within this grace and ends it.
            overflow.wait(timeout=0.1)
        finally:
            with gate:
                in_flight -= 1
        return None

    monkeypatch.setattr(track_evidence, "build_window", build)

    found = _windowed(project, ["a", "b", "c"])

    assert found == {}
    assert peak == budget


def test_the_verify_check_runs_on_the_calling_thread_that_holds_the_project_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    ids = _alias_two_ids_by_patching_plan_window(monkeypatch)
    monkeypatch.setattr(audio_audit, "cpu_budget", lambda: 2)
    monkeypatch.setenv(track_evidence.VERIFY_ENV, "1")
    real = track_evidence.WindowPlan.verify
    verified: list[int] = []
    result: dict = {}
    failures: list[BaseException] = []

    def approve() -> None:
        caller = threading.get_ident()

        # verify takes project_state_lock for a non-private plan, so in a pool worker it would
        # wait on the lock this thread holds. The spy fails at once there rather than hang.
        def verify(plan, cache):  # type: ignore[no-untyped-def]
            verified.append(threading.get_ident())
            if threading.get_ident() != caller:
                raise AssertionError("verify ran off the thread that holds the project lock")
            real(plan, cache)

        try:
            with monkeypatch.context() as spy, project_state_lock(project):
                spy.setattr(track_evidence.WindowPlan, "verify", verify)
                result.update(_windowed(project, ids, private=False))
        except BaseException as exc:  # handed to the test thread
            failures.append(exc)

    caller_thread = threading.Thread(target=approve, daemon=True)
    caller_thread.start()
    caller_thread.join(timeout=120)

    assert not caller_thread.is_alive(), "the verify check waited for the lock its caller held"
    assert not failures, failures
    assert list(result) == ids
    assert len(verified) == len(ids)
    assert set(verified) == {caller_thread.ident}


def test_a_track_whose_window_cannot_be_built_is_skipped_and_the_other_is_built(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    ids = _alias_two_ids_by_patching_plan_window(monkeypatch)
    monkeypatch.setattr(audio_audit, "cpu_budget", lambda: 2)
    profiles = {"a": BASE, "b": LevelProfile(room_db=-61.0, speech_db=-21.0, loud_db=-13.0)}
    real = track_evidence.build_window

    def build(plan, start, end, *, profile):  # type: ignore[no-untyped-def]
        if profile is profiles["a"]:
            raise ValueError("bad")
        return real(plan, start, end, profile=profile)

    monkeypatch.setattr(track_evidence, "build_window", build)
    window = windowed_rms.TimelineWindow(2.0, 6.0, profiles)

    found = audio_audit._windowed_caches(project, ids, window, load_defaults(), True)

    assert list(found) == ["b"]
    assert found["b"].profile is profiles["b"]


@pytest.mark.parametrize(
    ("errors", "raised"),
    [
        ({"a": RuntimeError("first"), "b": KeyError("second")}, RuntimeError),
        ({"a": OSError("skipped"), "b": KeyError("second")}, KeyError),
        ({"a": KeyError("first"), "b": OSError("skipped")}, KeyError),
    ],
)
def test_the_first_error_by_track_order_is_the_one_raised(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    errors: dict[str, Exception],
    raised: type[Exception],
) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    ids = _alias_two_ids_by_patching_plan_window(monkeypatch)
    monkeypatch.setattr(audio_audit, "cpu_budget", lambda: 2)
    profiles = {"a": BASE, "b": LevelProfile(room_db=-61.0, speech_db=-21.0, loud_db=-13.0)}
    by_profile = {id(profile): tid for tid, profile in profiles.items()}

    def build(plan, start, end, *, profile):  # type: ignore[no-untyped-def]
        raise errors[by_profile[id(profile)]]

    monkeypatch.setattr(track_evidence, "build_window", build)
    window = windowed_rms.TimelineWindow(2.0, 6.0, profiles)

    with pytest.raises(raised) as caught:
        audio_audit._windowed_caches(project, ids, window, load_defaults(), True)

    expected = next(e for e in errors.values() if not isinstance(e, OSError))
    assert caught.value is expected


@pytest.mark.parametrize("extra", [0, 5])
def test_the_window_and_the_tail_are_converted_at_the_same_time(
    monkeypatch: pytest.MonkeyPatch, extra: int
) -> None:
    _ffmpeg_or_skip()
    samples = _noise(3, 9.0)[: 9 * SOURCE_RATE - 3 + extra]
    whole = _whole(samples)
    first, last = 20_000, 24_000
    real = FFmpegEngine.resample_streams
    both_running = threading.Barrier(2, timeout=20)

    def meeting(chunks, from_rate, rates):  # type: ignore[no-untyped-def]
        both_running.wait()
        return real(chunks, from_rate, rates)

    monkeypatch.setattr(FFmpegEngine, "resample_streams", staticmethod(meeting))

    got = resampled_window(_Array(samples), SOURCE_RATE, RATE, first, last)

    assert got is not None
    window, at, total = got
    assert total == whole.size
    assert _same(window, whole[at : min(last, total)])
