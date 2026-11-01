from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from podcast_mcp.edits.conversation_align import ingest_alignment_meta_key
from podcast_mcp.engines.alignment_audit import (
    VADWindowRMSCache,
    check_drift,
    render_comparison_waveforms,
    simultaneous_speech_sec,
    sweep_content_offset,
    sweep_session_starts,
    vad_speech_intervals,
)
from podcast_mcp.engines.clips_ops import clips_for_track
from podcast_mcp.engines.session_timeline import (
    clip_source_to_timeline_shift,
    clip_timeline_overlap_to_source,
    shift_at,
)
from podcast_mcp.ingest.consolidate import (
    ConsolidateResult,
    consolidate_speakers,
    session_content_offset,
)
from podcast_mcp.ingest.import_folder import (
    DEFAULT_MAX_FILES,
    DEFAULT_MAX_TOTAL_DURATION_SEC,
    FolderScan,
    ScannedFile,
    filename_stem_parts,
    scan_recorder_folder,
)
from podcast_mcp.ingest.manifest import IngestManifest, SessionConfig, SpeakerGroup
from podcast_mcp.models import (
    EPISODE_PROJECT_FILENAME,
    Clip,
    SourceRecording,
    SpeakerIngestAlignment,
    Track,
    TrackRole,
    workspace_artifacts_dir,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media.waveform import schedule_track_waveforms
from podcast_mcp.util.binaries import resolve_ffmpeg_pair
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import ProgressTask, resolve_progress_task
from podcast_mcp.util.workspace_paths import resolve_under_workspace, resolve_within


@dataclass
class SuggestCandidate:
    session_start_in_file_sec: float
    content_align_sec: float
    simultaneous_speech_sec: float
    correlation_peak: float | None = None


@dataclass
class SuggestResult:
    reference_speaker: str
    source_speaker: str
    recommended_session_starts: dict[str, float]
    recommended_content_offsets: dict[str, float]
    candidates: list[SuggestCandidate]
    yaml_snippet: str
    waveform_paths: list[str] = field(default_factory=list)
    drift_warning: str | None = None


@dataclass
class VerifyResult:
    status: str
    simultaneous_speech_sec: float
    window_start_sec: float
    window_end_sec: float
    per_track_segments: list[dict]
    warnings: list[str]
    play_commands: list[str]
    waveform_paths: list[str] = field(default_factory=list)


@dataclass
class AppliedConsolidation:
    track_ids: list[str]
    warnings: list[str] = field(default_factory=list)


@dataclass
class ImportFolderReport:
    audio_dir: str
    out_manifest: str | None
    dry_run: bool
    vendor_hint: str
    files: list[dict]
    skipped: list[dict]
    warnings: list[str]
    next_steps: list[str]
    written: bool


def _timeline_vad_intervals(
    project,
    track,
    *,
    window_start_sec: float,
    window_end_sec: float,
) -> list[tuple[float, float]]:
    """Speech intervals on the timeline clock, read through the track's clips."""
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    clips = clips_for_track(project, track.id)
    if not clips:
        assert track.media is not None
        return vad_speech_intervals(
            resolve_under_workspace(project, track.media.path),
            start_sec=window_start_sec,
            duration_sec=window_end_sec - window_start_sec,
        )
    out: list[tuple[float, float]] = []
    for clip in clips:
        for src_a, src_b, shift in _window_pieces(clip, window_start_sec, window_end_sec):
            for a, b in vad_speech_intervals(
                resolve_clip_audio_path(project, track, clip),
                start_sec=src_a,
                duration_sec=src_b - src_a,
            ):
                out.append((a + shift, b + shift))
    return out


def _window_pieces(clip, window_start_sec: float, window_end_sec: float):
    """``(source_a, source_b, shift)`` for each stretch of ``clip`` inside the timeline window.

    A clip with a timing map plays several stretches, each with its own shift.
    """
    if clip.timing is None:
        mapped = clip_timeline_overlap_to_source(clip, window_start_sec, window_end_sec)
        if mapped is not None:
            yield mapped[0], mapped[1], clip_source_to_timeline_shift(clip)
        return
    for src_a, src_b, tl_a in clip.virtual_pieces():
        shift = tl_a - src_a
        lo = max(window_start_sec, tl_a)
        hi = min(window_end_sec, tl_a + (src_b - src_a))
        if hi - lo > 1e-6:
            yield lo - shift, hi - shift, shift


def _waveform_file_start(project, track) -> float:
    """File time of timeline 0 on the track's first clip (0 when unclipped).

    Negative when the clip starts after timeline 0; the waveform renderer then pads
    the window head with silence. Only the first clip is read: the stack shows the
    primary file.
    """
    clips = clips_for_track(project, track.id)
    if not clips:
        return 0.0
    return -shift_at(clips[0], clips[0].source_start)


class IngestService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    @staticmethod
    def import_recorder_folder(
        audio_dir: Path,
        *,
        out_manifest: Path | None = None,
        speakers_override: dict[str, str] | None = None,
        dry_run: bool = False,
        max_files: int = DEFAULT_MAX_FILES,
        max_total_duration_sec: float = DEFAULT_MAX_TOTAL_DURATION_SEC,
    ) -> ImportFolderReport:
        """Scan a recorder export folder and write ``ingest.yaml`` (no audio copy)."""
        dest = (out_manifest or (audio_dir / "ingest.yaml")).expanduser()
        speakers_override = _normalize_speakers_override(speakers_override)

        with resolve_progress_task(
            "ingest.import",
            "Importing recorder folder",
            prefer_parent=True,
        ) as prog:
            prog.set_phase("scanning", "Scanning recorder folder…")

            def on_probe(index: int, total: int, name: str) -> None:
                if index == 1:
                    prog.set_phase("probing", "Probing audio files…")
                    if prog.total is None:
                        prog.total = total + 1
                prog.advance(1, message=f"Probed {name} ({index}/{total})")

            scan = scan_recorder_folder(
                audio_dir,
                max_files=max_files,
                max_total_duration_sec=max_total_duration_sec,
                on_probe=on_probe,
            )
            labels = _apply_speaker_overrides(scan, speakers_override)
            manifest = _manifest_from_scan(scan, labels)
            warnings = _import_warnings(scan, dest, dry_run=dry_run)
            written = False
            prog.set_phase("writing", "Writing ingest.yaml…" if not dry_run else "Dry run")
            if not dry_run:
                _write_ingest_manifest(dest, manifest)
                written = True
            prog.advance(1, message="Wrote ingest.yaml" if written else "Dry run — not writing")

        return ImportFolderReport(
            audio_dir=str(scan.audio_dir),
            out_manifest=str(dest),
            dry_run=dry_run,
            vendor_hint=scan.vendor_hint,
            files=[_file_row(row, labels[row.filename]) for row in scan.files],
            skipped=[_file_row(row, row.speaker_label) for row in scan.skipped],
            warnings=warnings,
            next_steps=_next_steps(scan.audio_dir, dest, dry_run=dry_run),
            written=written,
        )

    def consolidate_to_dialogue_tracks(
        self,
        manifest: IngestManifest,
        audio_dir: Path,
        *,
        analysis_start_sec: float = 60.0,
        analysis_duration_sec: float = 90.0,
        extract_start_sec: float | None = None,
        extract_duration_sec: float | None = None,
        align_mode: str = "auto",
        transcript_path: Path | None = None,
    ) -> ConsolidateResult:
        raw_dir = Path(self.ws.project.workspace_dir) / "raw"
        return consolidate_speakers(
            manifest,
            audio_dir,
            raw_dir,
            analysis_start_sec=analysis_start_sec,
            analysis_duration_sec=analysis_duration_sec,
            extract_start_sec=extract_start_sec,
            extract_duration_sec=extract_duration_sec,
            align_mode=align_mode,  # type: ignore[arg-type]
            transcript_path=transcript_path,
        )

    def verify_alignment(
        self,
        *,
        window_start_sec: float = 0.0,
        window_end_sec: float = 90.0,
        overlap_warn_sec: float = 20.0,
        overlap_fail_sec: float = 35.0,
        write_waveforms: bool = True,
        diag_dir: Path | None = None,
    ) -> VerifyResult:
        dialogue = [t for t in self.ws.project.tracks if t.role == TrackRole.DIALOGUE and t.media]
        if len(dialogue) < 2:
            raise CodedValueError(
                "verify requires at least two dialogue tracks",
                code="ingest_verify_needs_two_tracks",
            )

        duration = window_end_sec - window_start_sec
        intervals: dict[str, list[tuple[float, float]]] = {}
        segments_out: list[dict] = []

        for track in dialogue:
            assert track.media is not None
            iv = _timeline_vad_intervals(
                self.ws.project,
                track,
                window_start_sec=window_start_sec,
                window_end_sec=window_end_sec,
            )
            intervals[track.id] = iv
            if iv:
                segments_out.append(
                    {
                        "track_id": track.id,
                        "speaker": track.speaker,
                        "first_speech_sec": round(iv[0][0], 2),
                        "last_speech_sec": round(iv[-1][1], 2),
                        "segment_count": len(iv),
                    }
                )

        ids = [t.id for t in dialogue]
        total_overlap = 0.0
        for i, a in enumerate(ids):
            for b in ids[i + 1 :]:
                total_overlap += simultaneous_speech_sec(intervals[a], intervals[b])

        warnings: list[str] = []
        if total_overlap >= overlap_fail_sec:
            status = "fail"
            warnings.append(
                f"VAD simultaneous speech {total_overlap:.1f}s in "
                f"{window_start_sec}-{window_end_sec}s exceeds fail threshold"
            )
        elif total_overlap >= overlap_warn_sec:
            status = "warn"
            warnings.append(f"VAD simultaneous speech {total_overlap:.1f}s exceeds warn threshold")
        else:
            status = "pass"

        proj_path = str(self.ws.path)
        play_commands = [
            f"podcast play --project {proj_path!r} --source track:{t.id} "
            f"--start {window_start_sec} --end {window_end_sec}"
            for t in dialogue
        ]
        play_commands.append(
            f"podcast play --project {proj_path!r} --compare "
            f"--start {window_start_sec} --end {window_end_sec}"
        )

        waveform_paths: list[str] = []
        if write_waveforms:
            out_dir = diag_dir or (self.ws.project.artifacts_dir() / "alignment")
            track_triples: list[tuple[str, Path, float]] = []
            for track in dialogue:
                assert track.media is not None
                media_path = resolve_under_workspace(self.ws.project, track.media.path)
                file_start = _waveform_file_start(self.ws.project, track)
                track_triples.append((track.speaker or track.id, media_path, file_start))
            wf = render_comparison_waveforms(
                track_triples,
                out_dir,
                window_start_sec=window_start_sec,
                window_duration_sec=duration,
            )
            if wf.stack_path:
                waveform_paths.append(str(wf.stack_path))
            waveform_paths.extend(str(p) for p in wf.per_speaker.values())

        return VerifyResult(
            status=status,
            simultaneous_speech_sec=round(total_overlap, 2),
            window_start_sec=window_start_sec,
            window_end_sec=window_end_sec,
            per_track_segments=segments_out,
            warnings=warnings,
            play_commands=play_commands,
            waveform_paths=waveform_paths,
        )

    def apply_consolidated_tracks(self, result: ConsolidateResult) -> AppliedConsolidation:
        from podcast_mcp.engines.ffmpeg import FFmpegEngine
        from podcast_mcp.engines.track_media import media_asset_from_path

        warnings: list[str] = []
        engine = FFmpegEngine()
        source_durations = {
            source.source: engine.probe(source.source).require_duration_sec()
            for alignment in result.alignments
            for source in alignment.sources
        }
        ws_path = self.ws.project.workspace_path().resolve()
        media_by_speaker = {}
        for name, wav in result.speaker_tracks.items():
            try:
                resolved = resolve_within(ws_path, str(wav))
            except ValueError:
                raise CodedValueError(
                    f"consolidated track must be under workspace: {wav}",
                    code="ingest_track_outside_workspace",
                ) from None
            rel = str(resolved.relative_to(ws_path)).replace("\\", "/")
            media_by_speaker[name] = media_asset_from_path(resolved, store_path=rel)

        def mutate(p) -> None:
            warnings.clear()
            from podcast_mcp.edits.ingest_placement import place_ingest_sources
            from podcast_mcp.engines.clips_ops import new_clip_id, set_track_clips
            from podcast_mcp.engines.track_media import full_span_clip, refresh_timeline_duration

            ws_path = p.workspace_path().resolve()
            p.sources = []
            p.timeline.tracks = []
            p.timeline.clips = []
            align_meta: dict[str, SpeakerIngestAlignment] = {}

            for alignment in result.alignments:
                for i, ar in enumerate(alignment.sources):
                    src_path = ar.source
                    try:
                        rel = str(resolve_within(ws_path, str(src_path)).relative_to(ws_path))
                        rel = rel.replace("\\", "/")
                    except ValueError:
                        rel = src_path.name
                    sid = f"{_track_id(alignment.name)}_src{i}"
                    content = result.cross_speaker_offsets.get(alignment.name, 0.0)
                    p.sources.append(
                        SourceRecording(
                            id=sid,
                            path=rel,
                            speaker=alignment.name,
                            label=src_path.name,
                            offset_sec=content,
                            duration_sec=source_durations[src_path],
                        )
                    )

            for name, media in media_by_speaker.items():
                tid = _track_id(name)
                track = Track(
                    id=tid,
                    label=name,
                    role=TrackRole.DIALOGUE,
                    speaker=name,
                )
                p.timeline.tracks.append(track)
                track.media = media

                speaker_sources = [s for s in p.sources if s.speaker == name]
                durations: list[float] = []
                for src in speaker_sources:
                    dur = float(src.duration_sec or 0.0)
                    durations.append(dur)
                recorded = SpeakerIngestAlignment(
                    session_start_in_file_sec=result.session_start_in_file_sec.get(name, 0.0),
                    content_align_sec=session_content_offset(
                        result.cross_speaker_offsets.get(name, 0.0),
                        result.cross_speaker_align_method.get(name, "unknown"),
                    ),
                    align_method=result.cross_speaker_align_method.get(name, "unknown"),
                )
                placement_sec = (
                    None if result.session_trimmed else recorded.source_to_timeline_shift_sec
                )
                placed = place_ingest_sources(name, durations, placement_sec=placement_sec)
                warnings.extend(placed.warnings)
                multi = len(speaker_sources) > 1
                clips = []
                for src, geo in zip(speaker_sources, placed.geometry, strict=True):
                    clip = Clip(
                        id=new_clip_id(),
                        track_id=tid,
                        source_start=geo.source_start,
                        source_end=geo.source_end,
                        timeline_start=geo.timeline_start,
                        source_id=src.id,
                    )
                    clips.append(clip)
                    meta_key = ingest_alignment_meta_key(p, track, clip, multi_clip=multi)
                    align_meta[meta_key] = recorded.model_copy()
                if not clips:
                    assert media.duration_sec is not None
                    set_track_clips(p, tid, [full_span_clip(tid, media.duration_sec)])
                    refresh_timeline_duration(p)
                    align_meta[name] = recorded.model_copy()
                else:
                    set_track_clips(p, tid, clips)
                    refresh_timeline_duration(p)
            p.meta.ingest_alignment = align_meta or None

        self.ws.mutate("before ingest consolidate", "after ingest consolidate", mutate)
        for track in self.ws.project.tracks:
            schedule_track_waveforms(self.ws.project, track, defaults=self.ws.effective_config())
        return AppliedConsolidation(
            track_ids=[t.id for t in self.ws.project.tracks], warnings=list(warnings)
        )


def suggest_alignment_for_manifest(
    manifest: IngestManifest,
    audio_dir: Path,
    *,
    analysis_start_sec: float = 0.0,
    analysis_duration_sec: float = 90.0,
    sweep_start_min: float = 0.0,
    sweep_start_max: float = 240.0,
    sweep_step: float = 5.0,
    waveform_top_n: int = 3,
    diag_dir: Path | None = None,
) -> SuggestResult:
    groups = manifest.resolve_sources(audio_dir)
    ref_name = manifest.reference_speaker_name()
    ref_path = next(paths[0] for name, paths in groups if name == ref_name)
    guests = [(name, paths[0]) for name, paths in groups if name != ref_name]
    if not guests:
        raise CodedValueError(
            "ingest suggest requires at least one non-reference speaker",
            code="ingest_suggest_needs_speaker",
        )
    candidates_raw = _frange(sweep_start_min, sweep_start_max, sweep_step)
    with resolve_progress_task(
        "ingest.suggest",
        "Suggesting ingest alignment",
        prefer_parent=True,
    ) as progress:
        return _suggest_alignment_for_manifest(
            manifest,
            audio_dir,
            ref_name=ref_name,
            ref_path=ref_path,
            guests=guests,
            candidates_raw=candidates_raw,
            analysis_start_sec=analysis_start_sec,
            analysis_duration_sec=analysis_duration_sec,
            waveform_top_n=waveform_top_n,
            diag_dir=diag_dir,
            progress=progress,
            rms_cache=VADWindowRMSCache(),
        )


def _suggest_alignment_for_manifest(
    manifest: IngestManifest,
    audio_dir: Path,
    *,
    ref_name: str,
    ref_path: Path,
    guests: list[tuple[str, Path]],
    candidates_raw: list[float],
    analysis_start_sec: float,
    analysis_duration_sec: float,
    waveform_top_n: int,
    diag_dir: Path | None,
    progress: ProgressTask,
    rms_cache: VADWindowRMSCache,
) -> SuggestResult:
    ref_start = _manual_session_start(manifest, ref_name)
    out_dir = diag_dir or (workspace_artifacts_dir(audio_dir.parent) / "alignment")

    session_starts: dict[str, float] = {ref_name: ref_start}
    content_offsets: dict[str, float] = {ref_name: 0.0}
    suggest_candidates: list[SuggestCandidate] = []
    waveform_paths: list[str] = []
    drift_warning: str | None = None
    primary_guest = guests[0][0]
    progress.set_phase("preflight", "Checking the selected FFmpeg/FFprobe pair…")
    ffmpeg_pair = resolve_ffmpeg_pair()
    progress.set_phase("candidate_scoring", "Scoring session-start candidates…")

    for guest_index, (guest_name, guest_path) in enumerate(guests, 1):
        progress.set_phase("candidate_scoring", f"Scoring {guest_name} candidates…")
        with progress.child(
            f"ingest.suggest.candidates.{guest_index}",
            f"Scoring {guest_name} session-start candidates",
            total=len(candidates_raw),
        ) as scoring_progress:
            scoring_progress.set_phase(
                "candidate_scoring",
                f"Scoring guest {guest_index}/{len(guests)}: {guest_name}",
            )

            def report_candidate(
                index: int,
                _score,
                guest_name: str = guest_name,
                guest_index: int = guest_index,
                scoring_progress: ProgressTask = scoring_progress,
            ) -> None:
                scoring_progress.advance(
                    1,
                    message=(
                        f"Scored {guest_name} candidate {index}/{len(candidates_raw)} "
                        f"(guest {guest_index}/{len(guests)})"
                    ),
                )

            scored = sweep_session_starts(
                ref_path,
                guest_path,
                candidates_raw,
                session_start_reference=ref_start,
                window_start_sec=analysis_start_sec,
                window_duration_sec=analysis_duration_sec,
                rms_cache=rms_cache,
                ffmpeg_pair=ffmpeg_pair,
                on_candidate_complete=report_candidate,
            )
        best_start = scored[0].session_start_in_file_sec if scored else 0.0
        progress.set_phase("content_offsets", f"Estimating {guest_name} content offset…")
        content_align = sweep_content_offset(
            ref_path,
            guest_path,
            session_start_reference=ref_start,
            session_start_source=best_start,
            window_start_sec=analysis_start_sec,
            window_duration_sec=analysis_duration_sec,
            rms_cache=rms_cache,
            ffmpeg_pair=ffmpeg_pair,
        )
        session_starts[guest_name] = best_start
        content_offsets[guest_name] = content_align

        guest_candidates: list[SuggestCandidate] = []
        for s in scored[: max(waveform_top_n, 1)]:
            progress.set_phase(
                "content_offsets",
                f"Estimating {guest_name} candidate offsets…",
            )
            ca = sweep_content_offset(
                ref_path,
                guest_path,
                session_start_reference=ref_start,
                session_start_source=s.session_start_in_file_sec,
                window_start_sec=analysis_start_sec,
                window_duration_sec=analysis_duration_sec,
                rms_cache=rms_cache,
                ffmpeg_pair=ffmpeg_pair,
            )
            guest_candidates.append(
                SuggestCandidate(
                    session_start_in_file_sec=s.session_start_in_file_sec,
                    content_align_sec=ca,
                    simultaneous_speech_sec=s.simultaneous_speech_sec,
                    correlation_peak=s.correlation_peak,
                )
            )

        # Public candidates / drift / default waveforms stay on the first guest
        # for backward-compatible SuggestResult.shape; all guests still get starts.
        if guest_name == primary_guest:
            suggest_candidates = guest_candidates
            progress.set_phase("drift", "Checking alignment drift…")
            drift = check_drift(
                ref_path,
                guest_path,
                session_start_reference=ref_start,
                session_start_source=best_start,
                window_duration_sec=min(analysis_duration_sec, 60.0),
                window_a_start=analysis_start_sec,
                window_b_start=max(analysis_start_sec + analysis_duration_sec, 240.0),
                rms_cache=rms_cache,
                ffmpeg_pair=ffmpeg_pair,
            )
            drift_warning = drift.warning
            if waveform_top_n > 0:
                progress.set_phase("waveforms", "Rendering alignment comparison waveforms…")
                for cand in guest_candidates[:waveform_top_n]:
                    sub = out_dir / f"sweep_{guest_name}_{int(cand.session_start_in_file_sec)}"
                    tracks = [
                        (ref_name, ref_path, ref_start),
                        (guest_name, guest_path, cand.session_start_in_file_sec),
                    ]
                    wf = render_comparison_waveforms(
                        tracks,
                        sub,
                        window_start_sec=analysis_start_sec,
                        window_duration_sec=min(analysis_duration_sec, 60.0),
                        stack_name=(
                            f"alignment_sweep_{guest_name}_"
                            f"{int(cand.session_start_in_file_sec)}.png"
                        ),
                    )
                    if wf.stack_path:
                        waveform_paths.append(str(wf.stack_path))

    progress.set_phase("finalizing", "Preparing suggested manifest fragment…")
    yaml_snippet = _yaml_snippet_for_manifest(
        manifest, session_starts, content_offsets, primary_guest
    )

    return SuggestResult(
        reference_speaker=ref_name,
        source_speaker=primary_guest,
        recommended_session_starts=session_starts,
        recommended_content_offsets=content_offsets,
        candidates=suggest_candidates,
        yaml_snippet=yaml_snippet,
        waveform_paths=waveform_paths,
        drift_warning=drift_warning,
    )


def _track_id(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s or "speaker"


def _manual_session_start(manifest: IngestManifest, name: str) -> float:
    for g in manifest.speakers:
        if g.name == name and g.session_start_in_file_sec is not None:
            return g.session_start_in_file_sec
    return 0.0


def _frange(start: float, stop: float, step: float) -> list[float]:
    if step <= 0:
        raise CodedValueError("sweep step must be positive", code="ingest_sweep_step_invalid")
    out: list[float] = []
    v = start
    while v <= stop + 1e-9:
        out.append(round(v, 4))
        v += step
    return out


def _yaml_snippet_for_manifest(
    manifest: IngestManifest,
    session_starts: dict[str, float],
    content_offsets: dict[str, float],
    _primary_guest: str,
) -> str:
    lines: list[str] = []
    if manifest.session:
        lines.append("session:")
        if manifest.session.reference_speaker:
            lines.append(f"  reference_speaker: {manifest.session.reference_speaker}")
    lines.append("speakers:")
    for sp in manifest.speakers:
        lines.append(f"  - name: {sp.name}")
        lines.append("    sources:")
        for src in sp.sources:
            lines.append(f'      - "{src}"')
        if sp.name in session_starts:
            lines.append(f"    session_start_in_file_sec: {session_starts[sp.name]}")
        off = content_offsets.get(sp.name, 0.0)
        if sp.name != manifest.reference_speaker_name() and off:
            lines.append(f"    session_offset_sec: {off}")
    return "\n".join(lines) + "\n"


def write_alignment_report(path: Path, rows: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    return path


def suggest_result_to_dict(result: SuggestResult) -> dict:
    return {
        "reference_speaker": result.reference_speaker,
        "source_speaker": result.source_speaker,
        "recommended_session_starts": result.recommended_session_starts,
        "recommended_content_offsets": result.recommended_content_offsets,
        "candidates": [
            {
                "session_start_in_file_sec": c.session_start_in_file_sec,
                "content_align_sec": c.content_align_sec,
                "simultaneous_speech_sec": c.simultaneous_speech_sec,
                "correlation_peak": c.correlation_peak,
            }
            for c in result.candidates
        ],
        "yaml_snippet": result.yaml_snippet,
        "waveform_paths": result.waveform_paths,
        "drift_warning": result.drift_warning,
    }


def import_folder_report_to_dict(result: ImportFolderReport) -> dict:
    return {
        "audio_dir": result.audio_dir,
        "out_manifest": result.out_manifest,
        "dry_run": result.dry_run,
        "vendor_hint": result.vendor_hint,
        "files": result.files,
        "skipped": result.skipped,
        "warnings": result.warnings,
        "next_steps": result.next_steps,
        "written": result.written,
    }


def _apply_speaker_overrides(
    scan: FolderScan, speakers_override: dict[str, str] | None
) -> dict[str, str]:
    """Label every scanned file.

    Files given the same explicit label share one speaker (a host who restarted
    a recording has two takes on one mic). Scan-derived labels that collide, or
    that collide with an explicit label, still get a unique suffix.
    """
    explicit = {
        row.filename: _override_label(row.filename, speakers_override) for row in scan.files
    }
    used = {label for label in explicit.values() if label}
    labels: dict[str, str] = {}
    for index, row in enumerate(scan.files, start=1):
        override = explicit[row.filename]
        if override:
            labels[row.filename] = override
        else:
            labels[row.filename] = _unique_speaker_name(
                row.speaker_label, used, fallback_index=index
            )
    return labels


def _override_label(filename: str, speakers_override: dict[str, str] | None) -> str | None:
    if not speakers_override:
        return None
    if filename in speakers_override:
        return speakers_override[filename]
    stem = Path(filename).stem
    if stem in speakers_override:
        return speakers_override[stem]
    return None


def _unique_speaker_name(name: str, used: set[str], *, fallback_index: int) -> str:
    label = name.strip() or f"speaker_{fallback_index}"
    if label not in used:
        used.add(label)
        return label
    suffix = 2
    while f"{label} {suffix}" in used:
        suffix += 1
    unique = f"{label} {suffix}"
    used.add(unique)
    return unique


def _manifest_from_scan(scan: FolderScan, labels: dict[str, str]) -> IngestManifest:
    sources_by_label: dict[str, list[str]] = {}
    for row in scan.files:
        sources_by_label.setdefault(labels[row.filename], []).append(row.filename)
    speakers = [
        SpeakerGroup(name=name, sources=sources) for name, sources in sources_by_label.items()
    ]
    reference = _pick_reference_speaker(speakers)
    return IngestManifest(
        session=SessionConfig(reference_speaker=reference),
        speakers=speakers,
    )


def _stem_is_host_token(stem: str) -> bool:
    return any(part.lower() == "host" for part in filename_stem_parts(stem))


def _pick_reference_speaker(speakers: list[SpeakerGroup]) -> str:
    for speaker in speakers:
        if any(_stem_is_host_token(Path(src).stem) for src in speaker.sources):
            return speaker.name
    return speakers[0].name


def _write_ingest_manifest(path: Path, manifest: IngestManifest) -> None:
    _assert_manifest_writable(path)
    dest = path.expanduser()
    if dest.is_symlink():
        raise CodedValueError(
            f"refusing to write manifest through symlink: {path}", code="ingest_manifest_symlink"
        )
    data = manifest.model_dump(exclude_none=True)
    if not data.get("align_anchors"):
        data.pop("align_anchors", None)
    if not data.get("exclude"):
        data.pop("exclude", None)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def _normalize_speakers_override(
    speakers_override: dict[str, str] | None,
) -> dict[str, str] | None:
    if not speakers_override:
        return None
    out: dict[str, str] = {}
    for key, value in speakers_override.items():
        label_key = key.strip()
        label_value = value.strip()
        if not label_key or not label_value:
            raise CodedValueError(
                "speakers_override keys and values must be non-empty",
                code="ingest_speakers_override_blank",
            )
        out[label_key] = label_value
    return out


def _import_warnings(
    scan: FolderScan,
    dest: Path,
    *,
    dry_run: bool,
) -> list[str]:
    # Colliding scan labels are suffixed and same-label overrides merge takes, so
    # the scan's duplicate-label warning never describes the written manifest.
    warnings = [w for w in scan.warnings if not w.startswith("duplicate speaker labels")]
    resolved_dest = dest.expanduser()
    if not dry_run and resolved_dest.is_file():
        warnings.append(f"overwriting existing manifest at {resolved_dest}")
    return warnings


def _assert_manifest_writable(path: Path) -> None:
    resolved = path.expanduser().resolve()
    for parent in [resolved, *resolved.parents]:
        if parent.name == "fixtures" and parent.parent.name == "tests":
            raise CodedValueError(
                "refusing to write ingest.yaml under tests/fixtures/",
                code="ingest_manifest_fixture_path",
            )


def _file_row(row: ScannedFile, speaker_label: str) -> dict:
    return {
        "filename": row.filename,
        "speaker_label": speaker_label,
        "duration_sec": round(row.duration_sec, 3),
        "sample_rate": row.sample_rate,
        "channels": row.channels,
    }


def _next_steps(audio_dir: Path, manifest: Path, *, dry_run: bool = False) -> list[str]:
    audio = str(audio_dir)
    man = str(manifest)
    if dry_run:
        return [
            "Re-run without --dry-run to write ingest.yaml, then:",
            f"podcast ingest suggest --audio-dir {audio!r} --manifest {man!r}",
            "Merge suggested session_start_in_file_sec values into ingest.yaml (suggest prints a fragment only)",
            f"podcast ingest consolidate --audio-dir {audio!r} --manifest {man!r} --project {EPISODE_PROJECT_FILENAME}",
        ]
    return [
        f"podcast ingest suggest --audio-dir {audio!r} --manifest {man!r}",
        "Merge suggested session_start_in_file_sec values into ingest.yaml (suggest prints a fragment only)",
        f"podcast ingest consolidate --audio-dir {audio!r} --manifest {man!r} --project {EPISODE_PROJECT_FILENAME}",
        "Or run the pipeline after consolidate (transcribe_tracks → align_tracks)",
    ]


def verify_result_to_dict(result: VerifyResult) -> dict:
    return {
        "status": result.status,
        "simultaneous_speech_sec": result.simultaneous_speech_sec,
        "window_start_sec": result.window_start_sec,
        "window_end_sec": result.window_end_sec,
        "per_track_segments": result.per_track_segments,
        "warnings": result.warnings,
        "play_commands": result.play_commands,
        "waveform_paths": result.waveform_paths,
    }
