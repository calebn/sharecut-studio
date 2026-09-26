from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from podcast_mcp.engines.align import (
    AlignmentResult,
    cross_speaker_offsets,
)
from podcast_mcp.engines.alignment_audit import (
    simultaneous_speech_sec,
    vad_speech_intervals,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.session_clock import (
    estimate_session_start_in_file,
    file_time_for_session,
)
from podcast_mcp.engines.transcript_align import (
    TranscriptAlignResult,
    cross_speaker_offsets_from_transcripts,
    load_transcripts,
)
from podcast_mcp.ingest.manifest import IngestManifest

AlignMode = Literal["auto", "audio", "transcript"]


@dataclass
class SpeakerAlignment:
    name: str
    reference: Path
    sources: list[AlignmentResult]


@dataclass
class ConsolidateResult:
    speaker_tracks: dict[str, Path]
    alignments: list[SpeakerAlignment]
    cross_speaker_offsets: dict[str, float]
    session_start_in_file_sec: dict[str, float] = field(default_factory=dict)
    cross_speaker_align_method: dict[str, str] = field(default_factory=dict)
    transcript_overlap_sec: dict[str, float] = field(default_factory=dict)
    ignored_sources: list[str] = field(default_factory=list)
    session_trimmed: bool = False


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s or "speaker"


def _resolve_cross_speaker_offsets(
    groups: list[tuple[str, list[Path]]],
    manifest: IngestManifest,
    *,
    session_starts: dict[str, float],
    session_analysis_start: float,
    analysis_duration_sec: float,
    min_cross_speaker_peak: float,
    align_mode: AlignMode,
    transcript_path: Path | None,
) -> tuple[dict[str, float], dict[str, str], dict[str, float], dict[str, float]]:
    ref_name = manifest.reference_speaker_name()
    ordered = sorted((g for g in groups if g[1]), key=lambda g: g[0] != ref_name)
    names = [name for name, _paths in ordered]
    offsets: dict[str, float] = {names[0]: 0.0} if names else {}
    methods: dict[str, str] = {names[0]: "reference"} if names else {}
    overlaps: dict[str, float] = {}
    correlation_peaks: dict[str, float] = {names[0]: 1.0} if names else {}

    manual = {
        g.name: g.session_offset_sec for g in manifest.speakers if g.session_offset_sec is not None
    }

    transcript_results: dict[str, TranscriptAlignResult] | None = None
    use_transcript = align_mode in ("auto", "transcript") and transcript_path is not None
    if use_transcript and transcript_path is not None:
        words = load_transcripts(transcript_path)
        pairs = [(name, _slug(name)) for name in names]
        anchor_rows = [a.model_dump() for a in manifest.align_anchors]
        transcript_results = cross_speaker_offsets_from_transcripts(
            pairs,
            words,
            anchors=anchor_rows or None,
        )

    audio_results: dict[str, AlignmentResult] = {}
    if align_mode in ("auto", "audio") and len(names) > 1:
        cross_groups = [(name, [paths[0]]) for name, paths in ordered]
        audio_results = cross_speaker_offsets(
            cross_groups,
            analysis_start_sec=session_analysis_start,
            analysis_duration_sec=analysis_duration_sec,
            min_correlation_peak=min_cross_speaker_peak,
            session_starts_in_file=session_starts,
        )

    for name in names[1:]:
        if name in manual:
            offsets[name] = manual[name]
            methods[name] = "manual"
            continue
        if transcript_results and name in transcript_results:
            tr = transcript_results[name]
            offsets[name] = tr.offset_sec
            methods[name] = tr.method
            overlaps[name] = tr.overlap_sec
            continue
        ar = audio_results.get(name)
        if ar is not None:
            correlation_peaks[name] = ar.correlation_peak
            if ar.correlation_peak >= min_cross_speaker_peak:
                offsets[name] = ar.offset_sec
                methods[name] = "audio"
            else:
                offsets[name] = 0.0
                methods[name] = "audio_rejected"

    return offsets, methods, overlaps, correlation_peaks


def _resolve_session_starts(
    groups: list[tuple[str, list[Path]]],
    manifest: IngestManifest,
    *,
    session_hint_sec: float,
) -> dict[str, float]:
    """Map each speaker to file timestamp where session t=0 begins."""
    ref_name = manifest.reference_speaker_name()
    ref_path: Path | None = None
    starts: dict[str, float] = {}
    manual = {g.name: g.session_start_in_file_sec for g in manifest.speakers}
    for name, paths in groups:
        if name == ref_name and paths:
            ref_path = paths[0]
            break
    if ref_path is None:
        return starts
    starts[ref_name] = manual.get(ref_name) or 0.0
    for name, paths in groups:
        if not paths or name == ref_name:
            continue
        manual_start = manual.get(name)
        if manual_start is not None:
            starts[name] = manual_start
            continue
        starts[name] = estimate_session_start_in_file(
            ref_path,
            paths[0],
            session_hint_sec=session_hint_sec,
        )
    return starts


def consolidate_speakers(
    manifest: IngestManifest,
    audio_dir: Path,
    output_dir: Path,
    *,
    analysis_start_sec: float = 60.0,
    analysis_duration_sec: float = 90.0,
    extract_start_sec: float | None = None,
    extract_duration_sec: float | None = None,
    min_cross_speaker_peak: float = 0.05,
    align_mode: AlignMode = "auto",
    transcript_path: Path | None = None,
) -> ConsolidateResult:
    """Extract one WAV per speaker from the first listed source file."""
    output_dir.mkdir(parents=True, exist_ok=True)
    groups = list(manifest.resolve_sources(audio_dir))
    speaker_tracks: dict[str, Path] = {}
    alignments: list[SpeakerAlignment] = []
    ignored: list[str] = []

    session_analysis_start = (
        extract_start_sec if extract_start_sec is not None else analysis_start_sec
    )
    hint = manifest.session_hint_sec(extract_start_sec)
    session_starts = _resolve_session_starts(groups, manifest, session_hint_sec=hint)
    cross_offsets, align_methods, overlap_sec, _corr_peaks = _resolve_cross_speaker_offsets(
        groups,
        manifest,
        session_starts=session_starts,
        session_analysis_start=session_analysis_start,
        analysis_duration_sec=analysis_duration_sec,
        min_cross_speaker_peak=min_cross_speaker_peak,
        align_mode=align_mode,
        transcript_path=transcript_path,
    )

    eng = FFmpegEngine()
    for name, paths in groups:
        if not paths:
            continue
        primary = paths[0]
        outs: list[Path] = []
        source_alignments: list[AlignmentResult] = []
        try:
            for i, src_path in enumerate(paths):
                suffix = "" if i == 0 else f"_src{i}"
                out = output_dir / f"{_slug(name)}{suffix}.wav"
                outs.append(out)
                file_session_start = session_starts.get(name, 0.0)
                if i == 0 and extract_start_sec is not None:
                    trim_start = file_time_for_session(
                        file_session_start,
                        extract_start_sec,
                        cross_offsets.get(name, 0.0),
                    )
                else:
                    trim_start = None

                if i == 0 and trim_start is not None and extract_duration_sec is not None:
                    eng.extract_segment(
                        src_path,
                        out,
                        trim_start,
                        trim_start + extract_duration_sec,
                    )
                else:
                    # Whole-file real-time section — never blade/split for alignment.
                    eng.extract_segment(
                        src_path,
                        out,
                        0.0,
                        eng.probe(src_path).duration_sec,
                    )
                source_alignments.append(
                    AlignmentResult(
                        reference=primary,
                        source=out,
                        offset_sec=0.0,
                        correlation_peak=1.0,
                    )
                )
        except Exception:
            for written in outs:
                written.unlink(missing_ok=True)
            raise

        alignments.append(
            SpeakerAlignment(
                name=name,
                reference=outs[0],
                sources=source_alignments,
            )
        )
        speaker_tracks[name] = outs[0]

    return ConsolidateResult(
        speaker_tracks=speaker_tracks,
        alignments=alignments,
        cross_speaker_offsets=cross_offsets,
        session_start_in_file_sec=session_starts,
        cross_speaker_align_method=align_methods,
        transcript_overlap_sec=overlap_sec,
        ignored_sources=ignored,
        session_trimmed=extract_start_sec is not None and extract_duration_sec is not None,
    )


def alignment_report(
    manifest: IngestManifest,
    audio_dir: Path,
    *,
    analysis_start_sec: float = 60.0,
    analysis_duration_sec: float = 90.0,
    align_mode: AlignMode = "auto",
    transcript_path: Path | None = None,
) -> list[dict]:
    groups = list(manifest.resolve_sources(audio_dir))
    hint = manifest.session_hint_sec(analysis_start_sec)
    session_starts = _resolve_session_starts(groups, manifest, session_hint_sec=hint)
    offsets, methods, overlaps, corr_peaks = _resolve_cross_speaker_offsets(
        groups,
        manifest,
        session_starts=session_starts,
        session_analysis_start=analysis_start_sec,
        analysis_duration_sec=analysis_duration_sec,
        min_cross_speaker_peak=0.05,
        align_mode=align_mode,
        transcript_path=transcript_path,
    )
    ref_name = manifest.reference_speaker_name()
    ref_path = next((paths[0] for name, paths in groups if name == ref_name and paths), None)
    rows: list[dict] = []
    for name, paths in groups:
        if not paths:
            continue
        primary = paths[0]
        trim = file_time_for_session(
            session_starts.get(name, 0.0),
            analysis_start_sec,
            offsets.get(name, 0.0),
        )
        row: dict = {
            "speaker": name,
            "source": str(primary),
            "session_start_in_file_sec": round(session_starts.get(name, 0.0), 4),
            "content_align_sec": round(offsets.get(name, 0.0), 4),
            "session_offset_sec": round(offsets.get(name, 0.0), 4),
            "align_method": methods.get(name, "unknown"),
            "extract_trim_start_sec": round(trim, 4),
        }
        if name in overlaps:
            row["transcript_overlap_sec"] = round(overlaps[name], 4)
        if name in corr_peaks:
            row["correlation_peak"] = round(corr_peaks[name], 4)
        if len(paths) > 1:
            row["ignored_sources"] = [str(p) for p in paths[1:]]
        rows.append(row)

    if ref_path and len(groups) > 1:
        ref_trim = file_time_for_session(session_starts.get(ref_name, 0.0), analysis_start_sec, 0.0)
        ref_iv = vad_speech_intervals(
            ref_path, start_sec=ref_trim, duration_sec=analysis_duration_sec
        )
        for name, paths in groups:
            if name == ref_name or not paths:
                continue
            src_trim = file_time_for_session(
                session_starts.get(name, 0.0),
                analysis_start_sec,
                offsets.get(name, 0.0),
            )
            src_iv = vad_speech_intervals(
                paths[0], start_sec=src_trim, duration_sec=analysis_duration_sec
            )
            vad_overlap = simultaneous_speech_sec(ref_iv, src_iv)
            for row in rows:
                if row["speaker"] == name:
                    row["vad_overlap_sec"] = round(vad_overlap, 4)
                    row["confidence"] = _alignment_confidence(
                        methods.get(name, ""),
                        corr_peaks.get(name),
                        vad_overlap,
                        analysis_duration_sec,
                    )
                    break
        for row in rows:
            if row["speaker"] == ref_name:
                row["confidence"] = "reference"
    return rows


def _alignment_confidence(
    method: str,
    correlation_peak: float | None,
    vad_overlap_sec: float,
    window_sec: float,
) -> str:
    if method in ("manual", "anchor"):
        return "high"
    if method == "audio_rejected":
        return "low"
    overlap_ratio = vad_overlap_sec / max(window_sec, 1.0)
    if overlap_ratio > 0.35:
        return "low"
    if method == "audio" and correlation_peak is not None and correlation_peak < 0.08:
        return "medium"
    if overlap_ratio < 0.15:
        return "high"
    return "medium"


def list_audio_files(audio_dir: Path) -> list[Path]:
    from podcast_mcp.ingest.import_folder import AUDIO_EXTENSIONS

    return sorted(
        p for p in audio_dir.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
    )
