"""Tests for engines/prosody.py: pure helpers, a synthetic backend check, and a
Praat reference spot check against tests/fixtures/word_boundary."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import prosody as prosody_engine
from podcast_mcp.engines.prosody import (
    ProsodyParams,
    ProsodyUnavailable,
    WordSpan,
    _boundaries,
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


def test_prosody_matches_praat_reference_on_fixture() -> None:
    pytest.importorskip("parselmouth")
    from podcast_mcp.engines.audio_audit import load_mono_full
    from podcast_mcp.engines.prosody import analyze_prosody

    assert parselmouth_version() is not None
    gold = json.loads(GOLD.read_text(encoding="utf-8"))
    words = [WordSpan(w["text"], w["start"], w["end"]) for w in gold["words"]]
    samples = load_mono_full(FIXTURE, sample_rate=16000)
    result = analyze_prosody(samples, 16000, words, ProsodyParams.from_defaults({}))
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
