from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.engines.word_boundary_metrics import matched_word_pairs, measure_word_boundaries
from podcast_mcp.util import atomic_json
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.wav import pcm_wav_header
from script_loader import load_script

SYNTH = Path(__file__).parent / "fixtures" / "word_boundary_synthetic"
SYNTH_SPANS = ((0.20, 0.50), (0.60, 0.90), (1.00, 1.40), (1.50, 1.80), (1.90, 2.20))


def tone_burst_wav_bytes(
    spans: tuple[tuple[float, float], ...], *, sample_rate: int = 16_000, duration_sec: float = 2.5
) -> bytes:
    samples = np.zeros(round(duration_sec * sample_rate), dtype="<i2")
    for start, end in spans:
        idx = np.arange(round(start * sample_rate), round(end * sample_rate))
        samples[idx] = np.where((idx // 18) % 2 == 0, 8000, -8000)  # ~444 Hz square, integer-exact
    data = samples.tobytes()
    return pcm_wav_header(len(data), sample_rate=sample_rate) + data


def word(text: str, start: float, end: float) -> dict[str, str | float]:
    return {"text": text, "start": start, "end": end}


def test_boundary_errors_and_threshold_are_per_matched_word() -> None:
    reference = [word("Hello,", 0.1, 0.3), word("world!", 0.4, 0.6)]
    prediction = [word("hello", 0.1, 0.45), word("WORLD", 0.6, 0.6 + 0.2)]

    result = measure_word_boundaries(reference, prediction)

    assert result.matched_words == 2
    assert result.boundary_mae_ms == pytest.approx(137.5)
    assert result.mean_start_error_ms == pytest.approx(100)
    assert result.mean_end_error_ms == pytest.approx(175)
    assert result.words_over_150ms == 2
    assert result.words_over_150ms_fraction == 1.0


def test_insertions_and_deletions_are_counted_without_false_timing_pairs() -> None:
    reference = [word("one", 0, 0.2), word("two", 0.2, 0.4), word("three", 0.4, 0.6)]
    prediction = [word("one", 0, 0.2), word("extra", 0.21, 0.25), word("three", 0.4, 0.6)]

    result = measure_word_boundaries(reference, prediction)

    assert result.matched_words == 2
    assert result.missed_reference_words == 1
    assert result.extra_predicted_words == 1
    assert result.boundary_mae_ms == 0


@pytest.mark.parametrize(
    "reference,prediction",
    [
        ([word("one", 0, 0.2)], [word("one", 0.2, 0.2)]),
        ([word("one", 0, 0.2)], [word("!", 0, 0.2)]),
        ([word("one", float("nan"), 0.2)], [word("one", 0, 0.2)]),
    ],
)
def test_invalid_comparison_fails_closed(reference, prediction) -> None:
    with pytest.raises(ValueError):
        measure_word_boundaries(reference, prediction)


def test_repeated_word_deletion_matches_later_timing() -> None:
    reference = [word("the", 0.1, 0.2), word("the", 0.5, 0.6)]
    prediction = [word("the", 0.5, 0.6)]

    result = measure_word_boundaries(reference, prediction)

    assert result.matched_words == 1
    assert result.missed_reference_words == 1
    assert result.boundary_mae_ms == 0


def test_zero_matches_reports_coverage_without_inventing_accuracy() -> None:
    result = measure_word_boundaries([word("cat", 0, 0.2)], [word("dog", 0, 0.2)])

    assert (result.matched_words, result.missed_reference_words, result.extra_predicted_words) == (
        0,
        1,
        1,
    )
    assert result.boundary_mae_ms is None
    assert result.mean_start_error_ms is None
    assert result.mean_end_error_ms is None
    assert result.words_over_150ms_fraction is None


def test_repeated_short_clip_keeps_monotone_matches() -> None:
    reference = [word("the" if i % 2 else "and", i * 0.2, i * 0.2 + 0.1) for i in range(256)]
    prediction = reference[1:]

    result = measure_word_boundaries(reference, prediction)

    assert result.matched_words == 255
    assert result.boundary_mae_ms == 0


def test_long_leading_insertion_preserves_exact_suffix_matches() -> None:
    reference = [word(f"w{i}", i + 80, i + 80.1) for i in range(180)]
    prediction = [word(f"x{i}", i, i + 0.1) for i in range(80)] + reference[:100]

    result = measure_word_boundaries(reference, prediction)

    assert (result.matched_words, result.missed_reference_words, result.extra_predicted_words) == (
        100,
        80,
        80,
    )
    assert result.boundary_mae_ms == 0


def test_long_leading_omission_preserves_exact_suffix_matches() -> None:
    reference = [word(f"w{i}", i, i + 0.1) for i in range(256)]

    result = measure_word_boundaries(reference, reference[120:])

    assert result.matched_words == 136
    assert result.boundary_mae_ms == 0


def test_benchmark_rejects_transcripts_beyond_short_clip_limit() -> None:
    reference = [word(f"w{i}", i, i + 0.1) for i in range(257)]
    with pytest.raises(ValueError, match="at most 256 words"):
        measure_word_boundaries(reference, reference)


def test_benchmark_cli_accepts_same_audio_prediction_and_rejects_wrong_hash(tmp_path) -> None:
    fixture = Path(__file__).parent / "fixtures" / "word_boundary"
    gold = fixture / "1988-147956-0023.gold.json"
    payload = json.loads(gold.read_text(encoding="utf-8"))
    prediction = tmp_path / "prediction.json"
    prediction.write_text(
        json.dumps(
            {
                "audio_sha256": payload["audio_sha256"],
                "provenance": {
                    "model": "reference-copy",
                    "version": "1",
                    "settings": {"sample_rate": 16000},
                    "license": "CC BY 4.0",
                    "runtime_sec": 0.5,
                },
                "words": payload["words"],
            }
        ),
        encoding="utf-8",
    )
    output = tmp_path / "report.json"
    command = [
        sys.executable,
        "scripts/benchmark_word_boundaries.py",
        "--gold",
        str(gold),
        "--prediction",
        str(prediction),
        "--output",
        str(output),
    ]

    passed = subprocess.run(command, capture_output=True, text=True, check=False)
    assert passed.returncode == 0, passed.stderr
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["metrics"]["boundary_mae_ms"] == 0
    assert report["provenance"] == {
        "model": "reference-copy",
        "version": "1",
        "settings": {"sample_rate": 16000},
        "license": "CC BY 4.0",
        "runtime_sec": 0.5,
    }
    assert report["runtime_sec"] == 0.5

    bad_gold = tmp_path / gold.name
    shutil.copyfile(fixture / payload["audio"], tmp_path / payload["audio"])
    payload["audio_sha256"] = "0" * 64
    bad_gold.write_text(json.dumps(payload), encoding="utf-8")
    failed = subprocess.run(
        [*command[:3], str(bad_gold), *command[4:]],
        capture_output=True,
        text=True,
        check=False,
    )
    assert failed.returncode != 0
    assert "SHA-256 does not match" in failed.stderr


def test_benchmark_streams_audio_hash_and_preserves_report_on_publish_failure(tmp_path) -> None:
    fixture = Path(__file__).parent / "fixtures" / "word_boundary"
    gold = fixture / "1988-147956-0023.gold.json"
    stored = json.loads(gold.read_text(encoding="utf-8"))
    prediction = tmp_path / "prediction.json"
    prediction.write_text(
        json.dumps(
            {
                "audio_sha256": stored["audio_sha256"],
                "provenance": {
                    "model": "candidate",
                    "version": "1",
                    "settings": {},
                    "license": "MIT",
                },
                "words": stored["words"],
            }
        ),
        encoding="utf-8",
    )
    benchmark = load_script("benchmark_word_boundaries")
    with patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read")):
        report = benchmark.benchmark(gold, prediction_path=prediction, native_model=None)
    assert report["metrics"]["boundary_mae_ms"] == 0

    output = tmp_path / "report.json"
    output.write_text('{"previous": true}\n', encoding="utf-8")
    with (
        patch.object(atomic_json.os, "replace", side_effect=OSError("disk full")),
        pytest.raises(OSError, match="disk full"),
    ):
        benchmark.main(
            ["--gold", str(gold), "--prediction", str(prediction), "--output", str(output)]
        )
    assert json.loads(output.read_text(encoding="utf-8")) == {"previous": True}
    assert list(tmp_path.glob(".report.json.*.tmp")) == []


@pytest.mark.parametrize(
    "provenance",
    [
        {"model": "candidate"},
        {"model": " ", "version": "1", "settings": {}, "license": "MIT"},
        {"model": "candidate", "version": "1", "settings": [], "license": "MIT"},
        {"model": "candidate", "version": "1", "settings": {}, "license": ""},
    ],
)
def test_benchmark_rejects_incomplete_candidate_provenance(tmp_path, provenance) -> None:
    fixture = Path(__file__).parent / "fixtures" / "word_boundary"
    gold = fixture / "1988-147956-0023.gold.json"
    stored = json.loads(gold.read_text(encoding="utf-8"))
    prediction = tmp_path / "prediction.json"
    prediction.write_text(
        json.dumps(
            {
                "audio_sha256": stored["audio_sha256"],
                "provenance": provenance,
                "words": stored["words"],
            }
        ),
        encoding="utf-8",
    )

    benchmark = load_script("benchmark_word_boundaries")
    with pytest.raises(ValueError, match="provenance needs"):
        benchmark.benchmark(gold, prediction_path=prediction, native_model=None)


def test_fixture_readme_candidate_example_has_required_provenance() -> None:
    readme = Path(__file__).parent / "fixtures" / "word_boundary" / "README.md"
    example = re.search(r"ordered words as `(.+?)`", readme.read_text(encoding="utf-8"), re.S)
    assert example is not None
    payload = json.loads(example.group(1))
    assert all(payload["provenance"].get(field) for field in ("model", "version", "license"))
    assert isinstance(payload["provenance"].get("settings"), dict)


def _rescore_checked_in_reports(suffix: str) -> tuple[int, int, int, float]:
    """Re-score every ``<id>.<suffix>.json`` against its gold; assert stored metrics and
    hashes; return (matched, reference, over_150ms, weighted_mae_ms)."""
    fixture = Path(__file__).parent / "fixtures" / "word_boundary"
    total_matches = total_reference = total_over = 0
    weighted_mae = 0.0
    for gold_path in sorted(fixture.glob("*.gold.json")):
        gold = json.loads(gold_path.read_text(encoding="utf-8"))
        report_path = fixture / gold_path.name.replace(".gold.json", f".{suffix}.json")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        metrics = measure_word_boundaries(gold["words"], report["words"])
        assert metrics.as_dict() == report["metrics"]
        assert (
            sha256_file(fixture / gold["audio"]) == gold["audio_sha256"] == report["audio_sha256"]
        )
        total_matches += metrics.matched_words
        total_reference += metrics.reference_words
        total_over += metrics.words_over_150ms
        weighted_mae += metrics.boundary_mae_ms * metrics.matched_words
    mae = weighted_mae / total_matches if total_matches else None
    return total_matches, total_reference, total_over, mae


def test_checked_in_native_reports_match_reference_fixture() -> None:
    matched, reference, over, mae = _rescore_checked_in_reports("native-base")
    assert (matched, reference, over) == (42, 48, 15)
    assert mae == pytest.approx(82.2619, abs=0.0001)


@pytest.mark.parametrize(
    ("label", "matched", "reference", "over", "mae"),
    [
        ("onnx-base", 42, 48, 2, 42.9762),
        ("onnx-base-int8", 42, 48, 4, 47.2619),
        ("torch-large", 42, 48, 1, 48.6905),
    ],
)
def test_checked_in_candidate_reports_match_reference_fixture(
    label: str, matched: int, reference: int, over: int, mae: float
) -> None:
    got_matched, got_reference, got_over, got_mae = _rescore_checked_in_reports(label)
    assert (got_matched, got_reference, got_over) == (matched, reference, over)
    assert got_mae == pytest.approx(mae, abs=0.0001)

    fixture = Path(__file__).parent / "fixtures" / "word_boundary"
    candidates = json.loads((fixture / "candidates.json").read_text(encoding="utf-8"))
    pinned = next(c for c in candidates["candidates"] if c["label"] == label)
    for report_path in sorted(fixture.glob(f"*.{label}.json")):
        provenance = json.loads(report_path.read_text(encoding="utf-8"))["provenance"]
        assert provenance["model"] == pinned["hf_repo"]
        assert provenance["version"] == pinned["revision"]
        assert provenance["license"] == pinned["license"]
        # onnx-base and onnx-base-int8 share repo + revision; only onnx_file tells them apart.
        assert provenance["settings"]["onnx_file"] == pinned.get("onnx_file")
        assert provenance["settings"]["threads"] == 4  # README/docs: run --threads 4


def test_matched_word_pairs_validates_and_returns_monotone_pairs() -> None:
    reference = [word("one", 0, 0.2), word("two", 0.2, 0.4), word("three", 0.4, 0.6)]
    prediction = [word("one", 0, 0.2), word("three", 0.4, 0.6)]

    pairs = matched_word_pairs(reference, prediction)

    assert [ref["text"] for ref, _ in pairs] == ["one", "three"]

    with pytest.raises(ValueError):
        matched_word_pairs([word("one", 0.2, 0.2)], [word("one", 0, 0.2)])


def test_synthetic_fixture_audio_is_reproducible() -> None:
    gold = json.loads((SYNTH / "tones.gold.json").read_text(encoding="utf-8"))
    prediction = json.loads((SYNTH / "tones.prediction.json").read_text(encoding="utf-8"))

    assert (SYNTH / "tones.wav").read_bytes() == tone_burst_wav_bytes(SYNTH_SPANS)
    assert sha256_file(SYNTH / "tones.wav") == gold["audio_sha256"] == prediction["audio_sha256"]
    assert [(w["start"], w["end"]) for w in gold["words"]] == list(SYNTH_SPANS)


def test_synthetic_fixture_hand_computed_metrics() -> None:
    gold = json.loads((SYNTH / "tones.gold.json").read_text(encoding="utf-8"))
    prediction = json.loads((SYNTH / "tones.prediction.json").read_text(encoding="utf-8"))

    result = measure_word_boundaries(gold["words"], prediction["words"])

    assert result.matched_words == 4
    assert (result.reference_words, result.predicted_words) == (5, 5)
    assert (result.missed_reference_words, result.extra_predicted_words) == (1, 1)
    assert result.boundary_mae_ms == pytest.approx(45.0, abs=1e-9)
    assert result.words_over_150ms == 1
    assert result.words_over_150ms_fraction == pytest.approx(0.25)
    assert result.mean_start_error_ms == pytest.approx(40.0, abs=1e-9)
    assert result.mean_end_error_ms == pytest.approx(-20.0, abs=1e-9)


def test_synthetic_fixture_benchmark_cli_matches_hand_computation() -> None:
    benchmark = load_script("benchmark_word_boundaries")
    metrics = benchmark.benchmark(
        SYNTH / "tones.gold.json",
        prediction_path=SYNTH / "tones.prediction.json",
        native_model=None,
    )["metrics"]

    assert metrics["matched_words"] == 4
    assert metrics["boundary_mae_ms"] == pytest.approx(45.0, abs=1e-9)
    assert metrics["mean_start_error_ms"] == pytest.approx(40.0, abs=1e-9)
    assert metrics["mean_end_error_ms"] == pytest.approx(-20.0, abs=1e-9)
