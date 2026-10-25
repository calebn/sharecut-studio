"""The accelerator benchmark harness (#2254): comparison maths, verdict words, and a real child run."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.util.hardware import (
    COREML_PROVIDER,
    CPU_PROVIDER,
    cpu_only_profile,
    use_hardware_profile,
)
from script_loader import load_script

bench = load_script("benchmark_accelerators", register=True)


def _result(tmp_path: Path, device: str, ms: float, rss: float | None, out: list[float]):
    path = tmp_path / f"{device}.npy"
    np.save(path, np.asarray(out, dtype=np.float64))
    return bench.RunResult(
        device=device,
        providers=(device,),
        load_sec=0.5,
        wall_ms=[ms, ms, ms],
        peak_rss_mb=rss,
        output_file=str(path),
    )


@pytest.mark.parametrize(
    ("ratio", "rss", "delta", "words"),
    [
        (None, None, None, "baseline"),
        (0.5, 1.0, 1e-6, "faster"),
        (1.5, 1.0, 1e-6, "slower: keep on the CPU"),
        (0.5, 1.6, 1e-6, "uses more memory"),
        (0.5, 1.0, 0.5, "output differs"),
        (0.95, 1.0, 0.0, "no real difference"),
    ],
)
def test_verdict_words(ratio, rss, delta, words) -> None:
    assert words in bench.verdict(ratio, rss, delta)


def test_rows_compare_every_run_with_the_cpu_baseline(tmp_path) -> None:
    base = _result(tmp_path, "cpu", 10.0, 200.0, [1.0, 2.0, 3.0])
    fast = _result(tmp_path, "gpu", 4.0, 210.0, [1.0, 2.0, 3.0000001])
    rows = bench.build_rows("demo", base, [fast])
    assert [r.device for r in rows] == ["cpu", "gpu"]
    assert rows[0].verdict == "baseline"
    assert rows[1].ratio_vs_cpu == pytest.approx(0.4)
    assert rows[1].rss_ratio_vs_cpu == pytest.approx(1.05)
    assert rows[1].max_abs_delta == pytest.approx(1e-7, abs=1e-9)
    assert rows[1].verdict == "faster"


def test_a_different_output_shape_is_a_difference_not_a_crash(tmp_path) -> None:
    base = _result(tmp_path, "cpu", 10.0, None, [1.0, 2.0])
    other = _result(tmp_path, "gpu", 5.0, None, [1.0, 2.0, 3.0])
    row = bench.build_rows("demo", base, [other])[1]
    assert row.max_abs_delta == float("inf")
    assert "output differs" in row.verdict
    assert row.rss_ratio_vs_cpu is None


def test_the_table_has_one_line_per_row_and_dashes_for_missing_numbers(tmp_path) -> None:
    base = _result(tmp_path, "cpu", 10.0, None, [1.0])
    lines = bench.format_table(bench.build_rows("demo", base, [])).splitlines()
    assert len(lines) == 3
    assert lines[0].startswith("path")
    assert "baseline" in lines[2]
    assert " -" in lines[2]


def test_a_cpu_only_machine_runs_only_the_baseline(tmp_path) -> None:
    calls: list[str] = []

    def spawn(path, device, providers, extra, out):
        calls.append(device)
        return _result(Path(out).parent, device, 3.0, 100.0, [1.0])

    with use_hardware_profile(cpu_only_profile(4)):
        rows, note = bench.benchmark("demo", [], spawn=spawn)
    assert calls == ["cpu"]
    assert len(rows) == 1
    assert note is not None and "No accelerator" in note


def test_an_accelerator_machine_runs_the_first_provider_after_the_baseline() -> None:
    seen: list[tuple[str, tuple[str, ...]]] = []

    def spawn(path, device, providers, extra, out):
        seen.append((device, providers))
        return _result(Path(out).parent, device, 3.0, 100.0, [1.0])

    apple = cpu_only_profile(8)
    apple = type(apple)(
        **{
            **apple.__dict__,
            "system": "Darwin",
            "machine": "arm64",
            "apple_silicon": True,
            "onnx_providers": (COREML_PROVIDER, CPU_PROVIDER),
        }
    )
    with use_hardware_profile(apple):
        rows, note = bench.benchmark("demo", [], spawn=spawn)
    assert seen == [
        ("cpu", (CPU_PROVIDER,)),
        (COREML_PROVIDER, (COREML_PROVIDER, CPU_PROVIDER)),
    ]
    assert [r.device for r in rows] == ["cpu", COREML_PROVIDER]
    assert note is None


def test_a_real_child_run_reports_timing_memory_and_a_saved_output(tmp_path, capsys) -> None:
    out_json = tmp_path / "rows.json"
    code = bench.main(
        [
            "--path",
            "synthetic-matmul",
            "--size",
            "64",
            "--repeat",
            "3",
            "--warmup",
            "1",
            "--json",
            str(out_json),
        ]
    )
    assert code == 0
    rows = json.loads(out_json.read_text())
    assert rows[0]["device"] == "cpu"
    assert rows[0]["verdict"] == "baseline"
    assert rows[0]["median_ms"] > 0
    assert "synthetic-matmul" in capsys.readouterr().out


def test_the_onnx_path_needs_a_model_file(capsys) -> None:
    assert bench.main(["--path", "onnx-model"]) == 2
    assert "--onnx" in capsys.readouterr().err
