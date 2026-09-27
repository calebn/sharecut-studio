from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.engines.word_boundary_metrics import measure_word_boundaries
from podcast_mcp.util import atomic_json
from podcast_mcp.util.hashing import sha256_file
from script_loader import load_script


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
        assert (
            sha256_file(fixture / gold["audio"]) == gold["audio_sha256"] == report["audio_sha256"]
        )
        total_matches += metrics.matched_words
        total_reference += metrics.reference_words
        total_over += metrics.words_over_150ms
        weighted_mae += metrics.boundary_mae_ms * metrics.matched_words
    assert (total_matches, total_reference, total_over) == (42, 48, 15)
    assert weighted_mae / total_matches == pytest.approx(82.2619, abs=0.0001)
