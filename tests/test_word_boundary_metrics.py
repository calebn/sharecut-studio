from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from podcast_mcp.engines.word_boundary_metrics import measure_word_boundaries


def word(text: str, start: float, end: float) -> dict[str, str | float]:
    return {"text": text, "start": start, "end": end}


def test_boundary_errors_and_threshold_are_per_matched_word() -> None:
    reference = [word("Hello,", 0.1, 0.3), word("world!", 0.4, 0.6)]
    prediction = [word("hello", 0.1, 0.45), word("WORLD", 0.6, 0.6 + 0.2)]

    result = measure_word_boundaries(reference, prediction)

    assert result.matched_words == 2
    assert result.boundary_mae_ms == pytest.approx(137.5)
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
        ([word("one", 0, 0.2)], [word("two", 0, 0.2)]),
        ([word("one", 0, 0.2)], [word("one", 0.2, 0.2)]),
        ([word("one", 0, 0.2)], [word("!", 0, 0.2)]),
    ],
)
def test_invalid_comparison_fails_closed(reference, prediction) -> None:
    with pytest.raises(ValueError):
        measure_word_boundaries(reference, prediction)


def test_benchmark_cli_accepts_same_audio_prediction_and_rejects_wrong_hash(tmp_path) -> None:
    fixture = Path(__file__).parent / "fixtures" / "word_boundary"
    gold = fixture / "1988-147956-0023.gold.json"
    payload = json.loads(gold.read_text(encoding="utf-8"))
    prediction = tmp_path / "prediction.json"
    prediction.write_text(
        json.dumps({"audio_sha256": payload["audio_sha256"], "words": payload["words"]}),
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
    assert json.loads(output.read_text(encoding="utf-8"))["metrics"]["boundary_mae_ms"] == 0

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


def test_checked_in_native_reports_match_reference_fixture() -> None:
    fixture = Path(__file__).parent / "fixtures" / "word_boundary"
    total_matches = total_reference = total_over = 0
    weighted_mae = 0.0
    for gold_path in sorted(fixture.glob("*.gold.json")):
        gold = json.loads(gold_path.read_text(encoding="utf-8"))
        report_path = fixture / gold_path.name.replace(".gold.json", ".native-base.json")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        metrics = measure_word_boundaries(gold["words"], report["words"])
        assert metrics.as_dict() == report["metrics"]
        assert gold["audio_sha256"] == report["audio_sha256"]
        total_matches += metrics.matched_words
        total_reference += metrics.reference_words
        total_over += metrics.words_over_150ms
        weighted_mae += metrics.boundary_mae_ms * metrics.matched_words
    assert (total_matches, total_reference, total_over) == (42, 48, 15)
    assert weighted_mae / total_matches == pytest.approx(82.2619, abs=0.0001)
