from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from podcast_mcp.e2e_fixture import BENCHMARK_THRESHOLDS, FIXTURES_DIR

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_real]

_REPO = Path(__file__).resolve().parents[2]
_SCRIPT = _REPO / "scripts" / "benchmark_transcribe_backends.py"


def _run_benchmark(
    fixture: Path,
    out_path: Path,
    *,
    max_duration: float | None = None,
    skip_accuracy: bool = False,
) -> dict:
    cmd = [
        sys.executable,
        str(_SCRIPT),
        "--fixture",
        str(fixture),
        "--output",
        str(out_path),
    ]
    if max_duration is not None:
        cmd.extend(["--max-duration", str(max_duration)])
    if skip_accuracy:
        cmd.append("--skip-accuracy")
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return json.loads(out_path.read_text(encoding="utf-8"))


def test_benchmark_regression_thresholds() -> None:
    if not _SCRIPT.is_file():
        pytest.skip("benchmark script missing")
    if not BENCHMARK_THRESHOLDS.is_file():
        pytest.skip("benchmark thresholds missing")

    thresholds = json.loads(BENCHMARK_THRESHOLDS.read_text(encoding="utf-8"))
    aligned = FIXTURES_DIR / "aligned_dialogue"

    with tempfile.TemporaryDirectory() as tmp:
        report_path = Path(tmp) / "benchmark.json"
        report = _run_benchmark(
            aligned,
            report_path,
            max_duration=60.0,
            skip_accuracy=True,
        )

    summary = report.get("summary", {})
    timing = thresholds.get("aligned_dialogue_timing", {})
    totals = summary.get("total_sec_by_backend", {})
    for backend, ceiling in timing.items():
        if backend in totals:
            assert totals[backend] <= ceiling, f"{backend} took {totals[backend]}s > {ceiling}s"
