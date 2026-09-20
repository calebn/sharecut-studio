#!/usr/bin/env python3
"""Compare faster-whisper vs whisper.cpp on fixture audio (timings + WER)."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.engines.whisper_cpp import (
    resolve_model_path,
    resolve_whisper_cli,
    transcribe_file_whisper_cpp,
)
from podcast_mcp.models.episode import Transcript
from podcast_mcp.util.wer import (
    accuracy_for_track,
    clip_words_to_duration,
    load_fixture_transcripts,
    load_ground_truth_words,
    tokens_from_words,
    word_error_rate,
)


@dataclass
class TrackResult:
    track: str
    backend: str
    elapsed_sec: float
    word_count: int
    error: str | None = None
    wer: float | None = None
    wer_errors: int | None = None
    reference_word_count: int | None = None
    reference_text: str | None = None
    hypothesis_text: str | None = None
    hypothesis_text_full: str | None = None


def _fixture_audio(fixture: Path) -> list[tuple[str, Path]]:
    raw = fixture / "raw"
    if (raw / "reference.wav").is_file():
        return [
            ("reference", raw / "reference.wav"),
            ("guest", raw / "guest.wav"),
        ]
    pairs: list[tuple[str, Path]] = []
    for path in sorted(raw.glob("*.wav")):
        if path.stem.endswith("_stereo_backup"):
            continue
        pairs.append((path.stem, path))
    return pairs


def _audio_for_run(
    audio: Path, *, max_duration_sec: float | None
) -> tuple[Path, tempfile.TemporaryDirectory | None]:
    if max_duration_sec is None:
        return audio, None
    tmp = tempfile.TemporaryDirectory(prefix="benchmark-audio-")
    out = Path(tmp.name) / audio.name
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(audio),
            "-t",
            str(max_duration_sec),
            "-c",
            "copy",
            str(out),
        ],
        check=True,
    )
    return out, tmp


def _with_accuracy(
    result: TrackResult,
    *,
    track_id: str,
    transcript: Transcript | None,
    ground_truth: dict[str, list] | None,
) -> TrackResult:
    if transcript is None or not ground_truth or track_id not in ground_truth:
        return result
    acc = accuracy_for_track(
        track_id=track_id,
        reference_words=ground_truth[track_id],
        hypothesis=transcript,
    )
    full_text = " ".join(tokens_from_words(transcript.words))
    return TrackResult(
        track=result.track,
        backend=result.backend,
        elapsed_sec=result.elapsed_sec,
        word_count=result.word_count,
        error=result.error,
        wer=acc.wer,
        wer_errors=acc.errors,
        reference_word_count=acc.reference_count,
        reference_text=acc.reference_text,
        hypothesis_text=acc.hypothesis_text,
        hypothesis_text_full=full_text or None,
    )


def benchmark_faster_whisper(
    audio: Path,
    *,
    model_size: str,
    language: str,
    warmup: bool,
    ground_truth: dict[str, list] | None,
) -> TrackResult:
    engine = TranscriptionEngine(model_size=model_size, device="cpu")
    label = f"faster-whisper/{model_size}"
    try:
        if warmup:
            engine.transcribe_file(audio, language=language)
        t0 = time.perf_counter()
        tr = engine.transcribe_file(audio, language=language)
        elapsed = time.perf_counter() - t0
        result = TrackResult(
            track=audio.stem,
            backend=label,
            elapsed_sec=round(elapsed, 3),
            word_count=len(tr.words),
            hypothesis_text_full=" ".join(tokens_from_words(tr.words)) or None,
        )
        return _with_accuracy(result, track_id=audio.stem, transcript=tr, ground_truth=ground_truth)
    except Exception as exc:
        return TrackResult(
            track=audio.stem,
            backend=label,
            elapsed_sec=0.0,
            word_count=0,
            error=str(exc),
        )


def benchmark_whisper_cpp(
    audio: Path,
    *,
    model: str,
    language: str,
    warmup: bool,
    ground_truth: dict[str, list] | None,
) -> TrackResult:
    label = f"whisper.cpp/{model}"
    try:
        if warmup:
            transcribe_file_whisper_cpp(audio, language=language, model=model)
        t0 = time.perf_counter()
        tr = transcribe_file_whisper_cpp(audio, language=language, model=model)
        elapsed = time.perf_counter() - t0
        result = TrackResult(
            track=audio.stem,
            backend=label,
            elapsed_sec=round(elapsed, 3),
            word_count=len(tr.words),
            hypothesis_text_full=" ".join(tokens_from_words(tr.words)) or None,
        )
        return _with_accuracy(result, track_id=audio.stem, transcript=tr, ground_truth=ground_truth)
    except Exception as exc:
        return TrackResult(
            track=audio.stem,
            backend=label,
            elapsed_sec=0.0,
            word_count=0,
            error=str(exc),
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture",
        type=Path,
        default=_REPO / "tests" / "fixtures" / "aligned_dialogue",
        help="Fixture workspace with raw/*.wav",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="JSON report path (default: fixture/artifacts/transcribe_benchmark.json)",
    )
    parser.add_argument(
        "--faster-whisper-model",
        default="base",
        help="faster-whisper model size (default: base)",
    )
    parser.add_argument(
        "--whisper-cpp-model",
        default="ggml-base.en.bin",
        help="whisper.cpp ggml model filename in cache",
    )
    parser.add_argument(
        "--language",
        default="en",
    )
    parser.add_argument(
        "--warmup",
        action="store_true",
        help="Run one untimed pass before each timed run",
    )
    parser.add_argument(
        "--skip-whisper-cpp",
        action="store_true",
    )
    parser.add_argument(
        "--skip-faster-whisper",
        action="store_true",
    )
    parser.add_argument(
        "--ground-truth",
        type=Path,
        default=None,
        help="Reference transcript JSON (per_track or single-track format)",
    )
    parser.add_argument(
        "--ground-truth-from-fixture",
        action="store_true",
        help="Use fixture transcripts/*.json as reference (real speech episodes)",
    )
    parser.add_argument(
        "--max-duration",
        type=float,
        default=None,
        help="Only transcribe the first N seconds of each track",
    )
    parser.add_argument(
        "--skip-accuracy",
        action="store_true",
        help="Skip WER against ground-truth transcript",
    )
    args = parser.parse_args()

    fixture = args.fixture.resolve()
    out = args.output or (fixture / "artifacts" / "transcribe_benchmark.json")
    out.parent.mkdir(parents=True, exist_ok=True)

    ground_truth = None
    ground_truth_source = None
    if not args.skip_accuracy:
        if args.ground_truth_from_fixture:
            ground_truth = load_fixture_transcripts(fixture)
            ground_truth_source = str(fixture / "transcripts")
        elif args.ground_truth:
            gt_path = args.ground_truth.resolve()
            if gt_path.is_file():
                ground_truth = load_ground_truth_words(gt_path)
                ground_truth_source = str(gt_path)
            else:
                print(f"ground truth missing: {gt_path}", file=sys.stderr)
        else:
            canned = _REPO / "tests" / "fixtures" / "canned_transcript_aligned.json"
            if canned.is_file():
                ground_truth = load_ground_truth_words(canned)
                ground_truth_source = str(canned)

    if ground_truth and args.max_duration:
        ground_truth = {
            track: clip_words_to_duration(words, args.max_duration)
            for track, words in ground_truth.items()
        }

    tracks = _fixture_audio(fixture)
    results: list[TrackResult] = []
    env: dict[str, str | None] = {
        "whisper_cli": None,
        "whisper_cpp_model": None,
        "faster_whisper_model": args.faster_whisper_model,
    }

    try:
        env["whisper_cli"] = str(resolve_whisper_cli())
        env["whisper_cpp_model"] = str(resolve_model_path(args.whisper_cpp_model))
    except FileNotFoundError as exc:
        if not args.skip_whisper_cpp:
            print(f"whisper.cpp unavailable: {exc}", file=sys.stderr)

    temp_dirs: list[tempfile.TemporaryDirectory] = []
    try:
        for name, audio in tracks:
            if not audio.is_file():
                print(f"skip missing {audio}", file=sys.stderr)
                continue
            run_audio, tmp = _audio_for_run(audio, max_duration_sec=args.max_duration)
            if tmp is not None:
                temp_dirs.append(tmp)
            track_id = name
            print(f"=== {name} ({audio.name}) ===")
            if not args.skip_faster_whisper:
                print("  faster-whisper...", flush=True)
                r = benchmark_faster_whisper(
                    run_audio,
                    model_size=args.faster_whisper_model,
                    language=args.language,
                    warmup=args.warmup,
                    ground_truth=ground_truth,
                )
                r.track = track_id
                results.append(r)
                print(f"    {r.elapsed_sec}s words={r.word_count}{_wer_suffix(r)}")
            if not args.skip_whisper_cpp and env["whisper_cli"]:
                print("  whisper.cpp...", flush=True)
                r = benchmark_whisper_cpp(
                    run_audio,
                    model=args.whisper_cpp_model,
                    language=args.language,
                    warmup=args.warmup,
                    ground_truth=ground_truth,
                )
                r.track = track_id
                results.append(r)
                print(f"    {r.elapsed_sec}s words={r.word_count}{_wer_suffix(r)}")
    finally:
        for tmp in temp_dirs:
            tmp.cleanup()

    cross_wer = _cross_backend_wer(results)
    report = {
        "created_at": datetime.now(UTC).isoformat(),
        "fixture": str(fixture),
        "ground_truth": ground_truth_source,
        "max_duration_sec": args.max_duration,
        "environment": env,
        "results": [asdict(r) for r in results],
        "summary": _summarize(results, cross_wer=cross_wer),
    }
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nWrote {out}")
    _print_summary(report["summary"])
    return 0


def _cross_backend_wer(results: list[TrackResult]) -> list[dict]:
    by_track: dict[str, dict[str, str]] = {}
    for result in results:
        if result.error or not result.hypothesis_text_full:
            continue
        by_track.setdefault(result.track, {})[result.backend] = result.hypothesis_text_full
    out: list[dict] = []
    for track, hyps in sorted(by_track.items()):
        backends = list(hyps.keys())
        if len(backends) < 2:
            continue
        a_backend, b_backend = backends[0], backends[1]
        a_tokens = hyps[a_backend].split()
        b_tokens = hyps[b_backend].split()
        ab = word_error_rate(a_tokens, b_tokens)
        ba = word_error_rate(b_tokens, a_tokens)
        out.append(
            {
                "track": track,
                "backend_a": a_backend,
                "backend_b": b_backend,
                "wer_a_vs_b": ab.wer,
                "wer_b_vs_a": ba.wer,
                "mean_wer": round(((ab.wer or 0) + (ba.wer or 0)) / 2, 4),
                "text_a": hyps[a_backend],
                "text_b": hyps[b_backend],
            }
        )
    return out


def _wer_suffix(result: TrackResult) -> str:
    if result.wer is None:
        return ""
    pct = round(result.wer * 100, 1)
    return f" WER={pct}% ({result.wer_errors}/{result.reference_word_count})"


def _summarize(results: list[TrackResult], *, cross_wer: list[dict] | None = None) -> dict:
    by_backend: dict[str, list[float]] = {}
    wer_by_backend: dict[str, list[tuple[int, int]]] = {}
    for r in results:
        if r.error:
            continue
        by_backend.setdefault(r.backend, []).append(r.elapsed_sec)
        if r.wer is not None and r.reference_word_count:
            wer_by_backend.setdefault(r.backend, []).append(
                (r.wer_errors or 0, r.reference_word_count)
            )
    totals = {backend: round(sum(times), 3) for backend, times in by_backend.items()}
    ratio = None
    keys = list(totals.keys())
    if len(keys) == 2:
        a, b = keys[0], keys[1]
        if totals[b] > 0:
            ratio = round(totals[a] / totals[b], 2)
    aggregate_wer: dict[str, float | None] = {}
    for backend, pairs in wer_by_backend.items():
        errors = sum(e for e, _ in pairs)
        refs = sum(n for _, n in pairs)
        aggregate_wer[backend] = round(errors / refs, 4) if refs else None
    mean_cross = None
    if cross_wer:
        values = [row["mean_wer"] for row in cross_wer if row.get("mean_wer") is not None]
        if values:
            mean_cross = round(sum(values) / len(values), 4)
    return {
        "total_sec_by_backend": totals,
        "speed_ratio_first_vs_second": ratio,
        "aggregate_wer_by_backend": aggregate_wer,
        "cross_backend_wer": cross_wer or [],
        "mean_cross_backend_wer": mean_cross,
    }


def _print_summary(summary: dict) -> None:
    print("\n## Summary")
    for backend, sec in summary.get("total_sec_by_backend", {}).items():
        print(f"- {backend}: {sec}s total (both tracks)")
    ratio = summary.get("speed_ratio_first_vs_second")
    if ratio is not None:
        print(f"- ratio (first/second): {ratio}x")
    for backend, wer in summary.get("aggregate_wer_by_backend", {}).items():
        if wer is not None:
            print(f"- {backend}: aggregate WER {round(wer * 100, 1)}%")
    mean_cross = summary.get("mean_cross_backend_wer")
    if mean_cross is not None:
        print(f"- cross-backend agreement WER: {round(mean_cross * 100, 1)}% (mean)")
    for row in summary.get("cross_backend_wer", []):
        print(
            f"  {row['track']}: {row['backend_a']} vs {row['backend_b']} "
            f"mean={round((row['mean_wer'] or 0) * 100, 1)}%"
        )


if __name__ == "__main__":
    raise SystemExit(main())
