"""Run forced-aligner candidates against word-boundary targets.

Never downloads models; see docs/testing.md § Word-boundary benchmark.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from benchmark_word_boundaries import benchmark, native_prediction
from podcast_mcp.engines.ctc_forced_align import (
    CtcVocab,
    align_words,
    log_softmax,
    plan_windows,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.word_boundary_metrics import (
    matched_word_pairs,
    measure_word_boundaries,
)
from podcast_mcp.util.atomic_json import write_bytes_atomic, write_json_atomic
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.wav import pcm_wav_header

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
CANDIDATES = FIXTURES / "word_boundary" / "candidates.json"
SAMPLE_RATE = 16_000
DEFAULT_LAB = Path("~/projects/ShareCut_Podcast_Test")
DEFAULT_LAB_GLOB = "source/zoom_excerpt_pan/audio*.m4a"
TARGETS = ("librispeech", "aligned_dialogue", "lab")


@dataclass(frozen=True)
class BenchItem:
    item_id: str
    audio: Path
    gold: Path | None  # scored when set; agreement-only otherwise
    words: Path | None  # existing native words to re-time (skips the Whisper run)
    clip: tuple[float, float] | None


@dataclass(frozen=True)
class Candidate:
    label: str
    backend: str
    hf_repo: str
    revision: str
    allow_patterns: tuple[str, ...]
    license: str
    onnx_file: str | None = None


def resolve_target(
    name: str,
    *,
    lab: Path | None = None,
    lab_glob: str = DEFAULT_LAB_GLOB,
    clip_sec: float = 60.0,
) -> list[BenchItem]:
    if name == "librispeech":
        items = []
        gold_dir = FIXTURES / "word_boundary"
        for gold_path in sorted(gold_dir.glob("*.gold.json")):
            gold = json.loads(gold_path.read_text(encoding="utf-8"))
            item_id = gold["id"]
            items.append(
                BenchItem(
                    item_id=item_id,
                    audio=gold_dir / gold["audio"],
                    gold=gold_path,
                    words=gold_dir / f"{item_id}.native-base.json",
                    clip=None,
                )
            )
        return items

    if name == "aligned_dialogue":
        raw = FIXTURES / "aligned_dialogue" / "raw"
        return [
            BenchItem(
                item_id=f"aligned_dialogue-{stem}",
                audio=raw / f"{stem}.wav",
                gold=None,
                words=None,
                clip=(0.0, clip_sec),
            )
            for stem in ("reference", "guest")
        ]

    if name == "lab":
        root = (lab or Path(os.environ.get("LAB", str(DEFAULT_LAB)))).expanduser()
        files = sorted(root.glob(lab_glob))
        if not files:
            raise FileNotFoundError(
                f"no lab audio matches {root}/{lab_glob}; set LAB or pass --lab"
            )
        return [
            BenchItem(
                item_id=f"lab-{path.stem}",
                audio=path,
                gold=None,
                words=None,
                clip=(0.0, clip_sec),
            )
            for path in files
        ]

    raise ValueError(f"unknown target {name!r}; choose one of {TARGETS}")


def resolve_runs_dir(target: str, runs_dir: Path | None, lab: Path | None) -> Path:
    if runs_dir is None:
        env_runs = os.environ.get("LAB_RUNS_DIR")
        if not env_runs:
            raise ValueError("pass --runs-dir or set LAB_RUNS_DIR")
        runs_dir = Path(env_runs) / "align" / target
    if lab is not None:
        lab_resolved = lab.expanduser().resolve()
        if runs_dir.resolve().is_relative_to(lab_resolved):
            raise ValueError("runs dir must not be inside the lab checkout")
    return runs_dir


def load_candidates(
    path: Path = CANDIDATES, labels: Sequence[str] | None = None
) -> list[Candidate]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    candidates = []
    for entry in payload["candidates"]:
        backend = entry["backend"]
        if backend not in ("onnx", "torch"):
            raise ValueError(f"unknown backend {backend!r} for candidate {entry['label']!r}")
        onnx_file = entry.get("onnx_file")
        if backend == "onnx" and not onnx_file:
            raise ValueError(f"onnx candidate {entry['label']!r} needs onnx_file")
        candidates.append(
            Candidate(
                label=entry["label"],
                backend=backend,
                hf_repo=entry["hf_repo"],
                revision=entry["revision"],
                allow_patterns=tuple(entry["allow_patterns"]),
                license=entry["license"],
                onnx_file=onnx_file,
            )
        )
    if labels is not None:
        by_label = {c.label: c for c in candidates}
        unknown = set(labels) - set(by_label)
        if unknown:
            raise ValueError(f"unknown candidate label(s): {sorted(unknown)}")
        candidates = [by_label[label] for label in labels]
    return candidates


def download_command(c: Candidate) -> str:
    return (
        'uv run python -c "from huggingface_hub import snapshot_download as d; '
        f"print(d('{c.hf_repo}', revision='{c.revision}', allow_patterns={list(c.allow_patterns)!r}))\""
    )


def resolve_model_dir(c: Candidate, override: Path | None) -> Path:
    if override is not None:
        return override
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError

    try:
        return Path(
            snapshot_download(
                c.hf_repo,
                revision=c.revision,
                allow_patterns=list(c.allow_patterns),
                local_files_only=True,
            )
        )
    except LocalEntryNotFoundError as exc:
        raise FileNotFoundError(
            f"{c.label} is not cached locally ({exc}); download it first: {download_command(c)}"
        ) from exc


def load_audio(path: Path, clip: tuple[float, float] | None) -> np.ndarray:
    """Mono float32 at SAMPLE_RATE; a clip decodes only its window (ffmpeg -ss/-t)."""
    if clip is None:
        from faster_whisper.audio import decode_audio

        samples = decode_audio(str(path), sampling_rate=SAMPLE_RATE)
    else:
        start, end = clip
        start_frame = round(start * SAMPLE_RATE)
        frames = max(0, round(end * SAMPLE_RATE) - start_frame)
        samples = FFmpegEngine().decode_window_f32(path, start_frame, frames, SAMPLE_RATE, 1)[:, 0]
    if len(samples) == 0:
        raise ValueError("empty audio clip")
    return samples


def write_wav16(path: Path, samples: np.ndarray) -> None:
    data = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
    write_bytes_atomic(path, pcm_wav_header(len(data), sample_rate=SAMPLE_RATE) + data)


class Backend(Protocol):
    def log_probs(self, samples: np.ndarray) -> np.ndarray: ...


def normalize(samples: np.ndarray) -> np.ndarray:
    return (samples - samples.mean()) / np.sqrt(samples.var() + 1e-7)


class OnnxBackend:
    def __init__(self, model_dir: Path, onnx_file: str, threads: int) -> None:
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise RuntimeError(
                "onnx backend needs onnxruntime, which faster-whisper installs "
                "transitively (not a direct dependency): run uv sync"
            ) from exc

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        self._session = ort.InferenceSession(
            str(model_dir / onnx_file), opts, providers=["CPUExecutionProvider"]
        )
        self._input_name = self._session.get_inputs()[0].name

    def log_probs(self, samples: np.ndarray) -> np.ndarray:
        outputs = self._session.run(
            None, {self._input_name: normalize(samples)[None, :].astype(np.float32)}
        )
        return log_softmax(outputs[0][0])


class TorchBackend:
    def __init__(self, model_dir: Path, threads: int) -> None:
        try:
            import torch
            from transformers import Wav2Vec2ForCTC
        except ImportError as exc:
            raise RuntimeError(
                "torch backend needs: uv sync --extra dev --extra gui --extra relay --extra joinqc"
            ) from exc

        self._torch = torch
        torch.set_num_threads(threads)
        self._model = Wav2Vec2ForCTC.from_pretrained(model_dir, local_files_only=True).eval()

    def log_probs(self, samples: np.ndarray) -> np.ndarray:
        with self._torch.inference_mode():
            inputs = self._torch.from_numpy(normalize(samples)[None, :].astype(np.float32))
            logits = self._model(inputs).logits[0].float().numpy()
        return log_softmax(logits)


def make_backend(c: Candidate, model_dir: Path, threads: int) -> Backend:
    if c.backend == "onnx":
        assert c.onnx_file is not None
        return OnnxBackend(model_dir, c.onnx_file, threads)
    return TorchBackend(model_dir, threads)


def align_prediction(
    samples: np.ndarray, words: list[dict[str, Any]], backend: Backend, vocab: CtcVocab
) -> tuple[list[dict[str, Any]], dict[str, int], float]:
    audio_sec = len(samples) / SAMPLE_RATE
    windows = plan_windows([(w["start"], w["end"]) for w in words], audio_sec=audio_sec)

    output = [dict(w, aligned=False) for w in words]
    windows_count = 0
    failed_windows = 0
    aligned_words = 0

    start_time = time.perf_counter()
    for win in windows:
        windows_count += 1
        start_sample = round(win.start_sec * SAMPLE_RATE)
        end_sample = round(win.end_sec * SAMPLE_RATE)
        chunk = samples[start_sample:end_sample]
        lp = backend.log_probs(chunk)
        texts = [words[i]["text"] for i in win.word_indices]
        spans = align_words(lp, texts, vocab, offset_sec=win.start_sec)
        window_failed = True
        for word_index, span in zip(win.word_indices, spans, strict=True):
            if span is None:
                continue
            window_failed = False
            output[word_index]["start"], output[word_index]["end"] = span
            output[word_index]["aligned"] = True
            aligned_words += 1
        if window_failed:
            failed_windows += 1
    runtime_sec = time.perf_counter() - start_time

    # Unaligned native words keep their Whisper times; a start == end one would
    # fail every metric's 0 <= start < end validation, so drop and count it.
    output, dropped = _drop_zero_duration(output)
    unaligned_words = len(words) - aligned_words
    stats = {
        "windows": windows_count,
        "failed_windows": failed_windows,
        "aligned_words": aligned_words,
        "unaligned_words": unaligned_words,
        "dropped_zero_duration": dropped,
    }
    return output, stats, runtime_sec


def _peak_rss_mb() -> float | None:
    """Process-wide RSS high-water mark in MiB; None where ``resource`` is missing (Windows)."""
    try:
        import resource
    except ImportError:
        return None
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss / 1024**2 if sys.platform == "darwin" else rss / 1024


def candidate_payload(
    c: Candidate,
    *,
    audio_sha256: str,
    words: list[dict[str, Any]],
    stats: dict[str, int],
    runtime_sec: float,
    load_sec: float,
    audio_sec: float,
    threads: int,
    model_dir: Path,
) -> dict[str, Any]:
    peak_rss_mb = _peak_rss_mb()
    provenance = {
        "model": c.hf_repo,
        "version": c.revision,
        "license": c.license,
        "settings": {
            "backend": c.backend,
            "onnx_file": c.onnx_file,
            "threads": threads,
            "sample_rate": SAMPLE_RATE,
            "max_gap_sec": 1.0,
            "max_window_sec": 20.0,
            "pad_sec": 0.5,
        },
        "runtime_sec": runtime_sec,
        "load_sec": load_sec,
        "audio_sec": audio_sec,
        "realtime_factor": runtime_sec / audio_sec if audio_sec else None,
        "peak_rss_mb": peak_rss_mb,
        "peak_rss_scope": "process",
        "alignment_stats": stats,
    }
    return {"audio_sha256": audio_sha256, "provenance": provenance, "words": words}


def agreement(
    reference: dict[str, Any], predictions: Mapping[str, dict[str, Any]], *, top: int = 20
) -> dict[str, Any]:
    shas = {reference["audio_sha256"], *(p["audio_sha256"] for p in predictions.values())}
    if len(shas) > 1:
        raise ValueError("agreement inputs must share audio_sha256")

    comparisons: dict[str, Any] = {}
    for label, prediction in predictions.items():
        ref_words, ref_dropped = _drop_zero_duration(reference["words"])
        pred_words, pred_dropped = _drop_zero_duration(prediction["words"])
        metrics = measure_word_boundaries(ref_words, pred_words)
        pairs = matched_word_pairs(ref_words, pred_words)
        ranked = sorted(
            pairs,
            key=lambda pair: max(
                abs(pair[0]["start"] - pair[1]["start"]) * 1000,
                abs(pair[0]["end"] - pair[1]["end"]) * 1000,
            ),
            reverse=True,
        )[:top]
        largest = [
            {
                "text": ref["text"],
                "reference": [ref["start"], ref["end"]],
                "prediction": [pred["start"], pred["end"]],
                "max_error_ms": max(
                    abs(ref["start"] - pred["start"]) * 1000, abs(ref["end"] - pred["end"]) * 1000
                ),
            }
            for ref, pred in ranked
        ]
        provenance = prediction.get("provenance") or {}
        comparisons[label] = {
            "dropped_zero_duration": {"reference": ref_dropped, "prediction": pred_dropped},
            "metrics": metrics.as_dict(),
            "largest_disagreements": largest,
            "runtime_sec": provenance.get("runtime_sec"),
            "realtime_factor": provenance.get("realtime_factor"),
        }
    return {"comparisons": comparisons}


def _drop_zero_duration(words: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    kept = [w for w in words if w["end"] > w["start"]]
    return kept, len(words) - len(kept)


def aggregate(reports: Sequence[dict[str, Any]]) -> dict[str, Any]:
    matched_total = 0
    reference_total = 0
    over_total = 0
    mae_weighted = 0.0
    start_weighted = 0.0
    end_weighted = 0.0
    runtime_total = 0.0
    audio_total = 0.0
    have_runtime = True
    for report in reports:
        metrics = report["metrics"]
        matched = metrics["matched_words"]
        matched_total += matched
        reference_total += metrics["reference_words"]
        over_total += metrics["words_over_150ms"]
        if matched and metrics.get("boundary_mae_ms") is not None:
            mae_weighted += metrics["boundary_mae_ms"] * matched
            start_weighted += (metrics.get("mean_start_error_ms") or 0.0) * matched
            end_weighted += (metrics.get("mean_end_error_ms") or 0.0) * matched
        provenance = report.get("provenance") or {}
        runtime_sec = provenance.get("runtime_sec")
        audio_sec = provenance.get("audio_sec")
        if runtime_sec is None or audio_sec is None:
            have_runtime = False
        else:
            runtime_total += runtime_sec
            audio_total += audio_sec

    return {
        "items": len(reports),
        "matched_words": matched_total,
        "reference_words": reference_total,
        "words_over_150ms": over_total,
        "boundary_mae_ms": mae_weighted / matched_total if matched_total else None,
        "mean_start_error_ms": start_weighted / matched_total if matched_total else None,
        "mean_end_error_ms": end_weighted / matched_total if matched_total else None,
        "runtime_sec": runtime_total if have_runtime else None,
        "audio_sec": audio_total if have_runtime else None,
        "realtime_factor": (runtime_total / audio_total) if have_runtime and audio_total else None,
    }


def run_suite(
    items: Sequence[BenchItem],
    candidates: Sequence[Candidate],
    *,
    runs_dir: Path,
    target: str = "",
    native_model: str = "base",
    threads: int = 4,
    model_dirs: Mapping[str, Path] | None = None,
    backend_factory: Any = make_backend,
    native: Any = native_prediction,
) -> dict[str, Any]:
    model_dirs = model_dirs or {}
    runs_dir.mkdir(parents=True, exist_ok=True)

    audio_paths: dict[str, Path] = {}
    native_payloads: dict[str, dict[str, Any]] = {}
    for item in items:
        if item.clip is not None:
            samples = load_audio(item.audio, item.clip)
            audio_path = runs_dir / f"{item.item_id}.wav"
            write_wav16(audio_path, samples)
        else:
            audio_path = item.audio
        audio_paths[item.item_id] = audio_path
        sha = sha256_file(audio_path)

        if item.words is not None:
            payload = json.loads(item.words.read_text(encoding="utf-8"))
            if payload["audio_sha256"] != sha:
                raise ValueError(f"{item.item_id}: native words audio_sha256 mismatch")
            native_payload = payload
        else:
            native_payload = {"audio_sha256": sha, **native(audio_path, native_model)}
        native_payloads[item.item_id] = native_payload
        write_json_atomic(runs_dir / f"{item.item_id}.native.json", native_payload)

    scored: dict[str, list[dict[str, Any]]] = {c.label: [] for c in candidates}
    agreements: dict[str, list[dict[str, Any]]] = {c.label: [] for c in candidates}

    for c in candidates:
        load_start = time.perf_counter()
        model_dir = resolve_model_dir(c, model_dirs.get(c.label))
        backend = backend_factory(c, model_dir, threads)
        load_sec = time.perf_counter() - load_start
        vocab = CtcVocab.from_token_map(json.loads((model_dir / "vocab.json").read_text()))

        for item in items:
            audio_path = audio_paths[item.item_id]
            samples = load_audio(audio_path, None)
            audio_sec = len(samples) / SAMPLE_RATE
            native_payload = native_payloads[item.item_id]
            words, stats, runtime_sec = align_prediction(
                samples, native_payload["words"], backend, vocab
            )
            prediction = candidate_payload(
                c,
                audio_sha256=native_payload["audio_sha256"],
                words=words,
                stats=stats,
                runtime_sec=runtime_sec,
                load_sec=load_sec,
                audio_sec=audio_sec,
                threads=threads,
                model_dir=model_dir,
            )
            pred_path = runs_dir / f"{item.item_id}.{c.label}.pred.json"
            write_json_atomic(pred_path, prediction)

            if item.gold is not None:
                report = benchmark(item.gold, prediction_path=pred_path, native_model=None)
                write_json_atomic(runs_dir / f"{item.item_id}.{c.label}.report.json", report)
                scored[c.label].append(report)

            native_words, _ = _drop_zero_duration(native_payload["words"])
            agreements[c.label].append(
                {
                    "metrics": measure_word_boundaries(native_words, prediction["words"]).as_dict(),
                    "provenance": prediction["provenance"],
                }
            )

        # Free the ONNX session / torch model before the next candidate loads.
        del backend
        gc.collect()

    for item in items:
        native_payload = native_payloads[item.item_id]
        candidate_list = list(candidates)
        predictions = {
            c.label: json.loads(
                (runs_dir / f"{item.item_id}.{c.label}.pred.json").read_text(encoding="utf-8")
            )
            for c in candidate_list
        }
        report = agreement(native_payload, predictions) if predictions else {"comparisons": {}}
        if len(candidate_list) > 1:
            base_label = candidate_list[0].label
            others = {c.label: predictions[c.label] for c in candidate_list[1:]}
            pairwise = agreement(predictions[base_label], others)
            report["comparisons"].update(
                {f"{base_label}~{label}": entry for label, entry in pairwise["comparisons"].items()}
            )
        write_json_atomic(runs_dir / f"{item.item_id}.agree.json", report)

    summary = {
        "target": target,
        "items": [item.item_id for item in items],
        "scored": {label: aggregate(reports) for label, reports in scored.items() if reports},
        "agreement": {
            label: aggregate(
                [
                    {"metrics": entry["metrics"], "provenance": entry["provenance"]}
                    for entry in reports
                ]
            )
            for label, reports in agreements.items()
        },
    }
    write_json_atomic(runs_dir / "summary.json", summary)
    for label, agg in summary["scored"].items():
        print(f"{label} scored: {json.dumps(agg)}")
    for label, agg in summary["agreement"].items():
        print(f"{label} agreement: {json.dumps(agg)}")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    plan_cmd = sub.add_parser("plan")
    plan_cmd.add_argument("--target", required=True, choices=TARGETS)
    plan_cmd.add_argument("--lab", type=Path)
    plan_cmd.add_argument("--lab-glob", default=DEFAULT_LAB_GLOB)
    plan_cmd.add_argument("--clip-sec", type=float, default=60.0)

    run_cmd = sub.add_parser("run")
    run_cmd.add_argument("--target", required=True, choices=TARGETS)
    run_cmd.add_argument("--lab", type=Path)
    run_cmd.add_argument("--lab-glob", default=DEFAULT_LAB_GLOB)
    run_cmd.add_argument("--clip-sec", type=float, default=60.0)
    run_cmd.add_argument("--runs-dir", type=Path)
    run_cmd.add_argument("--candidate", action="append", dest="candidates")
    run_cmd.add_argument("--model-dir", action="append", dest="model_dirs", default=[])
    run_cmd.add_argument("--native-model", default="base")
    run_cmd.add_argument("--threads", type=int, default=4)

    agree_cmd = sub.add_parser("agree")
    agree_cmd.add_argument("--reference", type=Path, required=True)
    agree_cmd.add_argument("--prediction", action="append", dest="predictions", required=True)
    agree_cmd.add_argument("--top", type=int, default=20)
    agree_cmd.add_argument("--output", type=Path, required=True)

    dl_cmd = sub.add_parser("download-commands")
    dl_cmd.add_argument("--candidate", action="append", dest="candidates")

    args = parser.parse_args(argv)

    if args.command == "plan":
        items = resolve_target(
            args.target, lab=args.lab, lab_glob=args.lab_glob, clip_sec=args.clip_sec
        )
        print(json.dumps([asdict(i) for i in items], default=str, indent=2))
        return 0

    if args.command == "run":
        items = resolve_target(
            args.target, lab=args.lab, lab_glob=args.lab_glob, clip_sec=args.clip_sec
        )
        runs_dir = resolve_runs_dir(args.target, args.runs_dir, args.lab)
        candidates = load_candidates(labels=args.candidates)
        model_dirs = {}
        for entry in args.model_dirs:
            label, _, path = entry.partition("=")
            model_dirs[label] = Path(path)
        run_suite(
            items,
            candidates,
            runs_dir=runs_dir,
            target=args.target,
            native_model=args.native_model,
            threads=args.threads,
            model_dirs=model_dirs,
        )
        return 0

    if args.command == "agree":
        reference = json.loads(args.reference.read_text(encoding="utf-8"))
        predictions = {}
        for entry in args.predictions:
            label, _, path = entry.partition("=")
            predictions[label] = json.loads(Path(path).read_text(encoding="utf-8"))
        result = agreement(reference, predictions, top=args.top)
        write_json_atomic(args.output, result)
        print(json.dumps(result))
        return 0

    if args.command == "download-commands":
        candidates = load_candidates(labels=args.candidates)
        for c in candidates:
            print(download_command(c))
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
