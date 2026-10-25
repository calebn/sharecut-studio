"""Default-install join verdicts, pinned across the neural-layer removal (#2256).

The WavLM / NISQA-named layer only ran with ``torch`` + ``librosa`` installed, so a default
install scored with the numpy detector fusion alone. The golden values below were captured on
``main`` at 85e295e (neural layer present, torch absent; the file is unchanged on both sides) and must still hold with the layer
gone. An old ``join_ranker.json`` that names dropped ``neural:*`` features keeps loading: those
features read 0, exactly as they did when the layer was unavailable.
"""

from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.join_continuity import (
    JoinContinuityConfig,
    JoinContinuityReport,
    assess_existing_join,
)
from podcast_mcp.edits.join_ranker import load_ranker, predict_fail_proba
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)

SR = 16000

# The detector hits every case produced on main, in order (no neural hit, since torch was absent).
DETECTORS = [
    "click",
    "level_jump",
    "spectral_flux",
    "mfcc_join_cost",
    "lsf_mahalanobis",
    "mca_join_cost",
    "weighted_spectral_join",
    "noise_floor",
    "f0_jump",
    "onset_collision",
    "bicoherence_proxy",
    "late_energy_ratio",
]

# case -> {join_sec: (verdict, risk)}
GOLDEN: dict[str, dict[float, tuple[str, float]]] = {
    "clean": {1.5: ("fail", 0.5311), 3.0: ("fail", 0.5364)},
    "click": {1.5: ("fail", 0.5681), 3.0: ("fail", 0.5364)},
    "level_drop": {1.5: ("fail", 0.5311), 3.0: ("review", 0.4546)},
    "pitch_level_jump": {1.5: ("fail", 0.5342), 3.0: ("review", 0.4373)},
}


def _speechlike(n: int, f0: float = 120.0, amp: float = 0.3, seed: int = 0) -> np.ndarray:
    t = np.arange(n) / SR
    voice = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 12))
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 3.1 * t)
    noise = 0.003 * np.random.default_rng(seed).standard_normal(n)
    return (amp * env * voice / 3 + noise).astype(np.float32)


def _cases() -> dict[str, np.ndarray]:
    base = _speechlike(SR * 6, seed=1)
    click = base.copy()
    click[SR * 2 : SR * 2 + 3] = 0.9
    drop = base.copy()
    drop[SR * 3 :] *= 0.05
    pitch = np.concatenate(
        [_speechlike(SR * 3, 120, seed=2), _speechlike(SR * 3, 210, 0.5, seed=3)]
    )
    return {"clean": base, "click": click, "level_drop": drop, "pitch_level_jump": pitch}


def _project(tmp_path: Path, audio: np.ndarray) -> EpisodeProject:
    (tmp_path / "raw").mkdir()
    with wave.open(str(tmp_path / "raw" / "host.wav"), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("pin", str(tmp_path))
    project.ensure_dirs()
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=len(audio) / SR),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=1.5, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=2.0, source_end=3.5, timeline_start=1.5),
        Clip(id="c3", track_id="host", source_start=4.2, source_end=5.6, timeline_start=3.0),
    ]
    path = save_project(project)
    return load_project(path)


def _observe(tmp_path: Path, audio: np.ndarray) -> dict[float, tuple[str, float, list[str]]]:
    project = _project(tmp_path, audio)
    out = {}
    for join in (1.5, 3.0):
        rep = assess_existing_join(project, "host", join, defaults=load_defaults())
        out[join] = (rep.verdict, round(rep.risk, 4), [h.name for h in rep.detectors])
    return out


@pytest.mark.parametrize("case", sorted(_cases()))
def test_default_verdicts_match_the_pre_removal_golden(case: str, tmp_path: Path) -> None:
    observed = _observe(tmp_path, _cases()[case])
    for join, (verdict, risk) in GOLDEN[case].items():
        got_verdict, got_risk, got_names = observed[join]
        assert got_verdict == verdict
        assert got_risk == pytest.approx(risk, abs=2e-3)
        assert got_names == DETECTORS


def test_config_and_report_carry_no_neural_surface() -> None:
    cfg = JoinContinuityConfig.from_defaults(load_defaults())
    assert not any("neural" in f or "nisqa" in f or "wavlm" in f for f in vars(cfg))
    assert "neural" not in JoinContinuityReport.__dataclass_fields__
    for key in load_defaults()["join_continuity"]:
        assert not any(w in key for w in ("neural", "nisqa", "wavlm"))


def test_old_ranker_naming_dropped_features_still_loads_and_reads_them_as_zero(
    tmp_path: Path,
) -> None:
    names = ["risk", "det:click", "neural:z", "neural:discontinuity_delta", "neural:mos_delta"]
    weights = [2.0, 1.5, 3.0, 2.5, 1.0]
    path = tmp_path / "join_ranker.json"
    path.write_text(
        json.dumps(
            {
                "weights": weights,
                "bias": -1.0,
                "feature_names": names,
                "threshold": 0.35,
                "false_pass_rate": 0.04,
                "n_train": 60,
            }
        )
    )
    model = load_ranker(path)
    assert model is not None
    rep = JoinContinuityReport(
        track_id="h",
        mode="existing_join",
        join_sec=1.0,
        timebase="source",
        risk=0.4,
        invisibility=0.6,
        verdict="review",
        reasons=[],
        detectors=[],
        calibrated=False,
        natural_p95=None,
        side_sec=0.045,
        disclaimer="x",
    )
    live_only = 2.0 * 0.4 - 1.0  # dropped features contribute nothing
    assert predict_fail_proba(model, rep) == pytest.approx(1 / (1 + np.exp(-live_only)))
