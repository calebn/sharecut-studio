#!/usr/bin/env python3
"""Lab-only: run a model path on the CPU and on this machine's accelerator, one table (#2254).

Each configuration runs in its own process so peak RSS is that run's alone. The CPU run is the
baseline: every other row reports its wall time ratio, peak memory and the largest output
difference against it. A path that is not faster, or that costs memory or changes its output,
should stay on the CPU; this table is the proof format for the sibling issues of #2246.

    python scripts/benchmark_accelerators.py --path onnx-model --onnx model.onnx
    python scripts/benchmark_accelerators.py --path synthetic-matmul --json out.json

Adding a path: register a factory in ``PATHS`` that takes the ONNX Runtime provider order and the
parsed arguments and returns a ``Loaded`` (the work to time, called repeatedly with no arguments).
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess  # nosec B404
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

from podcast_mcp.util.hardware import CPU_PROVIDER, accelerator_preference, hardware_profile

_SEED = 20261025
_SAME_RATIO = 0.10


@dataclass
class Loaded:
    run: Callable[[], np.ndarray]
    providers_used: tuple[str, ...]


@dataclass
class RunResult:
    device: str
    providers: tuple[str, ...]
    load_sec: float
    wall_ms: list[float]
    peak_rss_mb: float | None
    output_file: str


@dataclass
class Row:
    path: str
    device: str
    median_ms: float
    ratio_vs_cpu: float | None
    load_sec: float
    peak_rss_mb: float | None
    rss_ratio_vs_cpu: float | None
    max_abs_delta: float | None
    verdict: str


def _synthetic_matmul(providers: tuple[str, ...], args: argparse.Namespace) -> Loaded:
    """A path that needs no model file: proves the harness itself and runs in CI."""
    rng = np.random.default_rng(_SEED)
    a = rng.standard_normal((args.size, args.size), dtype=np.float32)
    b = rng.standard_normal((args.size, args.size), dtype=np.float32)
    return Loaded(lambda: a @ b, providers_used=(CPU_PROVIDER,))


def _onnx_model(providers: tuple[str, ...], args: argparse.Namespace) -> Loaded:
    """Any ONNX file with seeded random inputs shaped from the model's own metadata."""
    import onnxruntime

    session = onnxruntime.InferenceSession(str(args.onnx), providers=list(providers))
    rng = np.random.default_rng(_SEED)
    feeds: dict[str, np.ndarray] = {}
    for meta in session.get_inputs():
        shape = [d if isinstance(d, int) and d > 0 else args.dynamic_dim for d in meta.shape]
        if "int" in meta.type:
            feeds[meta.name] = rng.integers(0, 8, size=shape).astype(
                np.int64 if "64" in meta.type else np.int32
            )
        else:
            feeds[meta.name] = rng.standard_normal(shape).astype(np.float32)

    def run() -> np.ndarray:
        outputs = session.run(None, feeds)
        return np.concatenate([np.asarray(o, dtype=np.float64).ravel() for o in outputs])

    return Loaded(run, providers_used=tuple(session.get_providers()))


PATHS: dict[str, Callable[[tuple[str, ...], argparse.Namespace], Loaded]] = {
    "synthetic-matmul": _synthetic_matmul,
    "onnx-model": _onnx_model,
}


def _peak_rss_mb() -> float | None:
    """Process RSS high-water mark in MiB; None where ``resource`` is missing (Windows)."""
    try:
        import resource
    except ImportError:
        return None
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss / 1024**2 if sys.platform == "darwin" else rss / 1024


def run_child(args: argparse.Namespace) -> RunResult:
    providers = tuple(args.providers.split(","))
    started = time.perf_counter()
    loaded = PATHS[args.path](providers, args)
    first = loaded.run()
    load_sec = time.perf_counter() - started
    for _ in range(args.warmup):
        loaded.run()
    wall_ms: list[float] = []
    for _ in range(args.repeat):
        t0 = time.perf_counter()
        loaded.run()
        wall_ms.append((time.perf_counter() - t0) * 1000)
    np.save(args.output, np.asarray(first, dtype=np.float64).ravel())
    return RunResult(
        device=args.device,
        providers=loaded.providers_used,
        load_sec=load_sec,
        wall_ms=wall_ms,
        peak_rss_mb=_peak_rss_mb(),
        output_file=str(args.output),
    )


def _spawn(
    path: str, device: str, providers: tuple[str, ...], extra: list[str], out: Path
) -> RunResult:
    cmd = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--child",
        "--path",
        path,
        "--device",
        device,
        "--providers",
        ",".join(providers),
        "--output",
        str(out),
        *extra,
    ]
    done = subprocess.run(cmd, capture_output=True, text=True, check=False)  # nosec B603
    if done.returncode != 0:
        raise RuntimeError(f"{device} run failed: {done.stderr.strip()[-400:]}")
    payload = json.loads(done.stdout)
    return RunResult(**{**payload, "providers": tuple(payload["providers"])})


def verdict(ratio: float | None, rss_ratio: float | None, delta: float | None) -> str:
    """Plain words: keep on the CPU unless the accelerator is clearly better and costs nothing."""
    if ratio is None:
        return "baseline"
    if delta is not None and delta > 1e-3:
        return "output differs: check before use"
    if ratio > 1 + _SAME_RATIO:
        return "slower: keep on the CPU"
    if rss_ratio is not None and rss_ratio > 1 + _SAME_RATIO:
        return "uses more memory: keep on the CPU unless the speed-up is large"
    if ratio < 1 - _SAME_RATIO:
        return "faster"
    return "no real difference: keep on the CPU"


def build_rows(path: str, baseline: RunResult, others: list[RunResult]) -> list[Row]:
    base_out = np.load(baseline.output_file)
    base_ms = statistics.median(baseline.wall_ms)
    rows = [
        Row(
            path,
            baseline.device,
            base_ms,
            None,
            baseline.load_sec,
            baseline.peak_rss_mb,
            None,
            None,
            "baseline",
        )
    ]
    for res in others:
        out = np.load(res.output_file)
        delta = (
            float(np.max(np.abs(out - base_out))) if out.shape == base_out.shape else float("inf")
        )
        ms = statistics.median(res.wall_ms)
        ratio = ms / base_ms
        rss = (
            res.peak_rss_mb / baseline.peak_rss_mb
            if res.peak_rss_mb is not None and baseline.peak_rss_mb
            else None
        )
        rows.append(
            Row(
                path,
                res.device,
                ms,
                ratio,
                res.load_sec,
                res.peak_rss_mb,
                rss,
                delta,
                verdict(ratio, rss, delta),
            )
        )
    return rows


def format_table(rows: list[Row]) -> str:
    head = (
        "path",
        "device",
        "median ms",
        "x CPU",
        "load s",
        "peak MiB",
        "x CPU mem",
        "max diff",
        "verdict",
    )

    def num(v: float | None, fmt: str) -> str:
        return "-" if v is None else format(v, fmt)

    body = [
        (
            r.path,
            r.device,
            num(r.median_ms, ".2f"),
            num(r.ratio_vs_cpu, ".2f"),
            num(r.load_sec, ".2f"),
            num(r.peak_rss_mb, ".0f"),
            num(r.rss_ratio_vs_cpu, ".2f"),
            num(r.max_abs_delta, ".2e"),
            r.verdict,
        )
        for r in rows
    ]
    widths = [max(len(h), *(len(cells[i]) for cells in body)) for i, h in enumerate(head)]

    def line(cells: tuple[str, ...]) -> str:
        return "  ".join(c.ljust(w) for c, w in zip(cells, widths, strict=True)).rstrip()

    rule = tuple("-" * w for w in widths)
    return "\n".join([line(head), line(rule), *(line(cells) for cells in body)])


def benchmark(
    path: str,
    extra: list[str],
    spawn: Callable[..., RunResult] = _spawn,
) -> tuple[list[Row], str | None]:
    """Baseline on the CPU, then the accelerator order if this machine has one."""
    profile = hardware_profile()
    order = profile.onnx_provider_order(accelerator_preference())
    with tempfile.TemporaryDirectory(prefix="accel-bench-") as tmp:
        base = spawn(path, "cpu", (CPU_PROVIDER,), extra, Path(tmp) / "cpu.npy")
        note = None
        others: list[RunResult] = []
        if order == (CPU_PROVIDER,):
            note = f"No accelerator to compare on this machine. {profile.summary()}"
        else:
            others.append(spawn(path, order[0], order, extra, Path(tmp) / "accel.npy"))
        return build_rows(path, base, others), note


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--path", choices=sorted(PATHS), default="synthetic-matmul")
    p.add_argument("--onnx", type=Path, help="model file for --path onnx-model")
    p.add_argument("--dynamic-dim", type=int, default=16, help="size used for dynamic axes")
    p.add_argument("--size", type=int, default=512, help="matrix size for synthetic-matmul")
    p.add_argument("--repeat", type=int, default=20)
    p.add_argument("--warmup", type=int, default=3)
    p.add_argument("--json", type=Path, help="also write the table rows here")
    p.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--device", default="cpu", help=argparse.SUPPRESS)
    p.add_argument("--providers", default=CPU_PROVIDER, help=argparse.SUPPRESS)
    p.add_argument("--output", type=Path, help=argparse.SUPPRESS)
    return p


def _passthrough(args: argparse.Namespace) -> list[str]:
    extra = ["--repeat", str(args.repeat), "--warmup", str(args.warmup)]
    extra += ["--size", str(args.size), "--dynamic-dim", str(args.dynamic_dim)]
    return extra + (["--onnx", str(args.onnx)] if args.onnx else [])


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.child:
        print(json.dumps(asdict(run_child(args))))
        return 0
    if args.path == "onnx-model" and not args.onnx:
        print("--path onnx-model needs --onnx FILE", file=sys.stderr)
        return 2
    rows, note = benchmark(args.path, _passthrough(args))
    print(format_table(rows))
    if note:
        print(note)
    if args.json:
        args.json.write_text(json.dumps([asdict(r) for r in rows], indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
