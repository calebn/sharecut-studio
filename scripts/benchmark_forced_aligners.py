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
from fnmatch import fnmatch
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any

import numpy as np

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from benchmark_word_boundaries import benchmark, native_prediction
from podcast_mcp.engines.ctc_forced_align import (
    DEFAULT_MAX_GAP_SEC,
    DEFAULT_MAX_WINDOW_SEC,
    DEFAULT_PAD_SEC,
    CtcVocab,
    LogProbBackend,
    log_softmax,
    normalize_waveform,
    retime_spans,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.word_align import DEFAULT_ALIGNER_THREADS, OnnxCtcBackend, apply_word_spans
from podcast_mcp.engines.word_boundary_metrics import (
    matched_word_pairs,
    measure_word_boundaries,
    word_duration_profile,
)
from podcast_mcp.models.episode import TranscriptWord
from podcast_mcp.util.atomic_json import write_bytes_atomic, write_json_atomic
from podcast_mcp.util.file_locks import shared_file_lock
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.wav import pcm_wav_header
from podcast_mcp.word_aligner_models import DEFAULT_WORD_ALIGNER

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
CANDIDATES = FIXTURES / "word_boundary" / "candidates.json"
SAMPLE_RATE = 16_000
DEFAULT_LAB = Path("~/projects/ShareCut_Podcast_Test")
DEFAULT_LAB_GLOB = "source/zoom_excerpt_pan/audio*.m4a"
TARGETS = ("librispeech", "aligned_dialogue", "lab")
PIPELINE_TARGETS = ("librispeech", "lab")  # aligned_dialogue has zero native words (#715)

# #715: how long prepare_items waits for another pass's <id>.native.lock (held
# across one item's cache check, Whisper run and write): long enough for a slow
# Whisper pass on one lab clip, bounded so a stuck holder fails instead of hanging.
NATIVE_CACHE_LOCK_TIMEOUT_SEC = 3600.0

# #715: the shipped production pass (WordAligner.load -> WordAligner.align ->
# apply_word_spans, i.e. exactly what transcribe.py's _align_words drives), scored
# against the same native words the #638/#641 harness candidates used. Not
# "pipeline-onnx-base": the #641 checked-in-report test globs "*.onnx-base.json",
# and this label must not match that glob.
PIPELINE_LABEL = f"{DEFAULT_WORD_ALIGNER}-pipeline"
PIPELINE_PASS = "pipeline"
# Never "summary.json": run_suite writes that (a different schema) to the same
# default runs dir, $LAB_RUNS_DIR/align/<target>.
PIPELINE_SUMMARY = f"summary.{PIPELINE_LABEL}.json"


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


def verify_candidate(c: Candidate, api: Any, *, notes: list[str] | None = None) -> list[str]:
    """Problems with one pinned candidate on the Hub (metadata only; never downloads weights).

    Advisories that are not drift (a model card with no declared license) are appended
    to ``notes`` when it is given, so the caller can print them without failing.
    """
    import httpx
    from huggingface_hub.errors import (
        GatedRepoError,
        HfHubHTTPError,
        RepositoryNotFoundError,
        RevisionNotFoundError,
    )

    pin = f"revision {c.revision} of {c.hf_repo}"
    try:
        info = api.model_info(c.hf_repo, revision=c.revision)
    except GatedRepoError as exc:
        # GatedRepoError subclasses RepositoryNotFoundError, so match it first:
        # the caller lacks a token or has not accepted the terms; the pin may be fine.
        return [
            f"{c.label}: {pin} is gated: needs an HF token / accepted terms "
            f"({type(exc).__name__}: {exc})"
        ]
    except (RevisionNotFoundError, RepositoryNotFoundError) as exc:
        return [f"{c.label}: {pin} no longer resolves ({type(exc).__name__}: {exc})"]
    except (HfHubHTTPError, httpx.TransportError) as exc:
        # Rate limits (429), Hub outages (5xx), connection errors and timeouts
        # say nothing about the pin; report without claiming drift.
        return [f"{c.label}: could not verify {pin} ({type(exc).__name__}: {exc})"]
    problems = []
    if info.sha != c.revision:
        problems.append(f"{c.label}: revision resolves to {info.sha}, pinned {c.revision}")
    card_license = getattr(info.card_data, "license", None)
    # An undeclared card license (None) is not evidence the model changed: the Hub
    # never recorded one for this repo (e.g. onnx-community/wav2vec2-base-960h-ONNX,
    # pinned apache-2.0 from its upstream facebook/wav2vec2-base-960h). Only a
    # *stated* license that disagrees with the pin is drift; an undeclared one is a
    # note, so the pin is never reported as verified without saying so.
    if card_license is None:
        if notes is not None:
            notes.append(
                f"{c.label}: model card declares no license; pinned {c.license!r} not verified"
            )
    elif card_license != c.license:
        problems.append(f"{c.label}: model card license {card_license!r}, pinned {c.license!r}")
    names = [s.rfilename for s in (info.siblings or [])]
    for pattern in c.allow_patterns:
        if not any(fnmatch(name, pattern) for name in names):
            problems.append(f"{c.label}: no file matches {pattern!r} at {c.revision}")
    return problems


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
            inputs = self._torch.from_numpy(normalize_waveform(samples)[None, :].astype(np.float32))
            logits = self._model(inputs).logits[0].float().numpy()
        return log_softmax(logits)


def make_backend(c: Candidate, model_dir: Path, threads: int) -> LogProbBackend:
    if c.backend == "onnx":
        assert c.onnx_file is not None
        return OnnxCtcBackend(model_dir / c.onnx_file, threads=threads)
    return TorchBackend(model_dir, threads)


def align_prediction(
    samples: np.ndarray, words: list[dict[str, Any]], backend: LogProbBackend, vocab: CtcVocab
) -> tuple[list[dict[str, Any]], dict[str, int], float]:
    start_time = time.perf_counter()
    spans, retime = retime_spans(
        samples,
        [(w["text"], w["start"], w["end"]) for w in words],
        backend,
        vocab,
        sample_rate=SAMPLE_RATE,
    )
    runtime_sec = time.perf_counter() - start_time
    output = [dict(w, aligned=False) for w in words]
    for word, span in zip(output, spans, strict=True):
        if span is not None:
            word["start"], word["end"] = span
            word["aligned"] = True
    # Unaligned native words keep their Whisper times; a start == end one would
    # fail every metric's 0 <= start < end validation, so drop and count it.
    output, dropped = _drop_zero_duration(output)
    return output, {**retime.as_dict(), "dropped_zero_duration": dropped}, runtime_sec


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
            "max_gap_sec": DEFAULT_MAX_GAP_SEC,
            "max_window_sec": DEFAULT_MAX_WINDOW_SEC,
            "pad_sec": DEFAULT_PAD_SEC,
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
        # Harness-written preds already dropped theirs in align_prediction();
        # report the per-side total so agree.json matches alignment_stats.
        ref_dropped += _dropped_upstream(reference)
        pred_dropped += _dropped_upstream(prediction)
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


def _dropped_upstream(payload: Mapping[str, Any]) -> int:
    """Zero-duration words the harness dropped before writing ``payload`` (0 when none recorded)."""
    stats = (payload.get("provenance") or {}).get("alignment_stats") or {}
    return int(stats.get("dropped_zero_duration", 0))


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
    # All-or-nothing: one report without runtime_sec/audio_sec blanks the
    # runtime totals rather than averaging a partial, skewed subset.
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


def _cached_native(path: Path, audio_sha256: str, native_model: str) -> dict[str, Any] | None:
    """An earlier pass's ``<id>.native.json`` for this audio, or ``None`` to run Whisper afresh.

    A file for different audio (``audio_sha256`` mismatch) is a soft miss: its
    words are stale, so the caller re-runs Whisper and overwrites it. A file for
    this audio with no ``provenance.model``, from a different ``--native-model``,
    or (for faster-whisper words)
    from a different installed faster-whisper version, raises instead: an earlier
    pass's ``<id>.<label>.pred.json`` in the same runs dir was built from those
    words, and overwriting them would silently pair mismatched native words with
    those predictions. The caller (:func:`prepare_items`) holds the item's
    ``<id>.native.lock`` across this check, the Whisper run and the write, so two
    passes started together into one runs dir cannot both miss and overwrite
    each other.

    Deliberately not shared with the checked-in fixture check in
    :func:`prepare_items` (which raises on an audio mismatch) or
    ``engines.transcribe._read_json_cache`` (a production-engine helper with its
    own error handling): the three differ in what a mismatch means.
    """
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("audio_sha256") != audio_sha256:
        return None
    provenance = payload.get("provenance") or {}
    cached_model = provenance.get("model")
    if cached_model is None:
        raise ValueError(
            f"{path} holds native words with no provenance.model; use another "
            "--runs-dir or delete the file to re-run Whisper"
        )
    if cached_model != native_model:
        raise ValueError(
            f"{path} holds native words from Whisper model {cached_model!r}, not "
            f"{native_model!r}; pass --native-model {cached_model}, use another "
            "--runs-dir, or delete the file to re-run Whisper"
        )
    if provenance.get("library") == "faster-whisper":
        installed = package_version("faster-whisper")
        cached_version = provenance.get("library_version")
        if cached_version != installed:
            raise ValueError(
                f"{path} holds native words from faster-whisper {cached_version}, but "
                f"{installed} is installed; use another --runs-dir or delete the file "
                "to re-run Whisper"
            )
    return payload


def prepare_items(
    items: Sequence[BenchItem],
    *,
    runs_dir: Path,
    native_model: str = "base",
    native: Any = native_prediction,
) -> tuple[dict[str, Path], dict[str, dict[str, Any]]]:
    """Decode each item's audio and resolve its native words, shared by every pass.

    A clipped item (``item.clip`` set) decodes its window and writes it as
    ``<id>.wav`` under ``runs_dir``; a full item uses its audio path as-is. Native
    words come from ``item.words`` when set (checked-in fixtures, e.g.
    LibriSpeech's ``*.native-base.json``); otherwise from ``<id>.native.json``
    already in ``runs_dir`` for the same ``audio_sha256`` (an earlier ``run`` or
    ``pipeline`` into the same dir); otherwise from a fresh ``native(...)``
    (Whisper) run. A cached file for the same audio but another ``native_model``
    or faster-whisper version raises (see :func:`_cached_native`) rather than
    being overwritten. The result is written as ``<id>.native.json``, so a
    ``run_suite`` and a ``run_pipeline_pass`` pointed at the same ``runs_dir``
    score the exact same native words and audio. Each item's check, Whisper run
    and write hold ``<id>.native.lock`` in ``runs_dir``
    (``util.file_locks.shared_file_lock``, up to ``NATIVE_CACHE_LOCK_TIMEOUT_SEC``),
    so a pass started while another is resolving the same item waits for it and
    then reuses its words. Delete ``<id>.native.json`` to force a fresh Whisper
    pass.
    """
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
        native_path = runs_dir / f"{item.item_id}.native.json"
        lock = shared_file_lock(
            runs_dir / f"{item.item_id}.native.lock", timeout=NATIVE_CACHE_LOCK_TIMEOUT_SEC
        )
        with lock:
            if item.words is not None:
                payload = json.loads(item.words.read_text(encoding="utf-8"))
                if payload["audio_sha256"] != sha:
                    raise ValueError(f"{item.item_id}: native words audio_sha256 mismatch")
                native_payload = payload
            else:
                cached = _cached_native(native_path, sha, native_model)
                native_payload = (
                    cached
                    if cached is not None
                    else {"audio_sha256": sha, **native(audio_path, native_model)}
                )
            write_json_atomic(native_path, native_payload)
        native_payloads[item.item_id] = native_payload
    return audio_paths, native_payloads


def _record_item(
    item: BenchItem,
    prediction: dict[str, Any],
    *,
    runs_dir: Path,
    label: str,
    native_payload: Mapping[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Write one item's prediction, score it against gold, and measure agreement vs native.

    Shared by :func:`run_suite` and :func:`run_pipeline_pass`; only the prediction
    source differs. Writes ``<id>.<label>.pred.json`` and, for gold items,
    ``<id>.<label>.report.json``. Returns ``(report or None, agreement entry)``.
    """
    pred_path = runs_dir / f"{item.item_id}.{label}.pred.json"
    write_json_atomic(pred_path, prediction)
    report = None
    if item.gold is not None:
        report = benchmark(item.gold, prediction_path=pred_path, native_model=None)
        write_json_atomic(runs_dir / f"{item.item_id}.{label}.report.json", report)
    native_words, _ = _drop_zero_duration(native_payload["words"])
    entry = {
        "metrics": measure_word_boundaries(native_words, prediction["words"]).as_dict(),
        "provenance": prediction["provenance"],
    }
    return report, entry


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
    audio_paths, native_payloads = prepare_items(
        items, runs_dir=runs_dir, native_model=native_model, native=native
    )

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
            report, entry = _record_item(
                item, prediction, runs_dir=runs_dir, label=c.label, native_payload=native_payload
            )
            if report is not None:
                scored[c.label].append(report)
            agreements[c.label].append(entry)

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


def pipeline_prediction(
    audio_path: Path, native_words: Sequence[dict[str, Any]], aligner: Any
) -> tuple[list[dict[str, Any]], dict[str, int], float]:
    """Score the shipped production pass, not the harness's own align_prediction().

    Drives the exact call chain ``transcribe.py``'s ``_align_words`` uses:
    ``TranscriptWord`` -> ``WordAligner.align`` -> ``apply_word_spans``. ``aligner``
    is a real ``WordAligner`` (or, in tests, a stand-in with the same ``.align``
    signature).
    """
    words = [TranscriptWord(text=w["text"], start=w["start"], end=w["end"]) for w in native_words]
    result = aligner.align(audio_path, words)
    apply_word_spans(words, result.spans)
    output = [
        {"text": w.text, "start": w.start, "end": w.end, "aligned": span is not None}
        for w, span in zip(words, result.spans, strict=True)
    ]
    output, dropped = _drop_zero_duration(output)
    stats = {**result.stats.as_dict(), "dropped_zero_duration": dropped}
    return output, stats, result.runtime_sec


def _asr_runtime_total(
    items: Sequence[BenchItem], native_payloads: Mapping[str, dict[str, Any]]
) -> float | None:
    """Recorded Whisper ``runtime_sec`` summed over items with no checked-in native words.

    Includes words reused from a cached ``<id>.native.json`` (the time recorded by
    the pass that produced them). ``None`` when every item reused checked-in
    native words (e.g. ``librispeech``), since no ASR ran for them.
    """
    fresh = [native_payloads[item.item_id] for item in items if item.words is None]
    if not fresh:
        return None
    total = 0.0
    for payload in fresh:
        runtime_sec = (payload.get("provenance") or {}).get("runtime_sec")
        if runtime_sec is None:
            return None
        total += runtime_sec
    return total


def run_pipeline_pass(
    items: Sequence[BenchItem],
    *,
    runs_dir: Path,
    target: str,
    native_model: str = "base",
    threads: int | None = None,
    aligner: Any = None,
    native: Any = native_prediction,
) -> dict[str, Any]:
    """Score the shipped pass (see :func:`pipeline_prediction`) and profile word durations.

    Writes ``<id>.<PIPELINE_LABEL>.pred.json`` / ``.report.json`` (gold items only)
    and ``PIPELINE_SUMMARY`` (``summary.onnx-base-pipeline.json``) under ``runs_dir``,
    so it never replaces the ``summary.json`` that ``run_suite`` writes to the same dir.
    ``aligner`` defaults to a real, threads-pinned ``WordAligner.load()``;
    tests inject a stand-in so they never touch the network or the ONNX runtime.
    """
    audio_paths, native_payloads = prepare_items(
        items, runs_dir=runs_dir, native_model=native_model, native=native
    )

    load_start = time.perf_counter()
    if aligner is None:
        from podcast_mcp.engines.word_align import WordAligner

        aligner = WordAligner.load(threads=threads)
    load_sec = time.perf_counter() - load_start

    scored: list[dict[str, Any]] = []
    agreements: list[dict[str, Any]] = []
    duration_profiles: dict[str, Any] = {}
    align_runtime_total = 0.0
    model = getattr(aligner, "model", None)
    for item in items:
        audio_path = audio_paths[item.item_id]
        native_payload = native_payloads[item.item_id]
        words, stats, runtime_sec = pipeline_prediction(
            audio_path, native_payload["words"], aligner
        )
        align_runtime_total += runtime_sec
        audio_sec = len(load_audio(audio_path, None)) / SAMPLE_RATE
        prediction = candidate_payload(
            Candidate(
                label=PIPELINE_LABEL,
                backend="onnx",
                hf_repo=getattr(model, "hf_repo", ""),
                revision=getattr(model, "revision", ""),
                allow_patterns=(),
                license=getattr(model, "license", "") or "unknown",
                onnx_file=getattr(model, "onnx_file", None),
            ),
            audio_sha256=native_payload["audio_sha256"],
            words=words,
            stats=stats,
            runtime_sec=runtime_sec,
            load_sec=load_sec,
            audio_sec=audio_sec,
            threads=threads or DEFAULT_ALIGNER_THREADS,
            model_dir=Path("."),
        )
        prediction["provenance"]["settings"]["pass"] = PIPELINE_PASS
        report, entry = _record_item(
            item, prediction, runs_dir=runs_dir, label=PIPELINE_LABEL, native_payload=native_payload
        )
        if report is not None:
            scored.append(report)
        agreements.append(entry)
        duration_profiles[item.item_id] = word_duration_profile(prediction["words"]).as_dict()

    summary = {
        "target": target,
        "label": PIPELINE_LABEL,
        "items": [item.item_id for item in items],
        "scored": aggregate(scored) if scored else None,
        "agreement": aggregate(agreements),
        "load_sec": load_sec,
        "asr_runtime_sec": _asr_runtime_total(items, native_payloads),
        "align_runtime_sec": align_runtime_total,
        "duration_profile": duration_profiles,
    }
    write_json_atomic(runs_dir / PIPELINE_SUMMARY, summary)
    print(f"{PIPELINE_LABEL} scored: {json.dumps(summary['scored'])}")
    print(f"{PIPELINE_LABEL} agreement: {json.dumps(summary['agreement'])}")
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

    pipeline_cmd = sub.add_parser("pipeline")
    pipeline_cmd.add_argument("--target", required=True, choices=PIPELINE_TARGETS)
    pipeline_cmd.add_argument("--lab", type=Path)
    pipeline_cmd.add_argument("--lab-glob", default=DEFAULT_LAB_GLOB)
    pipeline_cmd.add_argument("--clip-sec", type=float, default=60.0)
    pipeline_cmd.add_argument("--runs-dir", type=Path)
    pipeline_cmd.add_argument("--native-model", default="base")
    pipeline_cmd.add_argument("--threads", type=int)

    agree_cmd = sub.add_parser("agree")
    agree_cmd.add_argument("--reference", type=Path, required=True)
    agree_cmd.add_argument("--prediction", action="append", dest="predictions", required=True)
    agree_cmd.add_argument("--top", type=int, default=20)
    agree_cmd.add_argument("--output", type=Path, required=True)

    dl_cmd = sub.add_parser("download-commands")
    dl_cmd.add_argument("--candidate", action="append", dest="candidates")

    verify_cmd = sub.add_parser("verify-candidates")
    verify_cmd.add_argument("--candidate", action="append", dest="candidates")

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

    if args.command == "pipeline":
        items = resolve_target(
            args.target, lab=args.lab, lab_glob=args.lab_glob, clip_sec=args.clip_sec
        )
        runs_dir = resolve_runs_dir(args.target, args.runs_dir, args.lab)
        run_pipeline_pass(
            items,
            runs_dir=runs_dir,
            target=args.target,
            native_model=args.native_model,
            threads=args.threads,
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

    if args.command == "verify-candidates":
        from huggingface_hub import HfApi

        api = HfApi()
        notes: list[str] = []
        problems = [
            problem
            for c in load_candidates(labels=args.candidates)
            for problem in verify_candidate(c, api, notes=notes)
        ]
        for note in notes:
            print(f"note: {note}")
        for problem in problems:
            print(problem)
        if not problems:
            print("no drift found (see notes above)" if notes else "all candidates verified")
        return 1 if problems else 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
