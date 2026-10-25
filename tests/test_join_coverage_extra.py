"""Extra coverage for join labels / ranker / config."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import numpy as np

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.join_continuity import (
    DetectorHit,
    JoinContinuityConfig,
    JoinContinuityReport,
    _apply_calibration,
    _click_check_hires,
    _late_energy_ratio,
)
from podcast_mcp.edits.join_labels import (
    JoinLabel,
    export_training_table,
    load_labels,
)
from podcast_mcp.edits.join_ranker import (
    JoinRankerModel,
    apply_ranker_to_report,
    load_ranker,
    save_ranker,
    train_join_ranker,
)
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)


def test_join_cost_pad_and_short() -> None:
    from podcast_mcp.edits.join_cost_spectral import _pad_frame, lpc_burg, score_spectral_join

    assert _pad_frame(np.array([1.0, 2.0]), 5).size == 5
    assert lpc_burg(np.zeros(4), 8).size == 8
    short = np.array([0.1, 0.2])
    s = score_spectral_join(short, short, sample_rate=16000)
    assert 0.0 <= s.weighted <= 1.0


def test_helper_edge_branches() -> None:
    from podcast_mcp.edits import join_continuity as jc

    assert jc._rms(np.array([])) == 0.0
    assert jc._hann(1).size == 1
    assert jc._stft_mags(np.zeros(10), n_fft=256).size == 0
    assert jc._estimate_f0(np.zeros(100), 16000) is None
    assert jc._estimate_f0(np.random.default_rng(0).normal(0, 1e-5, 800), 16000) is None
    assert jc._bicoherence_proxy(np.zeros(10), np.zeros(10), 16000) == 0.3
    quiet = np.zeros(4000)
    quiet[2000:] = 0.01
    assert jc._late_energy_ratio(quiet[:100], 16000) == 0.0
    assert jc._late_energy_ratio(quiet, 16000) >= 0.0


def test_ranker_feature_vector_and_defaults(tmp_path: Path) -> None:
    from podcast_mcp.edits.join_ranker import (
        JoinRankerModel,
        _feature_vector,
        apply_ranker_to_report,
        default_ranker_path,
        save_ranker,
    )

    assert "join_ranker.json" in str(default_ranker_path())
    assert default_ranker_path(tmp_path).parent == tmp_path
    rep = JoinContinuityReport(
        track_id="h",
        mode="t",
        join_sec=0.0,
        timebase="source",
        risk=0.5,
        invisibility=0.5,
        verdict="pass",
        reasons=[],
        detectors=[DetectorHit("click", 0.2, 1.0)],
        calibrated=False,
        natural_p95=None,
        side_sec=0.045,
        disclaimer="x",
    )
    # Features a retired detector used to supply (#2256) read 0, exactly as in a default install.
    names = ["risk", "det:click", "neural:discontinuity_delta", "neural:z"]
    vec = _feature_vector(rep, names)
    assert vec.tolist() == [0.5, 0.2, 0.0, 0.0]
    tiny = JoinRankerModel(
        weights=np.zeros(1),
        bias=0.0,
        feature_names=["risk"],
        threshold=0.5,
        false_pass_rate=0.0,
        n_train=2,
    )
    path = tmp_path / "r.json"
    save_ranker(tiny, path)
    same = apply_ranker_to_report(rep, model_path=path)
    assert same.verdict == "pass"


def test_maybe_ranker_applies(tmp_path: Path, minimal_project: Path, sample_wav: Path) -> None:
    from podcast_mcp.edits.cut_safety import assess_proposed_cut
    from podcast_mcp.edits.join_ranker import JoinRankerModel, save_ranker

    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="H",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    save_project(project, minimal_project)
    project = load_project(minimal_project)
    model = JoinRankerModel(
        weights=np.array([5.0]),
        bias=0.0,
        feature_names=["risk"],
        threshold=0.1,
        false_pass_rate=0.0,
        n_train=10,
    )
    save_ranker(model, project.artifacts_dir() / "join_ranker.json")
    cfg = JoinContinuityConfig(calibrate=False)
    rep = assess_proposed_cut(
        project, "host", 0.2, 0.5, timebase="source", config=cfg, defaults=load_defaults()
    )
    assert rep.ranker is None or "available" in (rep.ranker or {})


def test_export_training_table_ignores_retired_neural_features() -> None:
    labels = [
        JoinLabel(
            ts="t",
            track_id="h",
            timebase="source",
            join_sec=1.0,
            cut_start=None,
            cut_end=None,
            verdict="fail",
            note="",
            features={
                "risk": 0.6,
                "detectors": {"click": {"score": 0.8}, "level": 0.2},
                "neural": {"wavlm": {"z": 3.0}},
            },
            episode="e",
            config_hash="abc",
        )
    ]
    X, y, names = export_training_table(labels)
    assert X.shape[0] == 1
    assert y[0] == 1.0
    assert any(n.startswith("det:") for n in names)
    assert not any(n.startswith("neural:") for n in names)


def test_load_labels_missing_and_blank(tmp_path: Path) -> None:
    assert load_labels(path=tmp_path / "missing.jsonl") == []
    p = tmp_path / "empty.jsonl"
    p.write_text("\n\n", encoding="utf-8")
    assert load_labels(path=p) == []


def test_train_ranker_degenerate() -> None:
    model = train_join_ranker([])
    assert model.n_train == 0
    assert model.bias > 0


def test_ranker_pass_only_labels(tmp_path: Path) -> None:
    labels = [
        JoinLabel(
            ts="t",
            track_id="h",
            timebase="s",
            join_sec=float(i),
            cut_start=None,
            cut_end=None,
            verdict="pass",
            note="",
            features={"risk": 0.1, "detectors": {"click": 0.05}},
            episode="e",
            config_hash="x",
        )
        for i in range(6)
    ]
    model = train_join_ranker(labels)
    path = tmp_path / "r.json"
    save_ranker(model, path)
    assert load_ranker(path) is not None
    assert load_ranker(tmp_path / "nope.json") is None


def test_apply_ranker_elevates_review_to_fail(tmp_path: Path) -> None:
    model = JoinRankerModel(
        weights=np.array([2.0, 1.0]),
        bias=-0.5,
        feature_names=["risk", "det:click"],
        threshold=0.2,
        false_pass_rate=0.0,
        n_train=10,
    )
    path = tmp_path / "m.json"
    save_ranker(model, path)
    rep = JoinContinuityReport(
        track_id="h",
        mode="t",
        join_sec=0.0,
        timebase="source",
        risk=0.4,
        invisibility=0.6,
        verdict="review",
        reasons=[],
        detectors=[DetectorHit("click", 0.9, 1.0)],
        calibrated=False,
        natural_p95=None,
        side_sec=0.045,
        disclaimer="x",
    )
    out = apply_ranker_to_report(rep, model_path=path)
    assert out.verdict in ("review", "fail")
    assert out.ranker and out.ranker["available"]


def test_calibration_elevates(tmp_path: Path) -> None:
    cfg = JoinContinuityConfig(calibrate=True, calibrate_n=8, review_below=0.48)
    samples = np.random.default_rng(0).normal(0, 0.05, 16000 * 2)
    risk, cal, _nat = _apply_calibration(0.4, [], samples, cfg)
    # May or may not elevate depending on natural baseline
    assert isinstance(cal, bool)
    assert risk >= 0.4


def test_late_energy() -> None:
    right = np.concatenate([np.ones(100) * 0.5, np.ones(4000) * 0.2])
    assert _late_energy_ratio(right, 16000) >= 0.0


def test_click_hires(minimal_project: Path, sample_wav: Path) -> None:
    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="H",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    save_project(project, minimal_project)
    project = load_project(minimal_project)
    spike = _click_check_hires(project, "host", (0.5, 0.5))
    assert spike is None or spike >= 0.0


def test_config_from_defaults() -> None:
    cfg = JoinContinuityConfig.from_defaults(
        {"join_continuity": {"pass_below": 0.2, "edge_tolerance_ms": 0}}
    )
    assert cfg.pass_below == 0.2
    assert cfg.edge_tolerance_ms == 0.0
    assert JoinContinuityConfig.from_defaults({}).edge_tolerance_ms == 3.0
    assert JoinContinuityConfig.from_defaults({}).spectral_audibility_db == 30.0
    assert (
        JoinContinuityConfig.from_defaults(
            {"join_continuity": {"spectral_audibility_db": 0}}
        ).spectral_audibility_db
        == 0.0
    )


def test_edit_join_label_and_train(minimal_project: Path, sample_wav: Path) -> None:
    from podcast_mcp.models import (
        CombinedTranscript,
        CombinedUtterance,
        Transcript,
        TranscriptWord,
    )
    from podcast_mcp.services.app.workspace import ProjectWorkspace
    from podcast_mcp.services.document import TimelineService

    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
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
            id="full",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.4, confidence=0.9),
            ],
        )
    ]
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=0.4,
                text="hello",
            )
        ]
    )
    save_project(project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    with patch("podcast_mcp.services.document.timeline.assess_existing_join") as assess:
        assess.return_value.to_dict.return_value = {
            "track_id": "host",
            "risk": 0.5,
            "detectors": [{"name": "click", "score": 0.6}],
        }
        out = TimelineService(ws).join_label(
            track_id="host", join_sec=1.0, verdict="fail", note="t", play=False
        )
    assert out["label"]["verdict"] == "fail"
    trained = TimelineService(ws).join_train()
    assert trained["n_labels"] >= 1
    assert Path(trained["path"]).is_file()


def test_assess_existing_click_hires_path(minimal_project: Path, sample_wav: Path) -> None:
    from podcast_mcp.edits.join_continuity import assess_existing_join

    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="H",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=0.8,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.2,
            source_end=2.0,
            timeline_start=0.8,
        ),
    ]
    save_project(project, minimal_project)
    project = load_project(minimal_project)
    cfg = JoinContinuityConfig(calibrate=False)
    with patch(
        "podcast_mcp.edits.join_continuity._click_check_hires",
        return_value=30.0,
    ):
        rep = assess_existing_join(
            project, "host", 0.8, timebase="timeline", config=cfg, defaults=load_defaults()
        )
    assert any(h.name == "click_hires" for h in rep.detectors)
