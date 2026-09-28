"""Tests for engines/prosody.py: pure helpers, a synthetic backend check, and a
Praat reference spot check against tests/fixtures/word_boundary."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from podcast_mcp.engines import prosody as prosody_engine
from podcast_mcp.engines.prosody import (
    ProsodyParams,
    ProsodyUnavailable,
    WordSpan,
    _boundaries,
    _frame_slice,
    _voice_quality,
    _words_by_span,
    parselmouth_version,
    segment_bounds,
    syllable_count_text,
    syllable_nuclei,
)

FIXTURE = Path(__file__).parent / "fixtures" / "word_boundary" / "5338-24640-0003.wav"
GOLD = Path(__file__).parent / "fixtures" / "word_boundary" / "5338-24640-0003.gold.json"


# --- Pure helpers (no parselmouth needed) -----------------------------------


def test_syllable_count_text_counts_vowel_groups() -> None:
    assert syllable_count_text("cat") == 1
    assert syllable_count_text("banana") == 3
    assert syllable_count_text("queue") == 1  # one vowel group
    assert syllable_count_text("") == 1
    assert syllable_count_text("strengths") == 1


def test_segment_bounds_merges_close_words_and_splits_on_gap() -> None:
    words = [
        WordSpan("a", 0.0, 0.5),
        WordSpan("b", 0.6, 1.0),  # 0.1s gap: merges (gap_sec=1.0)
        WordSpan("c", 3.0, 3.4),  # 2.0s gap: new segment
    ]
    params = ProsodyParams(segment_gap_sec=1.0, max_segment_sec=30.0)
    bounds = segment_bounds(words, total_dur=10.0, params=params)
    assert bounds == [(0.0, 1.0), (3.0, 3.4)]


def test_segment_bounds_splits_long_runs_at_max_segment_sec() -> None:
    words = [WordSpan(str(i), float(i), float(i) + 0.5) for i in range(0, 40, 1)]
    params = ProsodyParams(segment_gap_sec=1.0, max_segment_sec=10.0)
    bounds = segment_bounds(words, total_dur=100.0, params=params)
    assert len(bounds) > 1
    assert all(e - s <= 10.0 + 1e-6 for s, e in bounds)


def test_segment_bounds_empty_words_no_samples_returns_empty() -> None:
    params = ProsodyParams()
    assert segment_bounds([], total_dur=5.0, params=params) == []


def test_boundaries_drop_weak_pauses_and_keep_strong_ones(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prosody_engine, "praat_call", None)  # pitch_reset = 0
    words = [WordSpan("cat", 0.0, 0.3), WordSpan("dog", 0.32, 0.62), WordSpan("pig", 1.02, 1.32)]
    # Equal duration per syllable -> lengthening 0.5 (0.15). Gap 0.02s -> 0.16 (< 0.3), dropped.
    # Gap 0.4s -> 0.2 + 0.15 = 0.35, kept.
    out = _boundaries(words, None, seg_start=0.0, seg_end=1.32, min_strength=0.3)
    gaps = [b for b in out if b["kind"] == "word_gap"]
    assert len(gaps) == 1
    assert gaps[0]["time"] == pytest.approx(0.62)
    assert gaps[0]["strength"] == pytest.approx(0.35, abs=1e-3)
    assert out[-1]["kind"] == "segment_end"


def test_words_by_span_matches_brute_force_filter() -> None:
    words = [
        WordSpan("c", 3.0, 3.4),
        WordSpan("a", 0.0, 0.5),
        WordSpan("b", 0.6, 1.0),
        WordSpan("z", 9.0, 9.2),
    ]
    bounds = [(0.0, 1.0), (3.0, 3.4)]
    result = _words_by_span(words, bounds)
    assert {span: [w.text for w in ws] for span, ws in result.items()} == {
        (0.0, 1.0): ["a", "b"],
        (3.0, 3.4): ["c"],
    }
    ordered = sorted(words, key=lambda w: w.start)
    for span in bounds:
        s, e = span
        brute = [w for w in ordered if s - 1e-6 <= w.start < e + 1e-6]
        assert result[span] == brute


def test_frame_slice_matches_boolean_mask() -> None:
    xs = np.arange(0.0, 5.0, 0.01)
    for s, e in [(0.0, 1.0), (1.005, 2.5), (2.5, 2.5), (4.99, 10.0), (-1.0, 0.0)]:
        assert np.array_equal(xs[_frame_slice(xs, s, e)], xs[(xs >= s) & (xs < e)])


def test_voice_quality_flags_zero_hnr_as_low() -> None:
    vq = _voice_quality(jitter=0.005, shimmer=0.02, hnr=0.0)
    assert vq["hnr_db"] == 0.0
    assert vq["hnr_low"] is True
    assert vq["jitter_high"] is False
    assert vq["shimmer_high"] is False


def test_voice_quality_thresholds() -> None:
    vq = _voice_quality(jitter=0.02, shimmer=0.05, hnr=20.0)
    assert vq["jitter_high"] is True
    assert vq["shimmer_high"] is True
    assert vq["hnr_low"] is False


@pytest.mark.parametrize("value", [None, float("nan"), float("inf")])
def test_voice_quality_unmeasured_values_do_not_flag(value) -> None:
    vq = _voice_quality(jitter=value, shimmer=value, hnr=value)
    assert vq == {
        "jitter_local": 0.0,
        "shimmer_local": 0.0,
        "hnr_db": 0.0,
        "jitter_high": False,
        "shimmer_high": False,
        "hnr_low": False,
    }


def test_segment_bounds_from_energy_when_no_words() -> None:
    sr = 16000
    t = np.arange(sr * 3) / sr
    # Loud in [0.5, 1.5), silent elsewhere.
    env = np.where((t >= 0.5) & (t < 1.5), 1.0, 0.0)
    samples = (env * np.sin(2 * np.pi * 200 * t)).astype(np.float32)
    params = ProsodyParams(segment_gap_sec=0.2, max_segment_sec=30.0)
    bounds = segment_bounds([], total_dur=3.0, params=params, samples=samples, sr=sr)
    assert len(bounds) == 1
    start, end = bounds[0]
    assert 0.3 < start < 0.7
    assert 1.3 < end < 1.7


def test_syllable_nuclei_counts_prominent_voiced_peaks() -> None:
    # Three clear peaks separated by dips >= 2 dB, all voiced.
    db = np.array([10.0, 20.0, 12.0, 22.0, 11.0, 23.0, 9.0])
    voiced = np.ones_like(db, dtype=bool)
    times = np.arange(db.size) * 0.01
    assert syllable_nuclei(times, db, voiced) == 3


def test_syllable_nuclei_ignores_unvoiced_peaks() -> None:
    db = np.array([10.0, 20.0, 12.0, 22.0, 11.0])
    voiced = np.array([False, False, False, True, False])
    times = np.arange(db.size) * 0.01
    # Only the second peak (index 3) is voiced.
    assert syllable_nuclei(times, db, voiced) == 1


def test_syllable_nuclei_ignores_small_dips() -> None:
    db = np.array([10.0, 10.5, 10.2, 10.8, 10.0])
    voiced = np.ones_like(db, dtype=bool)
    times = np.arange(db.size) * 0.01
    assert syllable_nuclei(times, db, voiced) == 0


def test_syllable_nuclei_ignores_frames_below_silence_ceiling() -> None:
    # A quiet peak (20 dB) sits more than 25 dB under the segment's own ceiling
    # (the 60 dB peak), so only the loud peak counts.
    db = np.array([10.0, 20.0, 10.0, 60.0, 10.0])
    voiced = np.ones_like(db, dtype=bool)
    times = np.arange(db.size) * 0.01
    assert syllable_nuclei(times, db, voiced, silence_ceiling_db=25.0) == 1


# --- Backend (needs the `prosody` extra) -------------------------------------


def test_analyze_prosody_unavailable_without_parselmouth(monkeypatch: pytest.MonkeyPatch) -> None:
    import podcast_mcp.engines.prosody as prosody_mod

    monkeypatch.setattr(prosody_mod, "parselmouth", None)
    monkeypatch.setattr(prosody_mod, "praat_call", None)
    assert prosody_mod.parselmouth_version() is None
    with pytest.raises(ProsodyUnavailable):
        prosody_mod.analyze_prosody(np.zeros(16000, dtype=np.float32), 16000, [], ProsodyParams())


def test_analyze_prosody_synthetic_harmonic_signal() -> None:
    pytest.importorskip("parselmouth")
    from podcast_mcp.engines.prosody import analyze_prosody

    sr = 16000
    dur = 3.0
    t = np.arange(int(sr * dur)) / sr
    f0 = 150.0
    env = np.linspace(1.0, 0.2, t.size)  # falling energy
    sig = env * (
        0.6 * np.sin(2 * np.pi * f0 * t)
        + 0.3 * np.sin(2 * np.pi * 2 * f0 * t)
        + 0.1 * np.sin(2 * np.pi * 3 * f0 * t)
    )
    result = analyze_prosody(sig.astype(np.float32), sr, [], ProsodyParams.from_defaults({}))
    assert result["engine"]["backend"] == "parselmouth"
    segs = result["segments"]
    assert len(segs) == 1
    seg = segs[0]
    assert abs(seg["f0"]["mean_hz"] - f0) <= 3.0
    assert seg["energy"]["trend"] == "falling"
    assert seg["energy"]["drop_db"] > 0
    for key in ("f0", "rate", "pauses", "energy", "voice_quality"):
        for value in seg[key].values():
            if isinstance(value, float):
                assert np.isfinite(value)


def test_analyze_prosody_honors_cancel_check() -> None:
    pytest.importorskip("parselmouth")
    from podcast_mcp.engines.prosody import analyze_prosody
    from podcast_mcp.util.progress import CancelledProgress

    sr = 16000
    sig = (0.3 * np.sin(2 * np.pi * 150 * np.arange(sr) / sr)).astype(np.float32)
    with pytest.raises(CancelledProgress):
        analyze_prosody(sig, sr, [], ProsodyParams(), cancel_check=lambda: True)


def test_analyze_prosody_no_nan_on_silence() -> None:
    pytest.importorskip("parselmouth")
    from podcast_mcp.engines.prosody import analyze_prosody

    sr = 16000
    samples = np.zeros(sr * 2, dtype=np.float32)
    words = [WordSpan("silence", 0.0, 2.0)]
    result = analyze_prosody(samples, sr, words, ProsodyParams.from_defaults({}))
    seg = result["segments"][0]
    for section in ("f0", "rate", "pauses", "energy", "voice_quality"):
        for value in seg[section].values():
            if isinstance(value, float):
                assert np.isfinite(value)


# --- Praat reference spot check (real speech) --------------------------------


@pytest.mark.parametrize("entry", ["array", "file"])
def test_prosody_matches_praat_reference_on_fixture(entry: str) -> None:
    pytest.importorskip("parselmouth")
    if entry == "file" and shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not available")
    from podcast_mcp.engines.audio_audit import load_mono_full
    from podcast_mcp.engines.prosody import analyze_prosody, analyze_prosody_file

    assert parselmouth_version() is not None
    gold = json.loads(GOLD.read_text(encoding="utf-8"))
    words = [WordSpan(w["text"], w["start"], w["end"]) for w in gold["words"]]
    if entry == "array":
        samples = load_mono_full(FIXTURE, sample_rate=16000)
        result = analyze_prosody(samples, 16000, words, ProsodyParams.from_defaults({}))
    else:
        result = analyze_prosody_file(FIXTURE, words, ProsodyParams.from_defaults({}))
    segs = result["segments"]
    assert len(segs) == 1
    seg = segs[0]

    import parselmouth
    from parselmouth.praat import call

    snd = parselmouth.Sound(str(FIXTURE))
    start, end = seg["start"], seg["end"]
    pitch = snd.to_pitch_ac(pitch_floor=75, pitch_ceiling=500)
    ref_f0 = call(pitch, "Get mean", start, end, "Hertz")
    intensity = snd.to_intensity()
    ref_intensity = call(intensity, "Get mean", start, end, "dB")

    assert abs(seg["f0"]["mean_hz"] - ref_f0) <= ref_f0 * 0.05
    assert abs(seg["energy"]["mean_db"] - ref_intensity) <= 1.5
    assert 2.0 <= seg["rate"]["speech_rate"] <= 8.0


# --- Bounded-memory streaming (analyze_prosody_file, #727) --------------------


def _two_copy_track() -> tuple[np.ndarray, list[WordSpan], list[WordSpan], int]:
    """Loud fixture copy, then a 0.1x quiet copy, separated by silence, with gold words."""
    from podcast_mcp.engines.audio_audit import load_mono_full

    sr = 16000
    s = load_mono_full(FIXTURE, sample_rate=sr)
    gold = json.loads(GOLD.read_text(encoding="utf-8"))
    gold_words = [WordSpan(w["text"], w["start"], w["end"]) for w in gold["words"]]
    pad = np.zeros(int(3.0 * sr), dtype=np.float32)
    track = np.concatenate([pad, s, pad, (0.1 * s).astype(np.float32)])
    offset0 = 3.0
    offset1 = 3.0 + len(s) / sr + 3.0
    words0 = [WordSpan(w.text, w.start + offset0, w.end + offset0) for w in gold_words]
    words1 = [WordSpan(w.text, w.start + offset1, w.end + offset1) for w in gold_words]
    return track, words0, words1, sr


class _FakeStreamEngine:
    """A ``FFmpegEngine.stream_mono_f32`` stand-in over an in-memory track.

    Tracks how many streams were opened and whether the most recently opened
    stream's generator was closed (its ``finally`` ran).
    """

    def __init__(self, track: np.ndarray, sr: int, chunk_frames: int = 4000) -> None:
        self.track = track
        self.sr = sr
        self.chunk_frames = chunk_frames
        self.calls = 0
        self.closed = False
        self.yielded = 0

    def stream_mono_f32(
        self, path: Path, *, sample_rate: int, chunk_frames: int | None = None
    ) -> Any:
        assert sample_rate == self.sr
        self.calls += 1
        track = self.track
        size = self.chunk_frames

        def gen() -> Any:
            try:
                for i in range(0, track.size, size):
                    self.yielded += 1
                    yield track[i : i + size]
            finally:
                self.closed = True

        return gen()


def test_analyze_prosody_is_invariant_to_loudness_elsewhere() -> None:
    pytest.importorskip("parselmouth")
    from podcast_mcp.engines.prosody import analyze_prosody

    track, words0, words1, sr = _two_copy_track()
    result = analyze_prosody(track, sr, words0 + words1, ProsodyParams.from_defaults({}))
    segs = result["segments"]
    assert len(segs) == 2
    seg0, seg1 = segs

    # Whole-file (pre-#727) analysis over this same track gave the quiet copy an
    # F0 mean of ~232 Hz against ~205 Hz for the loud copy, and an undefined HNR:
    # Praat's silence/voicing thresholds are relative to the whole Sound's peak.
    # Per-window analysis is gain-invariant.
    f0_0, f0_1 = seg0["f0"]["mean_hz"], seg1["f0"]["mean_hz"]
    assert abs(f0_1 - f0_0) <= 0.01 * f0_0
    assert abs((seg0["energy"]["mean_db"] - seg1["energy"]["mean_db"]) - 20.0) < 1.0
    assert abs(seg1["voice_quality"]["hnr_db"] - seg0["voice_quality"]["hnr_db"]) < 0.5


def test_analyze_prosody_file_matches_array_path_with_bounded_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("parselmouth")
    from podcast_mcp.engines.prosody import analyze_prosody, analyze_prosody_file
    from podcast_mcp.util.pcm_stream import SequentialWindowReader

    track, words0, words1, sr = _two_copy_track()
    words = words0 + words1
    params = ProsodyParams.from_defaults({})
    fake = _FakeStreamEngine(track, sr)

    window_lengths: list[int] = []
    original_window = SequentialWindowReader.window

    def spy_window(self: SequentialWindowReader, start_sec: float, end_sec: float):
        samples, t0 = original_window(self, start_sec, end_sec)
        window_lengths.append(len(samples))
        return samples, t0

    monkeypatch.setattr(SequentialWindowReader, "window", spy_window)

    file_result = analyze_prosody_file(Path("x.wav"), words, params, engine=fake)  # type: ignore[arg-type]
    array_result = analyze_prosody(track, sr, words, params)

    assert file_result == array_result
    assert fake.calls == 1
    max_len = int((params.max_segment_sec + 2 * 0.5) * sr) + 2
    assert window_lengths and all(length <= max_len for length in window_lengths)


def test_analyze_prosody_file_energy_path_decodes_twice() -> None:
    pytest.importorskip("parselmouth")
    from podcast_mcp.engines.prosody import analyze_prosody, analyze_prosody_file

    track, _words0, _words1, sr = _two_copy_track()
    params = ProsodyParams.from_defaults({})
    fake = _FakeStreamEngine(track, sr)

    file_result = analyze_prosody_file(Path("x.wav"), [], params, engine=fake)  # type: ignore[arg-type]
    array_result = analyze_prosody(track, sr, [], params)

    assert file_result == array_result
    assert fake.calls == 2


def test_analyze_prosody_file_closes_stream_on_cancel() -> None:
    pytest.importorskip("parselmouth")
    from podcast_mcp.engines.prosody import analyze_prosody_file
    from podcast_mcp.util.progress import CancelledProgress

    track, words0, words1, sr = _two_copy_track()
    words = words0 + words1
    params = ProsodyParams.from_defaults({})
    fake = _FakeStreamEngine(track, sr)
    polls = {"n": 0}

    def cancel_check() -> bool:
        polls["n"] += 1
        return polls["n"] >= 2  # False on segment 1's poll, True on segment 2's

    with pytest.raises(CancelledProgress):
        analyze_prosody_file(
            Path("x.wav"),
            words,
            params,
            cancel_check=cancel_check,
            engine=fake,  # type: ignore[arg-type]
        )

    assert fake.closed is True


def test_analyze_prosody_file_cancels_during_energy_pass() -> None:
    pytest.importorskip("parselmouth")
    from podcast_mcp.engines.prosody import analyze_prosody_file
    from podcast_mcp.util.progress import CancelledProgress

    track, _w0, _w1, sr = _two_copy_track()
    fake = _FakeStreamEngine(track, sr)
    polls = {"n": 0}

    def cancel_check() -> bool:
        polls["n"] += 1
        return polls["n"] >= 2  # cancel on the energy pass's second chunk

    with pytest.raises(CancelledProgress):
        analyze_prosody_file(
            Path("x.wav"),
            [],
            ProsodyParams.from_defaults({}),
            cancel_check=cancel_check,
            engine=fake,  # type: ignore[arg-type]
        )
    assert fake.calls == 1  # the second (segment) decode never opened
    assert fake.closed is True
    assert fake.yielded < -(-track.size // fake.chunk_frames)


def test_analyze_prosody_file_clamps_segments_past_end_of_audio() -> None:
    pytest.importorskip("parselmouth")
    from podcast_mcp.engines.prosody import analyze_prosody_file

    sr = 16000
    t = np.arange(int(sr * 2.0)) / sr
    tone = (0.3 * np.sin(2 * np.pi * 150 * t)).astype(np.float32)
    fake = _FakeStreamEngine(tone, sr)
    words = [
        WordSpan("a", 0.2, 1.0),
        WordSpan("b", 1.5, 2.8),
        WordSpan("c", 5.0, 5.5),
    ]
    params = ProsodyParams.from_defaults({})

    result = analyze_prosody_file(Path("x.wav"), words, params, engine=fake)  # type: ignore[arg-type]

    segs = result["segments"]
    assert len(segs) == 1
    assert segs[0]["start"] == pytest.approx(0.2)
    assert segs[0]["end"] == pytest.approx(2.0)


def test_parselmouth_window_sound_keeps_absolute_start_time() -> None:
    """Per-segment windows (#727) rely on ``start_time`` keeping contour times absolute."""
    parselmouth = pytest.importorskip("parselmouth")
    sr = 16000
    t0 = 12.5
    t = np.arange(sr) / sr
    tone = 0.3 * np.sin(2 * np.pi * 150 * t)
    snd = parselmouth.Sound(tone, sampling_frequency=float(sr), start_time=t0)
    assert snd.xmin == pytest.approx(t0)
    assert snd.xmax == pytest.approx(t0 + 1.0)
    pitch = snd.to_pitch_ac(pitch_floor=75.0, pitch_ceiling=500.0)
    assert t0 <= pitch.xs()[0] and pitch.xs()[-1] <= t0 + 1.0
    intensity = snd.to_intensity()
    assert t0 <= intensity.xs()[0] and intensity.xs()[-1] <= t0 + 1.0
