from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Any

from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    _processed_track_path,
    analyze_cleanup,
    analyze_gate_overreach,
    compute_word_audibility_map,
    detect_mains_hum,
    list_low_audibility_words,
    measure_astats,
    recommend_boundary_fades,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import stem_is_fresh
from podcast_mcp.engines.reconciliation_state import mark_reconciliation_fresh
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.progress import ProgressReporter, resolve_progress
from podcast_mcp.util.timebase import TimelineSec
from podcast_mcp.util.workspace_paths import resolve_within

_UNSAFE_TRACK_ID = re.compile(r"[/\\]|\.\.")


def low_audibility_words(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy | None = None,
    track_id: str | None = None,
    progress: ProgressReporter | None = None,
) -> list[dict[str, Any]]:
    return list_low_audibility_words(project, policy=policy, track_id=track_id, progress=progress)


class DiagnosticsWindowError(ValueError):
    """Timeline window cannot be analyzed as one contiguous extract."""


def track_diagnostics_audio_path(project: EpisodeProject, track_id: str) -> Path:
    path = _processed_track_path(project, track_id)
    if path is None:
        track = project.track_by_id(track_id)
        if not track or not track.media:
            raise ValueError(f"no audio available for track {track_id!r}")
        path = Path(track.media.path)
        if not path.is_absolute():
            path = project.workspace_path() / path
    return path


def diagnostics_dir(project: EpisodeProject, track_id: str) -> Path:
    """Resolved ``artifacts/diagnostics/<track_id>/``, refusing path traversal."""
    if not track_id or _UNSAFE_TRACK_ID.search(track_id) or track_id in {".", ".."}:
        raise ValueError(f"unsafe track_id for diagnostics path: {track_id!r}")
    root = (project.artifacts_dir() / "diagnostics").resolve()
    try:
        out = resolve_within(root, str(root / track_id))
    except ValueError:
        raise ValueError(f"diagnostics path escaped artifacts: {track_id!r}") from None
    out.mkdir(parents=True, exist_ok=True)
    return out


def _source_media_path(project: EpisodeProject, track_id: str) -> Path | None:
    track = project.track_by_id(track_id)
    if not track or not track.media:
        return None
    path = Path(track.media.path)
    if not path.is_absolute():
        path = project.workspace_path() / path
    return path if path.is_file() else None


def _window_extract_spec(
    project: EpisodeProject,
    track_id: str,
    start_sec: float,
    end_sec: float,
) -> tuple[Path, float, float]:
    """File and file-clock bounds backing a timeline window.

    Fresh timeline-length stems are sliced in timeline seconds. Otherwise the
    window is mapped through ``SessionTimeline`` onto source media. A join or
    gap in the window is not a single extract — callers should skip DSP.
    """
    stem = _processed_track_path(project, track_id)
    if stem is not None and stem_is_fresh(project, track_id):
        return stem, start_sec, end_sec

    st = SessionTimeline(project)
    spans = st.map_timeline_span(track_id, TimelineSec(start_sec), TimelineSec(end_sec))
    if len(spans) != 1:
        raise DiagnosticsWindowError(
            "timeline window is not a single source span (join or gap); DSP skipped"
        )
    src_start, src_end = float(spans[0][0]), float(spans[0][1])
    has_clips = any(c.track_id == track_id for c in project.clips)
    if not has_clips and stem is not None:
        return stem, start_sec, end_sec
    media = _source_media_path(project, track_id)
    if media is not None:
        return media, src_start, src_end
    raise DiagnosticsWindowError("no fresh stem or source media for windowed DSP")


def audio_diagnostics_report(
    project: EpisodeProject,
    track_id: str,
    *,
    start_sec: float | None = None,
    end_sec: float | None = None,
    pngs: bool = True,
) -> dict[str, Any]:
    """Spectrogram + waveform PNGs plus astats/hum health for one track (or a time window).

    When ``start_sec``/``end_sec`` are set, astats and hum run on the extracted
    window (same segment as the PNGs), not the full stem. ``pngs=False`` skips
    spectrogram/waveform render (windowed numbers only).
    """
    window: tuple[float, float] | None = None
    extract_path: Path
    file_start: float
    file_end: float
    if start_sec is not None and end_sec is not None:
        if end_sec <= start_sec:
            raise ValueError("end_sec must be after start_sec")
        window = (start_sec, end_sec)
        extract_path, file_start, file_end = _window_extract_spec(
            project, track_id, start_sec, end_sec
        )
    else:
        extract_path = track_diagnostics_audio_path(project, track_id)
        file_start = 0.0
        file_end = 0.0

    eng = FFmpegEngine()
    out_dir = diagnostics_dir(project, track_id)
    suffix = f"_{window[0]:.3f}_{window[1]:.3f}" if window else ""
    spectrogram_png = out_dir / f"spectrogram{suffix}.png"
    waveform_png = out_dir / f"waveform{suffix}.png"

    analysis_path = extract_path
    tmp_segment: Path | None = None
    astats: dict[str, Any] | None = None
    hum: dict[str, Any] | None = None
    try:
        if window is not None:
            tmp_segment = out_dir / f".segment_{os.getpid()}_{uuid.uuid4().hex}.wav"
            eng.extract_segment(extract_path, tmp_segment, file_start, file_end)
            analysis_path = tmp_segment
        if pngs:
            eng.render_spectrogram(analysis_path, spectrogram_png, legend=window is None)
            eng.render_showwavespic(analysis_path, waveform_png)
        astats = measure_astats(analysis_path)
        hum = detect_mains_hum(analysis_path)
    finally:
        if tmp_segment is not None:
            tmp_segment.unlink(missing_ok=True)

    out: dict[str, Any] = {
        "track_id": track_id,
        "astats": astats,
        "hum": hum,
    }
    if pngs:
        out["spectrogram_png"] = str(spectrogram_png)
        out["waveform_png"] = str(waveform_png)
    if window is not None:
        out["window"] = {
            "clock": "timeline",
            "unit": "sec",
            "start": window[0],
            "end": window[1],
        }
    return out


def cleanup_analysis_report(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    return analyze_cleanup(project, track_id=track_id, policy=policy, progress=progress)


def fade_recommendations(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy | None = None,
    track_id: str | None = None,
) -> list[dict[str, Any]]:
    return recommend_boundary_fades(project, policy=policy, track_id=track_id)


def apply_fade_recommendations(
    project: EpisodeProject,
    recommendations: list[dict[str, Any]],
) -> dict[str, Any]:
    """Apply recommended fades to adjacent clip pairs from recommend_boundary_fades."""
    from podcast_mcp.edits.join_modes import cap_fade_ms

    applied = 0
    for rec in recommendations:
        left_id = rec.get("left_clip_id")
        right_id = rec.get("clip_id")
        fin = int(rec.get("recommended_fade_in_ms", 20))
        fout = int(rec.get("recommended_fade_out_ms", 20))
        if left_id:
            clip = next((c for c in project.clips if c.id == left_id), None)
            if clip:
                clip.fade_out_ms = max(clip.fade_out_ms, cap_fade_ms(project, clip.track_id, fout))
                applied += 1
        if right_id:
            clip = next((c for c in project.clips if c.id == right_id), None)
            if clip:
                clip.fade_in_ms = max(clip.fade_in_ms, cap_fade_ms(project, clip.track_id, fin))
                applied += 1
    return {"applied_fade_updates": applied}


def suppress_low_audibility_words(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy | None = None,
    track_id: str | None = None,
    word_keys: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Set suppressed=True on low-audibility words (or explicit track_id/word_index list).
    Rebuilds combined transcript so exports/search omit suppressed words.
    """
    pol = policy or AnalysisPolicy.from_defaults()
    if word_keys is not None:
        targets = {(str(item["track_id"]), int(item["word_index"])) for item in word_keys}
    else:
        flagged = list_low_audibility_words(project, policy=pol, track_id=track_id)
        targets = {(f["track_id"], f["word_index"]) for f in flagged}

    count = 0
    for tr in project.transcripts:
        for i, w in enumerate(tr.words):
            if (tr.track_id, i) in targets:
                tr.words[i] = w.model_copy(update={"suppressed": True})
                count += 1
    rebuild_combined(project)
    return {"suppressed_count": count}


def gate_overreach_report(
    project: EpisodeProject,
    track_id: str,
    *,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    return analyze_gate_overreach(project, track_id, policy=policy, progress=progress)


def _filter_rows_by_time(
    rows: list[dict[str, Any]],
    *,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> list[dict[str, Any]]:
    out = rows
    if start_sec is not None:
        out = [r for r in out if r.get("start", 0) >= start_sec]
    if end_sec is not None:
        out = [r for r in out if r.get("start", 0) < end_sec]
    return out


def _word_key_set(items: list[dict[str, Any]] | None) -> set[tuple[str, int]]:
    if not items:
        return set()
    return {(str(item["track_id"]), int(item["word_index"])) for item in items}


def bleed_words(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy | None = None,
    track_id: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    progress: ProgressReporter | None = None,
) -> list[dict[str, Any]]:
    pol = policy or AnalysisPolicy.from_defaults()
    rows = [
        row
        for row in compute_word_audibility_map(
            project, track_id=track_id, policy=pol, progress=progress
        )
        if row["audibility_status"] == "bleed"
    ]
    return _filter_rows_by_time(rows, start_sec=start_sec, end_sec=end_sec)


def suppress_bleed_words(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy | None = None,
    track_id: str | None = None,
    word_keys: list[dict[str, Any]] | None = None,
    exclude_word_keys: list[dict[str, Any]] | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    dry_run: bool = True,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    """
    Suppress bleed-tagged words on the wrong track (metadata only).
    Dry-run returns candidates; apply sets suppressed=True and rebuilds combined.
    """
    pol = policy or AnalysisPolicy.from_defaults()
    reporter = resolve_progress(progress)
    if word_keys is not None:
        targets = _word_key_set(word_keys)
    else:
        flagged = bleed_words(
            project,
            policy=pol,
            track_id=track_id,
            start_sec=start_sec,
            end_sec=end_sec,
            progress=reporter,
        )
        targets = {(f["track_id"], f["word_index"]) for f in flagged}

    targets -= _word_key_set(exclude_word_keys)
    already_suppressed = {
        (tr.track_id, i)
        for tr in project.transcripts
        for i, w in enumerate(tr.words)
        if w.suppressed
    }
    targets -= already_suppressed

    candidates: list[dict[str, Any]] = []
    for tr in project.transcripts:
        if track_id and tr.track_id != track_id:
            continue
        for i, w in enumerate(tr.words):
            if (tr.track_id, i) not in targets:
                continue
            candidates.append(
                {
                    "track_id": tr.track_id,
                    "word_index": i,
                    "text": w.text,
                    "start": w.start,
                    "end": w.end,
                    "audibility_status": w.audibility_status,
                    "dominant_track": w.dominant_track,
                    "already_suppressed": w.suppressed,
                }
            )

    if dry_run:
        return {
            "dry_run": True,
            "candidate_count": len(candidates),
            "candidates": candidates,
        }

    count = 0
    for tr in project.transcripts:
        for i, w in enumerate(tr.words):
            if (tr.track_id, i) in targets and not w.suppressed:
                tr.words[i] = w.model_copy(update={"suppressed": True})
                count += 1
    rebuild_combined(project)
    mark_reconciliation_fresh(project)
    return {
        "dry_run": False,
        "applied": True,
        "suppressed_count": count,
        "candidates": candidates,
    }
