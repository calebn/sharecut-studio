from __future__ import annotations

import json
from pathlib import Path

import pytest

import podcast_mcp.edits.audition_eval as evaluation
from podcast_mcp.edits.audition_eval import (
    DEFAULT_CASES,
    build_defect_project,
    precision_recall,
    score_labeled_windows,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import EpisodeProject

ROOT = Path(__file__).resolve().parents[1]
THRESHOLDS = ROOT / "tests/fixtures/audition_context_eval_thresholds.json"


def test_precision_recall_edge_cases() -> None:
    assert precision_recall(set(), set()) == (1.0, 1.0)
    assert precision_recall({"a"}, {"a"}) == (1.0, 1.0)
    p, r = precision_recall({"a", "b"}, {"a"})
    assert p == 0.5
    assert r == 1.0


def test_score_labeled_windows_rejects_unknown_code(tmp_path: Path) -> None:
    project = EpisodeProject.create("eval", str(tmp_path))
    with pytest.raises(ValueError, match="unknown hypothesis"):
        score_labeled_windows(
            project, [{"code": "not_a_code", "start": 0.0, "end": 1.0, "expect": True}]
        )


def test_score_labeled_windows_caches_context_per_float_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = EpisodeProject.create("eval", str(tmp_path))
    calls: list[tuple[float, float]] = []

    def context(_project: EpisodeProject, start: float, end: float, **_: object):
        calls.append((start, end))
        return {"hypotheses": []}

    monkeypatch.setattr(evaluation, "build_audition_context", context)
    evaluation.score_labeled_windows(
        project,
        [
            {"code": "hum_in_window", "start": 1, "end": 2, "expect": False},
            {"code": "clipping_in_window", "start": 1.0, "end": 2.0, "expect": False},
        ],
    )
    assert calls == [(1.0, 2.0)]


def test_defect_injection_hypothesis_gates(tmp_path: Path) -> None:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    project = build_defect_project(tmp_path / "ws")
    thresholds = json.loads(THRESHOLDS.read_text(encoding="utf-8"))
    report = score_labeled_windows(project, DEFAULT_CASES, detail="summary")
    for code, stats in report["per_code"].items():
        gate = thresholds[code]
        assert stats["precision"] >= gate["min_precision"], (
            code,
            stats,
            report["rows"],
        )
        assert stats["recall"] >= gate["min_recall"], (code, stats, report["rows"])


def test_inject_hum_span_adds_hum_at_unity(tmp_path: Path) -> None:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    tone, out = tmp_path / "tone.wav", tmp_path / "hum.wav"
    evaluation.generate_tone(tone, duration_sec=6.0, freq_hz=220.0)
    evaluation.inject_hum_span(tone, out, start_sec=2.0, end_sec=4.0, freq_hz=60.0, mix_db=0.0)
    src_span, out_span = tmp_path / "src_span.wav", tmp_path / "out_span.wav"
    eng.extract_segment(tone, src_span, 2.2, 3.8)
    eng.extract_segment(out, out_span, 2.2, 3.8)
    src_lufs, out_lufs = eng.measure_loudness(src_span), eng.measure_loudness(out_span)
    assert src_lufs is not None and out_lufs is not None
    # Unity sum: the tone keeps its level and the hum adds power (1/N dipped it ~6 dB).
    assert out_lufs > src_lufs
    full = eng.measure_loudness_full(out)
    assert full is not None and full["true_peak_db"] is not None
    assert full["true_peak_db"] < 0.0


def test_score_labeled_windows_skips_prosody(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = EpisodeProject.create("eval", str(tmp_path))
    seen: list[dict[str, object]] = []

    def context(_project: EpisodeProject, start: float, end: float, **kwargs: object):
        seen.append(kwargs)
        return {"hypotheses": []}

    monkeypatch.setattr(evaluation, "build_audition_context", context)
    evaluation.score_labeled_windows(
        project, [{"code": "hum_in_window", "start": 1, "end": 2, "expect": False}]
    )
    assert seen and seen[0]["include_prosody"] is False
