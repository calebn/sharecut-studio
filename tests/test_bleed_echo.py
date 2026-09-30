"""Tier A fixtures for the same-room bleed echo profile (#775)."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import bleed_echo
from podcast_mcp.engines.bleed_echo import EchoConfig, echo_pair_profile, echo_profiles
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)

RATE = 8000


def _speech_like(seconds: float, *, seed: int, gaps: bool = True) -> np.ndarray:
    """Wideband noise with syllable-rate amplitude bursts and pauses.

    Each seed gets its own burst and pause phase, so two speakers never share an
    envelope; only a delayed copy shares the waveform.
    """
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    noise = rng.normal(0, 1.0, n)
    noise = np.convolve(noise, np.ones(2) / 2.0, mode="same")
    t = np.arange(n) / RATE
    burst_phase, gap_phase = rng.uniform(0.0, 2 * np.pi, 2)
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 4.0 * t + burst_phase)
    if gaps:
        envelope *= (np.sin(2 * np.pi * 0.5 * t + gap_phase) > -0.3).astype(np.float64)
    out = noise * envelope
    return (0.2 * out / (np.max(np.abs(out)) or 1.0)).astype(np.float32)


def _delayed_copy(source: np.ndarray, *, delay_samples: int, gain_db: float) -> np.ndarray:
    gain = 10 ** (gain_db / 20.0)
    out = np.zeros_like(source)
    out[delay_samples:] = source[: source.size - delay_samples] * gain
    return out


def test_delayed_attenuated_copy_is_an_echo_risk_with_its_lag_and_level() -> None:
    source = _speech_like(20.0, seed=1)
    bleed = _delayed_copy(source, delay_samples=64, gain_db=-14.0)  # 8.0 ms at 8 kHz
    bleed += _speech_like(20.0, seed=9, gaps=False) * 0.002
    cfg = EchoConfig()
    profile = echo_pair_profile(
        source,
        bleed,
        sample_rate=RATE,
        t0=100.0,
        source_track_id="a",
        bleed_track_id="b",
        config=cfg,
    )
    assert profile.echo_risk(cfg) is True
    assert profile.lag_ms == pytest.approx(8.0, abs=0.25)
    assert profile.level_db == pytest.approx(-14.0, abs=1.0)
    assert profile.consistent_frames >= 0.9 * profile.copy_frames
    assert profile.copy_frames >= 100
    assert all(100.0 <= t <= 120.0 for t in profile.examples)
    assert len(profile.examples) == 3
    # The null (the same pair shifted by seconds) sees chance clusters only.
    assert profile.null_runs == 8
    assert profile.null_consistent_rate is not None
    assert profile.consistent_rate >= 4 * profile.null_consistent_rate
    assert profile.null_ratio is not None and profile.null_ratio >= 4.0
    assert profile.p_value is not None and profile.p_value < 1e-9
    d = profile.to_dict(cfg)
    assert d["source_track_id"] == "a"
    assert d["bleed_track_id"] == "b"
    assert d["span_start"] == 100.0
    assert d["thresholds"] == {
        "copy_ncc": 0.25,
        "min_copy_frames": 20,
        "min_consistent_frames": 12,
        "lag_tolerance_ms": 1.5,
        "null_p_max": 0.001,
        "null_margin": 1.5,
    }
    assert set(d) >= {
        "copy_rate",
        "consistent_rate",
        "null_copy_rate",
        "null_consistent_rate",
        "null_ratio",
        "p_value",
    }


def _wandering_voice(seed: int, f0: float, level: float) -> np.ndarray:
    """A harmonic voice whose pitch drifts slowly and independently per seed."""
    rng = np.random.default_rng(seed)
    n = 20 * RATE
    f0_track = f0 * (1 + 0.08 * np.cumsum(rng.normal(0, 0.002, n)))
    phase = 2 * np.pi * np.cumsum(f0_track) / RATE
    tone = sum(np.sin(k * phase) / k for k in range(1, 12))
    return (level * tone / np.max(np.abs(tone))).astype(np.float32)


def test_same_pitch_independent_voices_beat_no_null() -> None:
    """Two harmonic voices at the same pitch correlate at any time shift, so the null
    rate rises with them and the pair is not an echo."""
    a = _wandering_voice(1, 118.0, 0.2)
    b = _wandering_voice(5, 118.0, 0.05)
    cfg = EchoConfig()
    profile = echo_pair_profile(
        a, b, sample_rate=RATE, t0=0.0, source_track_id="a", bleed_track_id="b", config=cfg
    )
    assert profile.copy_frames >= cfg.min_copy_frames
    assert profile.null_consistent_rate is not None
    assert profile.p_value is not None and profile.p_value > cfg.null_p_max
    assert profile.echo_risk(cfg) is False


def test_binomial_tail_matches_known_values() -> None:
    from podcast_mcp.engines.bleed_echo import binomial_tail

    assert binomial_tail(0, 10, 0.3) == 1.0
    assert binomial_tail(11, 10, 0.3) == 0.0
    assert binomial_tail(10, 10, 0.5) == pytest.approx(0.5**10)
    # P(X >= 12 | n=307, p=0.0215): the remote pair's best span stays chance-level.
    assert binomial_tail(12, 307, 0.0215) == pytest.approx(0.035, abs=0.005)
    # P(X >= 37 | n=621, p=0.0247): the same-room pair over 0-600 s.
    assert binomial_tail(37, 621, 0.0247) == pytest.approx(1.3e-6, rel=0.1)


def test_unrelated_quiet_speech_is_not_an_echo_risk() -> None:
    source = _speech_like(20.0, seed=1)
    other = _speech_like(20.0, seed=2) * 0.2
    cfg = EchoConfig()
    profile = echo_pair_profile(
        source, other, sample_rate=RATE, t0=0.0, source_track_id="a", bleed_track_id="b", config=cfg
    )
    assert profile.echo_risk(cfg) is False
    assert profile.consistent_frames < cfg.min_consistent_frames


def test_gated_silence_never_dominates() -> None:
    source = _speech_like(5.0, seed=1)
    silent = np.zeros_like(source)
    profile = echo_pair_profile(
        source, silent, sample_rate=RATE, t0=0.0, source_track_id="a", bleed_track_id="b"
    )
    assert profile.dominated_frames == 0
    assert profile.copy_frames == 0
    assert profile.lag_ms is None
    assert profile.examples == ()


def _write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(pcm.tobytes())


def _stem_project(tmp_path: Path, stems: dict[str, np.ndarray]) -> EpisodeProject:
    project = EpisodeProject.create("echo", str(tmp_path))
    project.ensure_dirs()
    for tid, samples in stems.items():
        duration = samples.size / RATE
        _write_wav(tmp_path / "raw" / f"{tid}.wav", samples)
        _write_wav(project.artifacts_dir() / "tracks" / f"{tid}.wav", samples)
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=duration),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=duration,
                timeline_start=0.0,
            )
        )
    return project


def test_echo_profiles_measure_fresh_stems_and_skip_stale_ones(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    host = _speech_like(20.0, seed=3)
    guest = _delayed_copy(host, delay_samples=24, gain_db=-18.0) + _speech_like(20.0, seed=4) * 0.05
    remote = _speech_like(20.0, seed=5)
    project = _stem_project(tmp_path, {"host": host, "guest": guest, "remote": remote})
    monkeypatch.setattr(bleed_echo, "stem_is_fresh", lambda _p, tid: tid != "remote")
    bleed_echo._cached_profiles.cache_clear()

    profiles, skipped = echo_profiles(project, start_sec=3.0, end_sec=6.0)
    assert skipped == ["remote"]
    by_pair = {(p.source_track_id, p.bleed_track_id): p for p in profiles}
    assert set(by_pair) == {("host", "guest"), ("guest", "host")}
    cfg = EchoConfig()
    assert by_pair[("host", "guest")].echo_risk(cfg) is True
    assert by_pair[("host", "guest")].lag_ms == pytest.approx(3.0, abs=0.25)
    assert by_pair[("host", "guest")].level_db == pytest.approx(-18.0, abs=1.5)
    assert by_pair[("host", "guest")].span_start == 0.0
    assert by_pair[("host", "guest")].span_end == pytest.approx(20.0, abs=0.01)
    assert by_pair[("guest", "host")].echo_risk(cfg) is False


def test_echo_profiles_need_two_fresh_stems(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _stem_project(
        tmp_path, {"host": _speech_like(5.0, seed=3), "guest": _speech_like(5.0, seed=4)}
    )
    monkeypatch.setattr(bleed_echo, "stem_is_fresh", lambda _p, tid: tid == "host")
    assert echo_profiles(project, start_sec=0.0, end_sec=1.0) == ([], ["guest"])


def test_audition_context_reports_echo_risk_with_a_listen_at_the_strongest_example(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits.audition_context import build_audition_context

    host = _speech_like(20.0, seed=3)
    guest = _delayed_copy(host, delay_samples=24, gain_db=-18.0) + _speech_like(20.0, seed=4) * 0.05
    project = _stem_project(tmp_path, {"host": host, "guest": guest})
    monkeypatch.setattr(bleed_echo, "stem_is_fresh", lambda _p, _tid: True)
    monkeypatch.setattr(
        "podcast_mcp.edits.audio_quality.audio_diagnostics_report",
        lambda *_a, **_k: {"astats": {}, "hum": {}},
    )
    bleed_echo._cached_profiles.cache_clear()

    ctx = build_audition_context(project, 3.0, 6.0, include_prosody=False)
    (hyp,) = [h for h in ctx["hypotheses"] if h["code"] == "echo_risk"]
    assert hyp["tracks"] == ["host", "guest"]
    assert hyp["severity"] == "warn"
    assert hyp["evidence"]["lag_ms"] == pytest.approx(3.0, abs=0.25)
    assert hyp["evidence"]["level_db"] == pytest.approx(-18.0, abs=1.5)
    assert hyp["next"]["fix"] == {"skill": "podcast-mute-bleed", "autonomy": "needs_approval"}
    assert hyp["next"]["tools"] == ["play_compose_tool", "apply_transcript_gate_tool"]
    warning = next(w for w in ctx["warnings"] if w.startswith("echo_risk:"))
    assert "guest carries host's voice" in warning
    assert "podcast-mute-bleed" in warning
    listen = next(
        s for s in ctx["suggested_listen"] if s.get("why", "").startswith("Hear host doubled")
    )
    assert listen["track_ids"] == ["host", "guest"]
    assert listen["tier"] == "processed"
    assert listen["end"] - listen["start"] == pytest.approx(3.0)
    assert hyp["next"]["listen"] == listen["id"]
    assert "echo_check_needs_fresh_stems" not in ctx["limits"]


def test_audition_context_marks_the_echo_check_skipped_on_stale_stems(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits.audition_context import build_audition_context

    project = _stem_project(
        tmp_path, {"host": _speech_like(5.0, seed=3), "guest": _speech_like(5.0, seed=4)}
    )
    monkeypatch.setattr(bleed_echo, "stem_is_fresh", lambda _p, _tid: False)
    monkeypatch.setattr(
        "podcast_mcp.edits.audio_quality.audio_diagnostics_report",
        lambda *_a, **_k: {"astats": {}, "hum": {}},
    )
    ctx = build_audition_context(project, 0.0, 2.0, include_prosody=False)
    assert "echo_check_needs_fresh_stems" in ctx["limits"]
    assert not [h for h in ctx["hypotheses"] if h["code"] == "echo_risk"]


def test_echo_risk_pairs_flags_only_the_measured_direction() -> None:
    """Reconcile's whole-track measurement: the mic that carries a delayed copy is the
    bleed side of one directed pair, and independent voices produce no pair (#774)."""
    from podcast_mcp.engines.bleed_echo import echo_risk_pairs

    host = _speech_like(20.0, seed=3)
    guest = _delayed_copy(host, delay_samples=24, gain_db=-18.0) + _speech_like(20.0, seed=4) * 0.05
    remote = _speech_like(20.0, seed=5)
    flagged = echo_risk_pairs({"host": host, "guest": guest, "remote": remote}, sample_rate=RATE)
    assert [(p.source_track_id, p.bleed_track_id) for p in flagged] == [("host", "guest")]
    assert flagged[0].lag_ms == pytest.approx(3.0, abs=0.25)
    assert flagged[0].span_start == 0.0
    assert flagged[0].span_end == pytest.approx(20.0, abs=0.01)
    assert echo_risk_pairs({"host": host, "remote": remote}, sample_rate=RATE) == []


def test_audition_context_exposes_long_delay_without_claiming_owner_absence(tmp_path, monkeypatch):
    from podcast_mcp.edits.audition_context import build_audition_context

    host = _speech_like(20.0, seed=23)
    guest = (
        _delayed_copy(host, delay_samples=1200, gain_db=-14) + _speech_like(20.0, seed=27) * 0.03
    )
    project = _stem_project(tmp_path, {"host": host, "guest": guest})
    monkeypatch.setattr(bleed_echo, "stem_is_fresh", lambda _p, _tid: True)
    monkeypatch.setattr(
        "podcast_mcp.edits.audio_quality.audio_diagnostics_report",
        lambda *_a, **_k: {"astats": {}, "hum": {}},
    )
    bleed_echo._cached_profiles.cache_clear()
    context = build_audition_context(project, 1, 5, include_prosody=False)
    hypothesis = next(
        h
        for h in context["hypotheses"]
        if h["code"] == "retained_bleed_misalignment" and h["tracks"] == ["host", "guest"]
    )
    assert hypothesis["evidence"]["long_delay_summary"]["owner_absence_proven"] is False
    assert hypothesis["evidence"]["long_delay_summary"]["lag_ms"] == pytest.approx(150, abs=1)
    assert hypothesis["next"]["fix"]["skill"] == "podcast-mute-bleed"
    assert "align_retained_bleed_tool" in hypothesis["next"]["tools"]
