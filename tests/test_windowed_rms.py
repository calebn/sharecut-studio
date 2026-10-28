"""A windowed read of a track is the whole-track read, bit for bit, or a miss (#2357)."""

from __future__ import annotations

import copy
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import track_evidence, windowed_rms
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
from podcast_mcp.engines.ungated_audio import resampler_locality
from podcast_mcp.engines.windowed_rms import (
    WindowedTrackRmsCache,
    WindowMiss,
    resampled_window,
)
from podcast_mcp.util.batch_scope import batch_scope
from test_audio_eval import (
    CLIP_LAYOUTS,
    _chained,
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
    assert resampled_window(_Array(_noise(1, 1.0)), 44_100, RATE, 0, 10) is None
    assert resampled_window(_Array(_noise(1, 1.0)), 16_000, RATE, 0, 10) is None


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
        cache = track_evidence.rms_window(project, "caleb", load_defaults(), t0, t1, profile=BASE)
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
    cache = track_evidence.rms_window(
        project, "caleb", load_defaults(), -3.0, seconds + 3.0, profile=BASE
    )
    assert cache is not None and cache.coverage == (0, whole.size)
    assert _same(cache.window(0.0, seconds + 1.0), reference.window(0.0, seconds + 1.0))


def test_the_window_is_not_kept_with_the_tracks_whole_evidence(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    with batch_scope():
        track_evidence.rms_window(project, "caleb", load_defaults(), 2.0, 5.0, profile=BASE)
        store = track_evidence._store()
        planned = track_evidence._plan(project, "caleb", load_defaults())
        assert not isinstance(planned, Declined)
        assert not store.holds(planned[0])


def test_a_window_holds_the_slack_either_side_of_the_seconds_asked(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    with batch_scope():
        found = track_evidence.rms_window(project, "caleb", load_defaults(), 2.0, 6.0, profile=BASE)
    assert found is not None
    first, last = found.coverage
    assert first == 2 * RATE - track_evidence._WINDOW_SLACK
    assert last >= 6 * RATE + track_evidence._WINDOW_SLACK or last == found.total_size


def test_a_track_the_store_already_holds_is_read_whole(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    project = _project(tmp_path, "mixed joins and pads")
    with batch_scope():
        _full(project)
        assert (
            track_evidence.rms_window(project, "caleb", load_defaults(), 2.0, 5.0, profile=BASE)
            is None
        )


def test_verifying_evidence_compares_a_window_with_the_whole_track(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    monkeypatch.setenv(track_evidence.VERIFY_ENV, "1")
    project = _project(tmp_path, "mixed joins and pads")
    with batch_scope():
        assert (
            track_evidence.rms_window(project, "caleb", load_defaults(), 2.0, 5.0, profile=BASE)
            is not None
        )
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


# --- declines: the full path serves them ------------------------------------------------


def _window_of(project, curve: str | None = None):
    defaults = load_defaults()
    if curve is not None:
        defaults = copy.deepcopy(defaults)
        defaults["render"]["crossfade_curve"] = curve
    return track_evidence.rms_window(project, "caleb", defaults, 2.0, 6.0, profile=BASE)


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
    project = _project(tmp_path, "mixed joins and pads", mono_rate=44100)
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
