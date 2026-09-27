"""Measure native Whisper or supplied word timestamps against a real-audio reference.

Run with ``uv run python scripts/benchmark_word_boundaries.py --help``.
"""

from __future__ import annotations

import argparse
import json
import time
from importlib.metadata import version
from math import isfinite
from pathlib import Path
from typing import Any

from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.engines.word_boundary_metrics import measure_word_boundaries
from podcast_mcp.util.atomic_json import write_json_atomic
from podcast_mcp.util.hashing import sha256_file


def _read_words(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("words"), list):
        raise ValueError(f"{path} must contain a words array")
    return payload, payload["words"]


def benchmark(
    gold_path: Path, *, prediction_path: Path | None, native_model: str | None
) -> dict[str, Any]:
    if (prediction_path is None) == (native_model is None):
        raise ValueError("choose exactly one of prediction_path or native_model")
    gold, reference = _read_words(gold_path)
    audio_name = gold.get("audio")
    expected_sha = gold.get("audio_sha256")
    if not isinstance(audio_name, str) or Path(audio_name).name != audio_name:
        raise ValueError("gold audio must be a filename beside the gold file")
    if not isinstance(expected_sha, str) or len(expected_sha) != 64:
        raise ValueError("gold audio_sha256 must be a SHA-256 hex digest")
    audio_path = gold_path.parent / audio_name
    observed_sha = sha256_file(audio_path)
    if observed_sha != expected_sha:
        raise ValueError("audio SHA-256 does not match gold fixture")

    if prediction_path is not None:
        supplied, prediction = _read_words(prediction_path)
        if supplied.get("audio_sha256") != observed_sha:
            raise ValueError("prediction audio_sha256 does not match gold fixture")
        provenance = supplied.get("provenance")
        if not isinstance(provenance, dict):
            raise ValueError("prediction needs provenance metadata")
        for field in ("model", "version", "license"):
            value = provenance.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"prediction provenance needs nonempty {field}")
        if not isinstance(provenance.get("settings"), dict):
            raise ValueError("prediction provenance needs settings object")
        runtime_sec = provenance.get("runtime_sec")
        if runtime_sec is not None and (
            isinstance(runtime_sec, bool)
            or not isinstance(runtime_sec, (int, float))
            or not isfinite(runtime_sec)
            or runtime_sec < 0
        ):
            raise ValueError("provenance runtime_sec must be nonnegative and finite")
        source = str(prediction_path)
    else:
        assert native_model is not None
        start = time.perf_counter()
        transcript = TranscriptionEngine(model_size=native_model).transcribe_file(audio_path)
        runtime_sec = time.perf_counter() - start
        prediction = [
            {"text": word.text, "start": word.start, "end": word.end} for word in transcript.words
        ]
        source = f"faster-whisper:{native_model}"
        provenance = {
            "model": native_model,
            "library": "faster-whisper",
            "library_version": version("faster-whisper"),
            "device": "cpu",
            "compute_type": "int8",
            "runtime_sec": runtime_sec,
        }
    metrics = measure_word_boundaries(reference, prediction)
    return {
        "fixture_id": gold.get("id"),
        "audio_sha256": observed_sha,
        "reference": gold.get("reference"),
        "prediction_source": source,
        "provenance": provenance,
        "runtime_sec": runtime_sec,
        "metrics": metrics.as_dict(),
        "words": prediction,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gold", type=Path, required=True)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--prediction", type=Path)
    choice.add_argument("--native-model")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    report = benchmark(args.gold, prediction_path=args.prediction, native_model=args.native_model)
    write_json_atomic(args.output, report)
    print(json.dumps(report["metrics"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
