"""Synthetic tests for Layer-1 join continuity scoring."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.join_continuity import (
    JoinContinuityConfig,
    assess_project_joins,
    assess_proposed_cut,
    score_splice_samples,
)
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)


def _cfg(**kwargs) -> JoinContinuityConfig:
    base = dict(
        calibrate=False,
        neural=False,
        force_review_multi_hot=False,
        side_sec=0.045,
        sample_rate=16000,
    )
    base.update(kwargs)
    return JoinContinuityConfig(**base)


def test_click_splice_fails() -> None:
    sr = 16000
    n = int(0.05 * sr)
    left = np.zeros(n)
    right = np.zeros(n)
    right[0] = 1.0
    risk, hits = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    click = next(h for h in hits if h.name == "click")
    assert click.score > 0.5
    assert risk > 0.28


def test_smooth_tone_passes() -> None:
    sr = 16000
    n = int(0.08 * sr)
    t = np.arange(n) / sr
    tone = 0.2 * np.sin(2 * np.pi * 220 * t)
    risk, hits = score_splice_samples(tone, tone.copy(), sample_rate=sr, config=_cfg())
    assert risk < 0.48
    assert all(h.name != "insufficient_audio" for h in hits)


def test_level_jump_elevates() -> None:
    sr = 16000
    n = int(0.05 * sr)
    left = 0.01 * np.sin(2 * np.pi * 200 * np.arange(n) / sr)
    right = 0.5 * np.sin(2 * np.pi * 200 * np.arange(n) / sr)
    risk, _ = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    quiet = 0.2 * np.sin(2 * np.pi * 200 * np.arange(n) / sr)
    risk_ok, _ = score_splice_samples(quiet, quiet.copy(), sample_rate=sr, config=_cfg())
    assert risk > risk_ok


def test_spectral_jump_elevates() -> None:
    sr = 16000
    n = int(0.06 * sr)
    left = 0.3 * np.sin(2 * np.pi * 180 * np.arange(n) / sr)
    right = np.random.default_rng(0).normal(0, 0.25, n)
    risk, hits = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    flux = next(h for h in hits if h.name == "spectral_flux")
    assert flux.score > 0.2
    assert risk > 0.2


def test_hot_onset_scores() -> None:
    sr = 16000
    n = int(0.05 * sr)
    left = 0.05 * np.sin(2 * np.pi * 200 * np.arange(n) / sr)
    right = np.zeros(n)
    right[: n // 4] = 0.8
    _, hits = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    onset = next(h for h in hits if h.name == "onset_collision")
    assert onset.score > 0.3


def test_short_audio_fail_closed() -> None:
    risk, hits = score_splice_samples(np.zeros(4), np.zeros(4), sample_rate=16000, config=_cfg())
    assert risk == 1.0
    assert hits[0].name == "insufficient_audio"


def test_verdict_thresholds() -> None:
    from podcast_mcp.edits.join_continuity import _finalize

    cfg = _cfg(pass_below=0.28, review_below=0.48)
    samples = np.random.default_rng(0).normal(0, 0.1, 16000)
    for risk, expected in ((0.1, "pass"), (0.35, "review"), (0.7, "fail")):
        rep = _finalize(
            track_id="t",
            mode="test",
            join_sec=1.0,
            timebase="source",
            risk=risk,
            hits=[],
            samples=samples,
            cfg=cfg,
        )
        assert rep.verdict == expected
        assert "disclaimer" in rep.to_dict()
        assert rep.disclaimer


def test_short_audio_skips_calibration() -> None:
    from podcast_mcp.edits.join_continuity import _apply_calibration

    cfg = _cfg(calibrate=True)
    risk, cal, nat = _apply_calibration(0.4, [], np.zeros(100), cfg)
    assert cal is False
    assert nat is None
    assert risk == 0.4


def test_multi_hot_forces_review() -> None:
    from podcast_mcp.edits.join_continuity import DetectorHit, _verdict

    cfg = _cfg(force_review_multi_hot=True, pass_below=0.28, review_below=0.48)
    hits = [
        DetectorHit("a", 0.7, 1.0),
        DetectorHit("b", 0.7, 1.0),
    ]
    verdict, reasons, adj = _verdict(0.1, cfg, hits)
    assert verdict == "review"
    assert any("multi_hot" in r for r in reasons)
    assert adj >= cfg.pass_below


def test_forensic_detectors_present() -> None:
    sr = 16000
    n = int(0.1 * sr)
    left = 0.2 * np.sin(2 * np.pi * 250 * np.arange(n) / sr)
    right = np.random.default_rng(4).normal(0, 0.2, n)
    _, hits = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    names = {h.name for h in hits}
    assert "bicoherence_proxy" in names
    assert "late_energy_ratio" in names
    assert "lsf_mahalanobis" in names
    assert "mca_join_cost" in names
    assert "weighted_spectral_join" in names


def test_weighted_fusion_in_hits() -> None:
    sr = 16000
    n = int(0.06 * sr)
    left = np.sin(2 * np.pi * 200 * np.arange(n) / sr)
    right = np.random.default_rng(5).normal(0, 0.3, n)
    risk, hits = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    w = next(h for h in hits if h.name == "weighted_spectral_join")
    assert 0.0 <= w.score <= 1.0
    assert 0.0 <= risk <= 1.0


def _tiny_project(minimal_project: Path, sample_wav: Path):
    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=0.5,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=1.0,
            source_end=1.5,
            timeline_start=0.5,
        ),
    ]
    save_project(project, minimal_project)
    return load_project(minimal_project)


def test_assess_proposed_cut_and_project_joins(minimal_project: Path, sample_wav: Path) -> None:
    project = _tiny_project(minimal_project, sample_wav)
    cfg = _cfg(calibrate=False, neural=False)
    rep = assess_proposed_cut(project, "host", 0.2, 0.4, timebase="source", config=cfg)
    assert rep.mode == "proposed_cut"
    assert rep.verdict in ("pass", "review", "fail")
    assert "cut " in " ".join(rep.reasons)

    sweep = assess_project_joins(project, track_id="host", config=cfg)
    assert sweep["join_count"] == 1
    assert sweep["worst"] is not None
    assert "disclaimer" in sweep


def test_assess_proposed_cut_rejects_inverted(minimal_project: Path) -> None:
    project = load_project(minimal_project)
    with pytest.raises(ValueError, match="cut_end"):
        assess_proposed_cut(project, "host", 1.0, 0.5, config=_cfg())
