"""The accelerator benchmark harness (#2254): comparison maths, verdict words, and a real child run."""

from __future__ import annotations

import dataclasses
import json
import math
import sys
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


@pytest.fixture(autouse=True, scope="module")
def _unregister_script():
    yield
    sys.modules.pop("benchmark_accelerators", None)


def _result(
    tmp_path: Path,
    device: str,
    ms: float,
    rss: float | None,
    out: list[float],
    providers: tuple[str, ...] | None = None,
    samples: list[float] | None = None,
):
    path = tmp_path / f"{device}.npy"
    np.save(path, np.asarray(out, dtype=np.float64))
    return bench.RunResult(
        device=device,
        providers=providers or (device,),
        load_sec=0.5,
        first_run_sec=0.7,
        wall_ms=samples or [ms, ms, ms],
        peak_rss_mb=rss,
        output_file=str(path),
    )


def _apple_profile():
    base = cpu_only_profile(8)
    return dataclasses.replace(
        base,
        system="Darwin",
        machine="arm64",
        apple_silicon=True,
        onnx_providers=(COREML_PROVIDER, CPU_PROVIDER),
    )


@pytest.fixture(autouse=True)
def _no_accelerator_override(monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_ACCELERATOR", raising=False)


@pytest.mark.parametrize(
    ("ratio", "rss", "delta", "words"),
    [
        (None, None, None, "baseline"),
        (0.5, 1.0, 1e-6, "faster"),
        (1.5, 1.0, 1e-6, "slower: keep on the CPU"),
        (0.5, 1.2, 1e-6, "worth it only if the speed-up matters"),
        (0.5, 2.0, 1e-6, "than the speed-up pays for"),
        (0.85, 1.2, 1e-6, "than the speed-up pays for"),
        (0.5, 1.0, 0.5, "output differs"),
        (0.5, 1.0, math.nan, "output differs"),
        (0.95, 1.0, 0.0, "no real difference"),
        (0.9, 1.0, 0.0, "no real difference"),
        (0.89, 1.0, 0.0, "faster"),
    ],
)
def test_verdict_words(ratio, rss, delta, words) -> None:
    assert words in bench.verdict(ratio, rss, delta)


def test_overlapping_samples_are_no_real_difference_even_with_a_lower_median() -> None:
    assert "no real difference" in bench.verdict(0.5, 1.0, 0.0, separated=False)


def test_rows_compare_every_run_with_the_cpu_baseline(tmp_path) -> None:
    base = _result(tmp_path, "cpu", 10.0, 200.0, [1.0, 2.0, 3.0])
    fast = _result(tmp_path, "gpu", 4.0, 210.0, [1.0, 2.0, 3.0000001])
    rows = bench.build_rows("demo", base, [fast])
    assert [r.device for r in rows] == ["cpu", "gpu"]
    assert rows[0].verdict == "baseline"
    assert rows[1].ratio_vs_cpu == pytest.approx(0.4)
    assert rows[1].rss_ratio_vs_cpu == pytest.approx(1.05)
    assert rows[1].max_rel_delta == pytest.approx(1e-7 / 3, abs=1e-9)
    assert rows[1].verdict == "faster"


def test_a_different_output_shape_is_a_difference_not_a_crash(tmp_path) -> None:
    base = _result(tmp_path, "cpu", 10.0, None, [1.0, 2.0])
    other = _result(tmp_path, "gpu", 5.0, None, [1.0, 2.0, 3.0])
    row = bench.build_rows("demo", base, [other])[1]
    assert row.max_rel_delta == float("inf")
    assert "output differs" in row.verdict
    assert row.rss_ratio_vs_cpu is None


def test_nan_and_empty_outputs_are_differences(tmp_path) -> None:
    base = _result(tmp_path, "cpu", 10.0, None, [1.0, 2.0])
    nan = _result(tmp_path, "gpu", 5.0, None, [1.0, float("nan")])
    assert "output differs" in bench.build_rows("demo", base, [nan])[1].verdict
    empty_base = _result(tmp_path, "cpu", 10.0, None, [])
    empty = _result(tmp_path, "gpu", 5.0, None, [])
    assert "output differs" in bench.build_rows("demo", empty_base, [empty])[1].verdict


def test_large_outputs_are_compared_on_their_own_scale(tmp_path) -> None:
    base = _result(tmp_path, "cpu", 10.0, None, [1000.0, 2000.0])
    other = _result(tmp_path, "gpu", 4.0, None, [1000.5, 2000.0])
    row = bench.build_rows("demo", base, [other])[1]
    assert row.max_rel_delta == pytest.approx(0.5 / 2000.0)
    assert row.verdict == "faster"


def test_an_accelerator_that_did_not_load_is_labelled_not_scored(tmp_path) -> None:
    base = _result(tmp_path, "cpu", 10.0, None, [1.0])
    quiet = _result(tmp_path, "gpu", 4.0, None, [1.0], providers=(CPU_PROVIDER,), samples=[4.0] * 3)
    row = bench.build_rows("demo", base, [quiet])[1]
    assert row.verdict == f"gpu did not load: ran on {CPU_PROVIDER}"


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
        rows, note = bench.benchmark("onnx-model", [], spawn=spawn)
    assert calls == ["cpu"]
    assert len(rows) == 1
    assert note is not None and "No accelerator" in note


def test_an_accelerator_machine_runs_the_first_provider_after_the_baseline() -> None:
    seen: list[tuple[str, tuple[str, ...]]] = []

    def spawn(path, device, providers, extra, out):
        seen.append((device, providers))
        return _result(Path(out).parent, device, 3.0, 100.0, [1.0], providers=providers)

    with use_hardware_profile(_apple_profile()):
        rows, note = bench.benchmark("onnx-model", [], spawn=spawn)
    assert seen == [
        ("cpu", (CPU_PROVIDER,)),
        (COREML_PROVIDER, (COREML_PROVIDER, CPU_PROVIDER)),
    ]
    assert [r.device for r in rows] == ["cpu", COREML_PROVIDER]
    assert note is None


def test_a_path_that_ignores_providers_is_only_measured_on_the_cpu() -> None:
    seen: list[str] = []

    def spawn(path, device, providers, extra, out):
        seen.append(device)
        return _result(Path(out).parent, device, 3.0, 100.0, [1.0])

    with use_hardware_profile(_apple_profile()):
        rows, note = bench.benchmark("synthetic-matmul", [], spawn=spawn)
    assert seen == ["cpu"]
    assert len(rows) == 1
    assert note is not None and "nothing to compare" in note


def test_the_comparison_ignores_a_cpu_override(monkeypatch) -> None:
    monkeypatch.setenv("PODCAST_ACCELERATOR", "cpu")
    seen: list[str] = []

    def spawn(path, device, providers, extra, out):
        seen.append(device)
        return _result(Path(out).parent, device, 3.0, 100.0, [1.0], providers=providers)

    with use_hardware_profile(_apple_profile()):
        bench.benchmark("onnx-model", [], spawn=spawn)
    assert seen == ["cpu", COREML_PROVIDER]


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
    assert rows[0]["first_run_sec"] >= 0
    assert "synthetic-matmul" in capsys.readouterr().out


def test_a_hung_child_is_reported_not_waited_for(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(bench, "_CHILD_TIMEOUT_SEC", 0.01)
    original = bench.subprocess.run

    def slow(cmd, **kwargs):
        return original([bench.sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)

    monkeypatch.setattr(bench.subprocess, "run", slow)
    with pytest.raises(RuntimeError, match="timed out"):
        bench._spawn("synthetic-matmul", "cpu", (CPU_PROVIDER,), [], tmp_path / "x.npy")


@pytest.mark.parametrize(
    "argv",
    [["--repeat", "0"], ["--warmup", "-1"], ["--size", "0"], ["--dynamic-dim", "0"]],
)
def test_bad_numbers_are_refused(argv, capsys) -> None:
    assert bench.main(["--path", "synthetic-matmul", *argv]) == 2
    assert "at least" in capsys.readouterr().err


def test_the_onnx_path_needs_a_model_file(capsys) -> None:
    assert bench.main(["--path", "onnx-model"]) == 2
    assert "--onnx" in capsys.readouterr().err


def _ns(**kw):
    import argparse

    return argparse.Namespace(**{"dim": [], "dynamic_dim": 16, **kw})


def test_input_shapes_name_batch_and_length_separately() -> None:
    shape = bench.input_shape(
        "x", ["batch_size", "sequence_length"], np.float32, _ns(dim=["sequence_length=160000"])
    )
    assert shape == [1, 160000]


def test_fixed_axes_and_the_default_dynamic_size() -> None:
    assert bench.input_shape("x", [1, "t", 80], np.float32, _ns()) == [1, 16, 80]


def test_an_input_that_would_be_huge_is_refused_before_it_is_allocated() -> None:
    with pytest.raises(ValueError, match="--dim NAME=SIZE"):
        bench.input_shape("x", ["a", "b"], np.float32, _ns(dynamic_dim=160000))


@pytest.mark.parametrize("item", ["noequals", "x=", "x=0", "=5", "x=abc"])
def test_bad_dim_items_are_refused(item) -> None:
    with pytest.raises(ValueError, match="NAME=SIZE"):
        bench.parse_dims([item])


def test_a_failed_benchmark_is_a_plain_message_not_a_traceback(tmp_path, capsys) -> None:
    bad = tmp_path / "bad.onnx"
    bad.write_bytes(b"not a model")
    assert bench.main(["--path", "onnx-model", "--onnx", str(bad), "--repeat", "1"]) == 1
    assert "benchmark failed" in capsys.readouterr().err


def test_a_missing_model_file_is_named_before_anything_runs(tmp_path, capsys) -> None:
    assert bench.main(["--path", "onnx-model", "--onnx", str(tmp_path / "gone.onnx")]) == 2
    assert "gone.onnx not found" in capsys.readouterr().err


def test_the_input_size_cap_is_exact() -> None:
    n = 256 * 1024**2 // 4
    assert bench.input_shape("x", ["t"], np.float32, _ns(dim=[f"t={n}"])) == [n]
    with pytest.raises(ValueError, match="MB"):
        bench.input_shape("x", ["t"], np.float32, _ns(dim=[f"t={n + 1}"]))


def test_a_superscript_digit_is_not_a_size() -> None:
    with pytest.raises(ValueError, match="NAME=SIZE"):
        bench.parse_dims(["t=\u00b2"])


def test_a_dim_name_that_matches_no_axis_is_refused(tmp_path, capsys) -> None:
    onnx = pytest.importorskip("onnx")
    pytest.importorskip("onnxruntime")
    from onnx import TensorProto as T
    from onnx import helper as h

    graph = h.make_graph(
        [h.make_node("Neg", ["x"], ["y"])],
        "g",
        [h.make_tensor_value_info("x", T.FLOAT, ["batch_size", "sequence_length"])],
        [h.make_tensor_value_info("y", T.FLOAT, ["batch_size", "sequence_length"])],
    )
    model = h.make_model(graph, opset_imports=[h.make_opsetid("", 13)])
    model.ir_version = 8
    path = tmp_path / "neg.onnx"
    onnx.save(model, path)
    argv = ["--path", "onnx-model", "--onnx", str(path), "--repeat", "1", "--warmup", "0"]
    assert bench.main([*argv, "--dim", "sequence_length=64"]) == 0
    capsys.readouterr()
    assert bench.main([*argv, "--dim", "sequnce_length=64"]) == 1
    assert "matches no dynamic axis" in capsys.readouterr().err
