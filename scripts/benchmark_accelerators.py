#!/usr/bin/env python3
"""Lab-only: run a model path on the CPU and on this machine's accelerator, one table (#2254).

Each configuration runs in its own process so its peak memory is its own. The CPU run is the
baseline; every other row reports its time ratio, memory ratio and the largest output difference
against it, then a plain verdict. A path that is not clearly faster, that costs memory the speed-up
does not pay for, or whose output differs stays on the CPU. This table is the proof format for the
GPU issues #2248 to #2252 of #2246.

    python scripts/benchmark_accelerators.py --path onnx-model --onnx model.onnx
    python scripts/benchmark_accelerators.py --path synthetic-matmul --json out.json

The comparison always uses this machine's best provider order, whatever PODCAST_ACCELERATOR says:
turning the accelerator off for the product does not stop the lab from measuring it.

Limits: inputs are seeded random (a timing and agreement check, not a quality check); peak memory
is host RSS of the whole process, not GPU memory; the CPU runs first, so slow drift (heat) favours
the accelerator a little.

Adding a path: register a factory in ``PATHS`` taking the ONNX Runtime provider order and the parsed
arguments and returning a ``Loaded``. Add the name to ``PROVIDER_PATHS`` if the factory honors the
providers (otherwise there is nothing to compare and only the CPU row is produced).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import subprocess  # nosec B404
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

_REPO = Path(__file__).resolve().parents[1]
if str(_REPO / "src") not in sys.path:
    sys.path.insert(0, str(_REPO / "src"))

from podcast_mcp.util.hardware import CPU_PROVIDER, hardware_profile

_SEED = 20261025
_NOISE_BAND = 0.10
_MEMORY_BAND = 0.10
_MEMORY_PAID_FOR = 1.5
_SPEEDUP_THAT_PAYS = 2 / 3
_OUTPUT_TOLERANCE = 1e-3
_CHILD_TIMEOUT_SEC = 900


def _flat(out: Any) -> np.ndarray:
    return np.asarray(out, dtype=np.float64).ravel()


@dataclass
class Loaded:
    run: Callable[[], Any]
    providers_used: tuple[str, ...]
    flatten: Callable[[Any], np.ndarray] = _flat


@dataclass
class RunResult:
    device: str
    providers: tuple[str, ...]
    load_sec: float
    first_run_sec: float
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
    first_run_sec: float
    peak_rss_mb: float | None
    rss_ratio_vs_cpu: float | None
    max_rel_delta: float | None
    verdict: str


def _synthetic_matmul(providers: tuple[str, ...], args: argparse.Namespace) -> Loaded:
    """A path that needs no model file: proves the harness itself and runs in CI."""
    rng = np.random.default_rng(_SEED)
    a = rng.standard_normal((args.size, args.size), dtype=np.float32)
    b = rng.standard_normal((args.size, args.size), dtype=np.float32)
    return Loaded(lambda: a @ b, providers_used=(CPU_PROVIDER,))


_ONNX_DTYPES = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
    "tensor(int8)": np.int8,
    "tensor(uint8)": np.uint8,
    "tensor(int32)": np.int32,
    "tensor(int64)": np.int64,
    "tensor(bool)": np.bool_,
}


_BATCH_AXES = frozenset({"batch", "batch_size", "n", "N"})
_MAX_INPUT_MB = 256


def parse_dims(items: list[str]) -> dict[str, int]:
    """``NAME=SIZE`` pairs from the command line, for naming the length of one dynamic axis."""
    dims: dict[str, int] = {}
    for item in items:
        name, _, size = item.partition("=")
        if not name or not re.fullmatch(r"[0-9]+", size) or int(size) < 1:
            raise ValueError(f"--dim wants NAME=SIZE with a positive size, got {item!r}")
        dims[name] = int(size)
    return dims


def input_shape(
    name: str,
    meta_shape: list[Any],
    dtype: Any,
    args: argparse.Namespace,
    used: set[str] | None = None,
) -> list[int]:
    """Concrete shape for one model input; refuses one too big to be a sensible benchmark input.

    A named dynamic axis takes its ``--dim NAME=SIZE``; an axis called batch, batch_size or n is 1;
    any other dynamic axis takes ``--dynamic-dim``. The cap is on the size of the input array
    itself, not on what the model needs to run it (wav2vec2 needs far more than its input).
    """
    dims = parse_dims(getattr(args, "dim", None) or [])
    shape: list[int] = []
    for axis in meta_shape:
        if isinstance(axis, int) and axis > 0:
            shape.append(axis)
        elif isinstance(axis, str) and axis in dims:
            shape.append(dims[axis])
            if used is not None:
                used.add(axis)
        elif isinstance(axis, str) and axis in _BATCH_AXES:
            shape.append(1)
        else:
            shape.append(args.dynamic_dim)
    megabytes = math.prod(shape) * np.dtype(dtype).itemsize / 1024**2
    if megabytes > _MAX_INPUT_MB:
        raise ValueError(
            f"input {name!r} would be {megabytes:.0f} MB with shape {shape}; "
            f"name each dynamic axis with --dim NAME=SIZE (axes: {meta_shape})"
        )
    return shape


def _onnx_model(providers: tuple[str, ...], args: argparse.Namespace) -> Loaded:
    """Any ONNX file with seeded random inputs shaped from the model's own metadata."""
    import onnxruntime

    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = hardware_profile().effective_cores
    session = onnxruntime.InferenceSession(str(args.onnx), options, providers=list(providers))
    rng = np.random.default_rng(_SEED)
    feeds: dict[str, np.ndarray] = {}
    used: set[str] = set()
    for meta in session.get_inputs():
        dtype = _ONNX_DTYPES.get(meta.type)
        if dtype is None:
            raise ValueError(f"input {meta.name!r} has unsupported type {meta.type}")
        shape = input_shape(meta.name, meta.shape, dtype, args, used)
        if dtype is np.bool_:
            feeds[meta.name] = rng.integers(0, 2, size=shape, dtype=np.uint8).astype(dtype)
        elif np.issubdtype(dtype, np.integer):
            feeds[meta.name] = rng.integers(0, 8, size=shape, dtype=dtype)
        elif dtype in (np.float32, np.float64):
            feeds[meta.name] = rng.standard_normal(shape, dtype=dtype)
        else:
            feeds[meta.name] = rng.standard_normal(shape, dtype=np.float32).astype(dtype)

    unused = sorted(set(parse_dims(args.dim)) - used)
    if unused:
        axes = sorted({str(a) for m in session.get_inputs() for a in m.shape if isinstance(a, str)})
        raise ValueError(
            f"--dim {', '.join(unused)} matches no dynamic axis; the model's are {axes}"
        )

    def flatten(outputs: list[Any]) -> np.ndarray:
        return np.concatenate([_flat(o) for o in outputs])

    return Loaded(
        lambda: session.run(None, feeds),
        providers_used=tuple(session.get_providers()),
        flatten=flatten,
    )


PATHS: dict[str, Callable[[tuple[str, ...], argparse.Namespace], Loaded]] = {
    "synthetic-matmul": _synthetic_matmul,
    "onnx-model": _onnx_model,
}
PROVIDER_PATHS = frozenset({"onnx-model"})


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
    load_sec = time.perf_counter() - started
    started = time.perf_counter()
    first = loaded.run()
    first_run_sec = time.perf_counter() - started
    for _ in range(args.warmup):
        loaded.run()
    wall_ms: list[float] = []
    for _ in range(args.repeat):
        t0 = time.perf_counter()
        loaded.run()
        wall_ms.append((time.perf_counter() - t0) * 1000)
    np.save(args.output, loaded.flatten(first))
    return RunResult(
        device=args.device,
        providers=loaded.providers_used,
        load_sec=load_sec,
        first_run_sec=first_run_sec,
        wall_ms=wall_ms,
        peak_rss_mb=_peak_rss_mb(),
        output_file=str(args.output),
    )


def _spawn(
    path: str, device: str, providers: tuple[str, ...], extra: list[str], out: Path
) -> RunResult:
    result_file = out.with_suffix(".json")
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
        "--result",
        str(result_file),
        *extra,
    ]
    try:
        done = subprocess.run(  # nosec B603
            cmd,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=_CHILD_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{device} run timed out after {_CHILD_TIMEOUT_SEC} s") from exc
    if done.returncode != 0 or not result_file.is_file() or not out.is_file():
        raise RuntimeError(f"{device} run failed: {(done.stderr or '').strip()[-400:]}")
    payload = json.loads(result_file.read_text(encoding="utf-8"))
    return RunResult(**{**payload, "providers": tuple(payload["providers"])})


def _band(samples: list[float]) -> tuple[float, float]:
    """The middle half of the samples; the whole range when there are too few for quartiles."""
    if len(samples) < 4:
        return min(samples), max(samples)
    q1, _, q3 = statistics.quantiles(samples, n=4)
    return q1, q3


def relative_delta(base: np.ndarray, other: np.ndarray) -> float:
    """Largest absolute difference over the baseline's scale; inf if shapes or finiteness differ."""
    if base.shape != other.shape or base.size == 0 or not np.all(np.isfinite(other)):
        return math.inf
    scale = max(1.0, float(np.max(np.abs(base))))
    return float(np.max(np.abs(other - base))) / scale


def verdict(
    ratio: float | None, rss_ratio: float | None, delta: float | None, separated: bool = True
) -> str:
    """Plain words: keep on the CPU unless the accelerator is clearly better and affordable."""
    if ratio is None:
        return "baseline"
    if delta is not None and not delta <= _OUTPUT_TOLERANCE:
        return "output differs: check before use"
    if not separated or abs(1 - ratio) <= _NOISE_BAND:
        return "no real difference: keep on the CPU"
    if ratio > 1:
        return "slower: keep on the CPU"
    if rss_ratio is not None and rss_ratio > 1 + _MEMORY_BAND:
        if ratio <= _SPEEDUP_THAT_PAYS and rss_ratio <= _MEMORY_PAID_FOR:
            return "faster, uses more memory: worth it only if the speed-up matters"
        return "uses more memory than the speed-up pays for: keep on the CPU"
    return "faster"


def build_rows(path: str, baseline: RunResult, others: list[RunResult]) -> list[Row]:
    base_out = np.load(baseline.output_file)
    base_ms = statistics.median(baseline.wall_ms)
    base_band = _band(baseline.wall_ms)
    rows = [
        Row(
            path,
            baseline.device,
            base_ms,
            None,
            baseline.load_sec,
            baseline.first_run_sec,
            baseline.peak_rss_mb,
            None,
            None,
            "baseline",
        )
    ]
    for res in others:
        ms = statistics.median(res.wall_ms)
        ratio = ms / max(base_ms, 1e-9)
        band = _band(res.wall_ms)
        separated = band[1] < base_band[0] or band[0] > base_band[1]
        delta = relative_delta(base_out, np.load(res.output_file))
        rss = (
            res.peak_rss_mb / baseline.peak_rss_mb
            if res.peak_rss_mb is not None and baseline.peak_rss_mb
            else None
        )
        if res.providers[:1] != (res.device,):
            ran_on = res.providers[0] if res.providers else "?"
            said = f"{res.device} did not load: ran on {ran_on}"
        else:
            said = verdict(ratio, rss, delta, separated)
        rows.append(
            Row(
                path,
                res.device,
                ms,
                ratio,
                res.load_sec,
                res.first_run_sec,
                res.peak_rss_mb,
                rss,
                delta,
                said,
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
        "first run s",
        "peak MiB",
        "x CPU mem",
        "output diff",
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
            num(r.first_run_sec, ".2f"),
            num(r.peak_rss_mb, ".0f"),
            num(r.rss_ratio_vs_cpu, ".2f"),
            num(r.max_rel_delta, ".1e"),
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
    """Baseline on the CPU, then this machine's best provider order if there is one to compare."""
    profile = hardware_profile()
    order = profile.onnx_provider_order("auto")
    with tempfile.TemporaryDirectory(prefix="accel-bench-") as tmp:
        base = spawn(path, "cpu", (CPU_PROVIDER,), extra, Path(tmp) / "cpu.npy")
        others: list[RunResult] = []
        note = None
        if path not in PROVIDER_PATHS:
            note = f"The {path} path runs on the CPU only, so there is nothing to compare."
        elif order == (CPU_PROVIDER,):
            note = f"No accelerator to compare on this machine. {profile.summary('auto')}"
        else:
            others.append(spawn(path, order[0], order, extra, Path(tmp) / "accel.npy"))
        return build_rows(path, base, others), note


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--path", choices=sorted(PATHS), default="synthetic-matmul")
    p.add_argument("--onnx", type=Path, help="model file for --path onnx-model")
    p.add_argument("--dynamic-dim", type=int, default=16, help="size used for dynamic axes")
    p.add_argument(
        "--dim",
        action="append",
        default=[],
        metavar="NAME=SIZE",
        help="size of one named dynamic axis (repeatable); batch axes default to 1",
    )
    p.add_argument("--size", type=int, default=512, help="matrix size for synthetic-matmul")
    p.add_argument("--repeat", type=int, default=20)
    p.add_argument("--warmup", type=int, default=3)
    p.add_argument("--json", type=Path, help="also write the table rows here")
    p.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--device", default="cpu", help=argparse.SUPPRESS)
    p.add_argument("--providers", default=CPU_PROVIDER, help=argparse.SUPPRESS)
    p.add_argument("--output", type=Path, help=argparse.SUPPRESS)
    p.add_argument("--result", type=Path, help=argparse.SUPPRESS)
    return p


def _passthrough(args: argparse.Namespace) -> list[str]:
    extra = ["--repeat", str(args.repeat), "--warmup", str(args.warmup)]
    extra += ["--size", str(args.size), "--dynamic-dim", str(args.dynamic_dim)]
    for dim in args.dim:
        extra += ["--dim", dim]
    return extra + (["--onnx", str(args.onnx)] if args.onnx else [])


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.repeat < 1 or args.warmup < 0 or args.size < 1 or args.dynamic_dim < 1:
        print(
            "--repeat, --size and --dynamic-dim need at least 1; --warmup at least 0",
            file=sys.stderr,
        )
        return 2
    if args.child:
        try:
            args.result.write_text(json.dumps(asdict(run_child(args))), encoding="utf-8")
        except Exception as exc:
            print(exc, file=sys.stderr)
            return 3
        return 0
    if args.path == "onnx-model" and not args.onnx:
        print("--path onnx-model needs --onnx FILE", file=sys.stderr)
        return 2
    if args.onnx is not None and not args.onnx.is_file():
        print(f"--onnx {args.onnx} not found", file=sys.stderr)
        return 2
    try:
        parse_dims(args.dim)
        rows, note = benchmark(args.path, _passthrough(args))
    except (RuntimeError, ValueError) as exc:
        print(f"benchmark failed: {exc}", file=sys.stderr)
        return 1
    print(format_table(rows))
    if note:
        print(note)
    if args.json:
        args.json.write_text(json.dumps([asdict(r) for r in rows], indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
