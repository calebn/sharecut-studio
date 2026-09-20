"""By-construction defect injection and scoring for audition_context v2."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from podcast_mcp.edits.audition_context import HYPOTHESIS_CATALOG, build_audition_context
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    save_project,
)

# Codes that fire on almost every unsynced fixture and are ignored in P/R.
IGNORE_CODES = frozenset({"stale_render", "stale_reconciliation"})


def generate_tone(
    dest: Path,
    *,
    duration_sec: float,
    freq_hz: float = 220.0,
    sample_rate: int = 48000,
    gain_db: float = 0.0,
) -> Path:
    return FFmpegEngine().generate_tone(
        dest,
        duration_sec=duration_sec,
        freq_hz=freq_hz,
        sample_rate=sample_rate,
        gain_db=gain_db,
    )


def inject_hum_span(
    src: Path,
    dest: Path,
    *,
    start_sec: float,
    end_sec: float,
    freq_hz: float = 60.0,
    mix_db: float = 0.0,
) -> Path:
    """Mix mains-hum (fundamental + 2nd harmonic) into [start_sec, end_sec)."""
    eng = FFmpegEngine()
    tmp = dest.parent / f".{dest.stem}_hum"
    tmp.mkdir(parents=True, exist_ok=True)
    mid = tmp / "mid.wav"
    _extract_span(eng, src, tmp, start_sec, end_sec, mid)
    hum = tmp / "hum.wav"
    dur = max(0.05, end_sec - start_sec)
    generate_tone(hum, duration_sec=dur, freq_hz=freq_hz)
    harm = tmp / "harm.wav"
    generate_tone(harm, duration_sec=dur, freq_hz=freq_hz * 2)
    both = tmp / "hum2.wav"
    eng.mix_tracks([(hum, 0.0), (harm, -6.0)], both)
    mixed = tmp / "mixed.wav"
    eng.mix_tracks([(mid, 0.0), (both, mix_db)], mixed)
    return _splice_span(eng, src, dest, tmp, start_sec, end_sec, mixed)


def inject_clip_span(
    src: Path,
    dest: Path,
    *,
    start_sec: float,
    end_sec: float,
    gain_db: float = 24.0,
) -> Path:
    eng = FFmpegEngine()
    tmp = dest.parent / f".{dest.stem}_clip"
    tmp.mkdir(parents=True, exist_ok=True)
    mid = tmp / "mid.wav"
    _extract_span(eng, src, tmp, start_sec, end_sec, mid)
    clipped = tmp / "clipped.wav"
    eng.filter_audio(mid, clipped, f"volume={gain_db}dB")
    return _splice_span(eng, src, dest, tmp, start_sec, end_sec, clipped)


def _extract_span(
    eng: FFmpegEngine,
    src: Path,
    tmp: Path,
    start_sec: float,
    end_sec: float,
    mid: Path,
) -> None:
    eng.extract_segment(src, mid, start_sec, end_sec)


def _splice_span(
    eng: FFmpegEngine,
    src: Path,
    dest: Path,
    tmp: Path,
    start_sec: float,
    end_sec: float,
    replacement: Path,
) -> Path:
    probe = eng.probe(src)
    duration = float(probe.duration_sec)
    parts: list[Path] = []
    if start_sec > 0.02:
        head = tmp / "head.wav"
        eng.extract_segment(src, head, 0.0, start_sec)
        parts.append(head)
    parts.append(replacement)
    if end_sec < duration - 0.02:
        tail = tmp / "tail.wav"
        eng.extract_segment(src, tail, end_sec, duration)
        parts.append(tail)
    dest.parent.mkdir(parents=True, exist_ok=True)
    eng.join_audio_parts(parts, dest)
    return dest


def build_defect_project(workspace: Path) -> EpisodeProject:
    """12s two-track project: hum 2-5s, clipping 6-9s, guest clip skew 0.6s."""
    workspace.mkdir(parents=True, exist_ok=True)
    raw = workspace / "raw"
    raw.mkdir(exist_ok=True)
    tone = raw / "tone.wav"
    generate_tone(tone, duration_sec=12.0, freq_hz=220.0)
    host_wav = raw / "host.wav"
    with_hum = raw / "host_hum.wav"
    inject_hum_span(tone, with_hum, start_sec=2.0, end_sec=5.0, freq_hz=60.0, mix_db=0.0)
    inject_clip_span(with_hum, host_wav, start_sec=6.0, end_sec=9.0, gain_db=24.0)
    guest_wav = raw / "guest.wav"
    guest_wav.write_bytes(tone.read_bytes())

    project = EpisodeProject.create("audition-defects", str(workspace))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=12.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=12.0),
        ),
    ]
    project.clips = [
        Clip(
            id="c_host",
            track_id="host",
            source_start=0.0,
            source_end=12.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c_guest",
            track_id="guest",
            source_start=0.0,
            source_end=12.0,
            timeline_start=0.6,
        ),
    ]
    project.ensure_dirs()
    stems = project.artifacts_dir() / "tracks"
    stems.mkdir(parents=True, exist_ok=True)
    (stems / "host.wav").write_bytes(host_wav.read_bytes())
    (stems / "guest.wav").write_bytes(guest_wav.read_bytes())
    save_project(project)
    return project


def hypothesis_codes(ctx: dict[str, Any]) -> set[str]:
    return {h["code"] for h in ctx.get("hypotheses") or [] if h["code"] not in IGNORE_CODES}


def precision_recall(predicted: set[str], expected: set[str]) -> tuple[float, float]:
    if not expected and not predicted:
        return 1.0, 1.0
    tp = len(predicted & expected)
    prec = tp / len(predicted) if predicted else 1.0
    rec = tp / len(expected) if expected else 1.0
    return prec, rec


def score_labeled_windows(
    project: EpisodeProject,
    cases: list[dict[str, Any]],
    *,
    detail: str = "summary",
) -> dict[str, Any]:
    """Score per-code precision/recall over labeled windows.

    Each case: ``{code, start, end, expect: bool}``.
    """
    by_code: dict[str, dict[str, int]] = {}
    rows: list[dict[str, Any]] = []
    contexts: dict[tuple[float, float], dict[str, Any]] = {}
    for case in cases:
        code = str(case["code"])
        if code not in HYPOTHESIS_CATALOG:
            raise ValueError(f"unknown hypothesis code {code!r}")
        stats = by_code.setdefault(code, {"tp": 0, "fp": 0, "fn": 0, "tn": 0})
        window = (float(case["start"]), float(case["end"]))
        ctx = contexts.get(window)
        if ctx is None:
            ctx = build_audition_context(
                project,
                window[0],
                window[1],
                detail=detail,  # type: ignore[arg-type]
                # The evaluator gates hypotheses. PNG pixels are independently covered
                # by FFmpeg and visual-context tests, and do not affect those gates.
                render_visual_pngs=False,
            )
            contexts[window] = ctx
        found = code in hypothesis_codes(ctx)
        expect = bool(case["expect"])
        if found and expect:
            stats["tp"] += 1
        elif found and not expect:
            stats["fp"] += 1
        elif not found and expect:
            stats["fn"] += 1
        else:
            stats["tn"] += 1
        rows.append(
            {
                "code": code,
                "start": case["start"],
                "end": case["end"],
                "expect": expect,
                "found": found,
            }
        )

    per_code: dict[str, dict[str, float]] = {}
    for code, stats in by_code.items():
        pred_pos = stats["tp"] + stats["fp"]
        real_pos = stats["tp"] + stats["fn"]
        prec = stats["tp"] / pred_pos if pred_pos else 1.0
        rec = stats["tp"] / real_pos if real_pos else 1.0
        per_code[code] = {
            "precision": prec,
            "recall": rec,
            **stats,
        }
    return {"per_code": per_code, "rows": rows}


DEFAULT_CASES: list[dict[str, Any]] = [
    {"code": "hum_in_window", "start": 2.2, "end": 4.8, "expect": True},
    {"code": "hum_in_window", "start": 0.0, "end": 1.8, "expect": False},
    {"code": "clipping_in_window", "start": 6.2, "end": 8.8, "expect": True},
    {"code": "clipping_in_window", "start": 0.0, "end": 1.8, "expect": False},
]
