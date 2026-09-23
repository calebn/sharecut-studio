from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.clips_ops import JOIN_GAP_TOLERANCE_SEC, clips_abut, clips_for_track
from podcast_mcp.edits.mute_regions import mute_spans_for_source_window
from podcast_mcp.engines.ffmpeg import FFmpegEngine, PlacedSegment
from podcast_mcp.engines.session_timeline import clip_timeline_overlap_to_source
from podcast_mcp.models import Clip, ClipJoinMode, EditDecision, EpisodeProject, Track
from podcast_mcp.util.process import run
from podcast_mcp.util.workspace_paths import resolve_under_workspace

# Bump whenever rendered audio changes for the same project state (join rules,
# fade/crossfade semantics, gap handling). ``track_render_hash`` includes it so
# cached stems and play segments rendered under older rules go stale.
# 2: sub-tolerance (<= JOIN_GAP_TOLERANCE_SEC) gaps on CROSSFADE joins now crossfade.
RENDER_SEMANTICS_REV = 2


def resolve_clip_audio_path(
    project: EpisodeProject,
    track: Track,
    clip: Clip,
) -> Path:
    """Media file for a clip: sources[source_id] when set, else track.media.

    Resolved paths must stay under the project workspace.
    """
    if clip.source_id:
        src = next((s for s in project.sources if s.id == clip.source_id), None)
        if src is None:
            raise ValueError(f"clip {clip.id} source_id {clip.source_id!r} is not in sources[]")
        path = resolve_under_workspace(project, src.path)
        if not path.is_file():
            raise FileNotFoundError(f"clip {clip.id} source {clip.source_id!r} is missing: {path}")
        return path
    if not track.media:
        raise ValueError(f"track {track.id} has no media")
    return resolve_under_workspace(project, track.media.path)


def timeline_duration_sec(project: EpisodeProject) -> float:
    end = 0.0
    for clip in project.clips:
        end = max(end, clip.timeline_end)
    if end > 0:
        return end
    for track in project.tracks:
        if track.media and track.media.duration_sec:
            end = max(end, track.media.duration_sec)
    return end


def edits_for_clip_source(
    edits: list[EditDecision],
    track_id: str,
    clip: Clip,
) -> list[EditDecision]:
    """Keep edit decisions that overlap this clip, in clip-local source time."""
    mapped: list[EditDecision] = []
    for e in edits:
        if e.track_id != track_id or not e.applied:
            continue
        if e.end <= clip.source_start or e.start >= clip.source_end:
            continue
        mapped.append(
            e.model_copy(
                update={
                    "start": max(clip.source_start, e.start) - clip.source_start,
                    "end": min(clip.source_end, e.end) - clip.source_start,
                }
            )
        )
    return mapped


def _uses_crossfade_join(prev: Clip, clip: Clip) -> bool:
    if clip.join_in_mode != ClipJoinMode.CROSSFADE:
        return False
    if not clips_abut(prev, clip):
        return False
    return prev.fade_out_ms > 0 and clip.fade_in_ms > 0


def _crossfade_ms_at_join(left: Clip, right: Clip) -> int:
    if not _uses_crossfade_join(left, right):
        return 0
    vals = [left.fade_out_ms, right.fade_in_ms]
    return max(min(vals), max(vals) // 2)


def _segment_fade_in(prev: Clip | None, clip: Clip, *, first: bool) -> float:
    if not first or clip.join_in_mode == ClipJoinMode.CUT:
        return 0.0
    if prev is not None and _uses_crossfade_join(prev, clip):
        return 0.0
    return clip.fade_in_ms / 1000.0


def _segment_fade_out(clip: Clip, nxt: Clip | None, *, last: bool) -> float:
    if not last or clip.join_in_mode == ClipJoinMode.CUT:
        return 0.0
    if nxt is not None and _uses_crossfade_join(clip, nxt):
        return 0.0
    return clip.fade_out_ms / 1000.0


def render_track_from_timeline(
    project: EpisodeProject,
    track: Track,
    output_path: Path,
    defaults: dict,
    *,
    engine: FFmpegEngine | None = None,
) -> Path:
    """Render a track from timeline clips, applying edit decisions in source time."""
    if not track.media:
        raise ValueError(f"track {track.id} has no media")

    eng = engine or FFmpegEngine()
    primary = resolve_under_workspace(project, track.media.path)

    track_clips = clips_for_track(project, track.id)
    if not track_clips:
        probe = eng.probe(primary)
        track_clips = [
            Clip(
                id=f"clip_{track.id}_full",
                track_id=track.id,
                source_start=0.0,
                source_end=probe.duration_sec,
                timeline_start=0.0,
            )
        ]

    crossfade_curve = str(defaults.get("render", {}).get("crossfade_curve", "tri"))
    chain = next((c for c in project.processing_chains if c.track_id == track.id), None)
    env = next((e for e in project.automation_envelopes if e.track_id == track.id), None)
    af = eng.build_track_filter(chain, env)

    timeline_edits = [e for e in project.edit_decisions if e.track_id == track.id]

    paths = [resolve_clip_audio_path(project, track, c) for c in track_clips]
    multi_source = len({p.resolve() for p in paths}) > 1

    if multi_source:
        return _render_multi_source_track(
            project,
            track,
            track_clips,
            paths,
            output_path,
            eng=eng,
            af=af,
            timeline_edits=timeline_edits,
        )

    src = paths[0] if paths else primary
    placed: list[PlacedSegment] = []
    for i, clip in enumerate(track_clips):
        mapped = edits_for_clip_source(timeline_edits, track.id, clip)
        segments = eng.segments_after_edits(
            clip.source_end - clip.source_start,
            mapped,
            track.id,
        )
        prev = track_clips[i - 1] if i > 0 else None
        nxt = track_clips[i + 1] if i < len(track_clips) - 1 else None
        crossfade_prev = _crossfade_ms_at_join(prev, clip) / 1000.0 if prev is not None else 0.0

        gap_before = 0.0
        overlap_prev = 0.0
        if prev is not None and crossfade_prev <= 0:
            gap = clip.timeline_start - prev.timeline_end
            if gap > JOIN_GAP_TOLERANCE_SEC:
                gap_before = gap
            elif gap < -JOIN_GAP_TOLERANCE_SEC:
                overlap_prev = -gap

        for si, seg in enumerate(segments):
            first = si == 0
            last = si == len(segments) - 1
            placed.append(
                PlacedSegment(
                    src_start=seg.start + clip.source_start,
                    src_end=seg.end + clip.source_start,
                    fade_in_sec=_segment_fade_in(prev, clip, first=first),
                    fade_out_sec=_segment_fade_out(clip, nxt, last=last),
                    gap_before_sec=gap_before if first else 0.0,
                    crossfade_prev_sec=crossfade_prev if first else 0.0,
                    overlap_prev_sec=overlap_prev if first else 0.0,
                    mute_spans=mute_spans_for_source_window(
                        clip,
                        seg.start + clip.source_start,
                        seg.end + clip.source_start,
                    ),
                )
            )

    lead_in = track_clips[0].timeline_start if track_clips else 0.0
    eng.render_timeline(
        src,
        output_path,
        placed,
        af,
        crossfade_curve=crossfade_curve,
        lead_in_sec=lead_in if lead_in > JOIN_GAP_TOLERANCE_SEC else 0.0,
    )
    if track.transcript_gate:
        from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate

        dur = timeline_duration_sec(project)
        apply_track_transcript_gate(
            project,
            track.id,
            output_path,
            timeline_start=0.0,
            timeline_end=dur,
        )
    return output_path


def _render_multi_source_track(
    project: EpisodeProject,
    track: Track,
    sorted_clips: list[Clip],
    paths: list[Path],
    output_path: Path,
    *,
    eng: FFmpegEngine,
    af: str,
    timeline_edits: list,
) -> Path:
    """Whole-file clips from different sources: extract, adelay onto the session, amix."""
    import shutil
    import tempfile

    from podcast_mcp.util.process import run as _run

    delayed: list[Path] = []
    tmp_dir = Path(tempfile.mkdtemp(prefix="daw_multi_src_"))
    try:
        for i, (clip, src) in enumerate(zip(sorted_clips, paths, strict=True)):
            mapped = edits_for_clip_source(timeline_edits, track.id, clip)
            segments = eng.segments_after_edits(
                clip.source_end - clip.source_start,
                mapped,
                track.id,
            )
            clip_parts: list[Path] = []
            for si, seg in enumerate(segments):
                part = tmp_dir / f"clip_{i}_{si}.wav"
                src_start = seg.start + clip.source_start
                src_end = seg.end + clip.source_start
                eng.extract_segment(
                    src,
                    part,
                    src_start,
                    src_end,
                    mute_spans=mute_spans_for_source_window(clip, src_start, src_end),
                )
                clip_parts.append(part)
            if not clip_parts:
                continue
            joined = clip_parts[0] if len(clip_parts) == 1 else tmp_dir / f"clip_{i}.wav"
            if len(clip_parts) > 1:
                eng.join_audio_parts(clip_parts, joined)
            delay_ms = max(0, round(clip.timeline_start * 1000.0))
            placed = tmp_dir / f"delayed_{i}.wav"
            if delay_ms > 0:
                _run(
                    [
                        eng.ffmpeg,
                        "-y",
                        "-i",
                        str(joined),
                        "-af",
                        f"adelay={delay_ms}:all=1",
                        str(placed),
                    ],
                    check=True,
                    capture_output=True,
                )
            else:
                placed = joined
            delayed.append(placed)

        raw_out = tmp_dir / "mixed.wav"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not delayed:
            raise ValueError(f"no clips to render for track {track.id}")
        if len(delayed) == 1:
            shutil.copy2(delayed[0], raw_out)
        else:
            cmd: list[str] = [eng.ffmpeg, "-y"]
            for p in delayed:
                cmd.extend(["-i", str(p)])
            n = len(delayed)
            ins = "".join(f"[{i}]" for i in range(n))
            cmd.extend(
                [
                    "-filter_complex",
                    f"{ins}amix=inputs={n}:duration=longest:normalize=0",
                    str(raw_out),
                ]
            )
            _run(cmd, check=True, capture_output=True)
        if af and af != "anull":
            _run(
                [
                    eng.ffmpeg,
                    "-y",
                    "-i",
                    str(raw_out),
                    "-af",
                    af,
                    str(output_path),
                ],
                check=True,
                capture_output=True,
            )
        else:
            shutil.copy2(raw_out, output_path)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    if track.transcript_gate:
        from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate

        dur = timeline_duration_sec(project)
        apply_track_transcript_gate(
            project,
            track.id,
            output_path,
            timeline_start=0.0,
            timeline_end=dur,
        )
    return output_path


def render_source_with_chain(
    project: EpisodeProject,
    track: Track,
    output_path: Path,
    *,
    engine: FFmpegEngine | None = None,
) -> Path:
    """Render FX + optional transcript gate on the full raw source (no timeline edits).

    Used for guest proxy media. Excludes envelope and gain - the client applies
    gain; envelopes are a known approximation on the guest path.
    """
    if not track.media:
        raise ValueError(f"track {track.id} has no media")

    eng = engine or FFmpegEngine()
    src = resolve_under_workspace(project, track.media.path)
    if not src.is_file():
        raise FileNotFoundError(f"source media missing for track {track.id}: {src}")

    chain = next((c for c in project.processing_chains if c.track_id == track.id), None)
    af = eng.build_track_filter(chain, None)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        eng.ffmpeg,
        "-y",
        "-i",
        str(src),
        "-af",
        af if af else "anull",
        "-acodec",
        "pcm_s16le",
        str(output_path),
    ]
    run(cmd, check=True, capture_output=True)

    probe = eng.probe(output_path)
    if track.transcript_gate:
        from podcast_mcp.engines.transcript_gated_play import (
            gate_rendered_wav,
            source_word_intervals,
        )

        intervals = source_word_intervals(project, track.id, 0.0, probe.duration_sec)
        gate_rendered_wav(
            output_path,
            intervals,
            timeline_start=0.0,
            timeline_end=probe.duration_sec,
        )
    return output_path


def render_track_segment(
    project: EpisodeProject,
    track_id: str,
    timeline_start: float,
    timeline_end: float,
    output_path: Path,
    defaults: dict,
    *,
    engine: FFmpegEngine | None = None,
) -> Path:
    """Render [timeline_start, timeline_end] with edits, chains, gaps, and gain.

    Timeline holes (``insert_gap`` / filler replace pads) must appear as silence
    in the output - same placement rules as full-stem ``render_track_from_timeline``.
    """
    if timeline_end <= timeline_start:
        raise ValueError("timeline_end must be after timeline_start")

    track = project.track_by_id(track_id)
    if not track or not track.media:
        raise ValueError(f"track {track_id!r} not found or has no media")

    eng = engine or FFmpegEngine()
    src = resolve_under_workspace(project, track.media.path)

    track_clips = clips_for_track(project, track.id)
    if not track_clips:
        probe = eng.probe(src)
        track_clips = [
            Clip(
                id=f"clip_{track.id}_full",
                track_id=track.id,
                source_start=0.0,
                source_end=probe.duration_sec,
                timeline_start=0.0,
            )
        ]

    crossfade_curve = str(defaults.get("render", {}).get("crossfade_curve", "tri"))
    chain = next((c for c in project.processing_chains if c.track_id == track.id), None)
    env = next((e for e in project.automation_envelopes if e.track_id == track.id), None)
    af = eng.build_track_filter(chain, env)
    timeline_edits = [e for e in project.edit_decisions if e.track_id == track.id]

    overlapping: list[tuple[Clip, float, float]] = []
    for clip in track_clips:
        ov_tl_start = max(timeline_start, clip.timeline_start)
        ov_tl_end = min(timeline_end, clip.timeline_end)
        if ov_tl_end > ov_tl_start:
            overlapping.append((clip, ov_tl_start, ov_tl_end))

    if not overlapping:
        raise ValueError(
            f"no audio in timeline range {timeline_start}-{timeline_end} for {track_id}"
        )

    placed: list[PlacedSegment] = []
    timeline_cursor = timeline_start
    for clip, ov_tl_start, ov_tl_end in overlapping:
        src_bounds = clip_timeline_overlap_to_source(clip, ov_tl_start, ov_tl_end)
        if src_bounds is None:
            continue
        src_start, src_end = src_bounds
        mapped = edits_for_clip_source(timeline_edits, track.id, clip)
        segs = eng.segments_after_edits(
            clip.source_end - clip.source_start,
            mapped,
            track.id,
        )

        clip_i = track_clips.index(clip)
        prev = track_clips[clip_i - 1] if clip_i > 0 else None
        nxt = track_clips[clip_i + 1] if clip_i + 1 < len(track_clips) else None
        crossfade_prev = _crossfade_ms_at_join(prev, clip) / 1000.0 if prev is not None else 0.0

        gap_before = ov_tl_start - timeline_cursor
        if gap_before <= JOIN_GAP_TOLERANCE_SEC or crossfade_prev > 0:
            gap_before = 0.0

        # Fade only when this window includes the real clip edge (not a mid-clip seek).
        at_clip_start = ov_tl_start <= clip.timeline_start + 1e-4
        at_clip_end = ov_tl_end >= clip.timeline_end - 1e-4

        contributing: list[tuple[float, float]] = []
        for seg in segs:
            abs_start = seg.start + clip.source_start
            abs_end = seg.end + clip.source_start
            isect_start = max(abs_start, src_start)
            isect_end = min(abs_end, src_end)
            if isect_end > isect_start:
                contributing.append((isect_start, isect_end))

        for si, (isect_start, isect_end) in enumerate(contributing):
            first = si == 0
            last = si == len(contributing) - 1
            placed.append(
                PlacedSegment(
                    src_start=isect_start,
                    src_end=isect_end,
                    fade_in_sec=(
                        _segment_fade_in(prev, clip, first=True) if first and at_clip_start else 0.0
                    ),
                    fade_out_sec=(
                        _segment_fade_out(clip, nxt, last=True) if last and at_clip_end else 0.0
                    ),
                    gap_before_sec=gap_before if first else 0.0,
                    crossfade_prev_sec=crossfade_prev if first else 0.0,
                    overlap_prev_sec=0.0,
                    mute_spans=mute_spans_for_source_window(clip, isect_start, isect_end),
                )
            )
            gap_before = 0.0

        timeline_cursor = ov_tl_end

    if not placed:
        raise ValueError(
            f"no audio in timeline range {timeline_start}-{timeline_end} for {track_id}"
        )

    tmp = output_path.with_suffix(".render_tmp.wav") if track.gain_db else output_path
    eng.render_timeline(
        src,
        tmp,
        placed,
        af,
        crossfade_curve=crossfade_curve,
        lead_in_sec=0.0,
    )
    if track.gain_db:
        eng.apply_gain(tmp, output_path, track.gain_db)
        tmp.unlink(missing_ok=True)
    if track.transcript_gate:
        from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate

        apply_track_transcript_gate(
            project,
            track_id,
            output_path,
            timeline_start=timeline_start,
            timeline_end=timeline_end,
        )
    return output_path
