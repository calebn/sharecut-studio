from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.clips_ops import (
    JOIN_GAP_TOLERANCE_SEC,
    clips_for_track,
    crossfade_ms_at_join,
    uses_crossfade_join,
)
from podcast_mcp.edits.gate_fill import current_gate_fill_path
from podcast_mcp.edits.mute_regions import (
    IgnoredWordRegions,
    mute_spans_for_source_window,
    room_tone_fills_for_source_window,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine, PlacedSegment
from podcast_mcp.engines.session_timeline import clip_timeline_overlap_to_source
from podcast_mcp.models import Clip, ClipJoinMode, EditDecision, EpisodeProject, Track
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.process import run
from podcast_mcp.util.workspace_paths import resolve_under_workspace

# Bump whenever rendered audio changes for the same project state (join rules,
# fade/crossfade semantics, gap handling). ``track_render_hash`` includes it so
# cached stems and play segments rendered under older rules go stale.
# 2: sub-tolerance (<= JOIN_GAP_TOLERANCE_SEC) gaps on CROSSFADE joins now crossfade.
# 3: a cut is per join; the next clip's cut drops the left clip's fade-out (a clip's
#    own cut join no longer drops its fade-out).
# 5: segment renders resolve the selected source media for each clip.
# 6: multi-source renders preserve per-clip fades and apply the transcript gate once.
# 7: multi-source placement follows the accumulated render clock and preserves
#    full-lane join context in segment renders.
# 8: every segment window uses the same placement assembly, including one-source windows.
# 9: reset the sample clock after overlap mixing before concatenating later segments.
# 12: every input seeks through MediaSeek, so .m4a windows start on their sample (#1141).
# 13: full tracks share accumulated placement, including nested one-source overlaps.
RENDER_SEMANTICS_REV = 13


def resolve_clip_audio_path(
    project: EpisodeProject,
    track: Track,
    clip: Clip,
) -> Path:
    """Media file for a clip: sources[source_id] when set, else track.media.

    Resolved paths must stay under the project workspace.
    """
    return _source_audio_path(project, track, clip.source_id, owner=f"clip {clip.id}")


def _source_audio_path(
    project: EpisodeProject, track: Track, source_id: str | None, *, owner: str
) -> Path:
    if source_id:
        src = project.source_by_id(source_id)
        if src is None:
            raise ValueError(f"{owner} source_id {source_id!r} is not in sources[]")
        path = resolve_under_workspace(project, src.path)
        if not path.is_file():
            raise FileNotFoundError(f"{owner} source {source_id!r} is missing: {path}")
        return path
    if not track.media:
        raise ValueError(f"track {track.id} has no media")
    return resolve_under_workspace(project, track.media.path)


def _room_tone_under_mutes(
    project: EpisodeProject, track: Track, clip: Clip, src_start: float, src_end: float
) -> list[PlacedSegment]:
    """Room-tone tiles for ``clip``'s filled mutes in the segment ``[src_start, src_end)``.

    Placed right after that segment, each tile overlaps back into it and is mixed over
    the hole: the fill fades in while the clip fades out at the region's start and
    fades out while the clip fades back in at its end.
    """
    seg_dur = src_end - src_start
    tiles: list[PlacedSegment] = []
    for env, fill in room_tone_fills_for_source_window(clip, src_start, src_end):
        path = _source_audio_path(project, track, fill.source_id, owner=f"clip {clip.id} fill")
        piece = fill.end_s - fill.start_s
        t, end = max(0.0, env.start), min(seg_dur, env.end)
        while t < end - 1e-6:
            use = min(piece, end - t)
            tiles.append(
                PlacedSegment(
                    src_start=fill.start_s,
                    src_end=fill.start_s + use,
                    fade_in_sec=env.fade_out_sec if t == env.start else 0.0,
                    fade_out_sec=env.fade_in_sec if t + use >= env.end - 1e-6 else 0.0,
                    overlap_prev_sec=seg_dur - t,
                    source_path=path,
                )
            )
            t += use
    return tiles


def gate_fill_paths(project: EpisodeProject, track: Track, paths: list[Path]) -> list[Path | None]:
    """The track's gate fill for each clip path over its own media, else None (#1111)."""
    fill = current_gate_fill_path(project, track)
    if fill is None or track.media is None:
        return [None] * len(paths)
    primary = resolve_under_workspace(project, track.media.path).resolve()
    return [fill if same_recording(path, primary) else None for path in paths]


def timeline_duration_sec(project: EpisodeProject) -> float:
    end = project.timeline.duration_sec or 0.0
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


def _segment_fade_in(prev: Clip | None, clip: Clip, *, first: bool) -> float:
    # A cut is per join: a track's first clip has no join, so a leftover cut
    # mode (e.g. after its left neighbour was deleted) keeps its fade-in.
    if not first or (prev is not None and clip.join_in_mode == ClipJoinMode.CUT):
        return 0.0
    if prev is not None and uses_crossfade_join(prev, clip):
        return 0.0
    return clip.fade_in_ms / 1000.0


def _segment_fade_out(clip: Clip, nxt: Clip | None, *, last: bool) -> float:
    # A cut is per join: the next clip's cut drops this clip's fade-out.
    if not last or (nxt is not None and nxt.join_in_mode == ClipJoinMode.CUT):
        return 0.0
    if nxt is not None and uses_crossfade_join(clip, nxt):
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
    if not track_clips and track.timeline_empty:
        return eng.silence(
            output_path, max(0.05, project.timeline.duration_sec or timeline_duration_sec(project))
        )
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
    env = project.volume_envelope_for(track.id)
    af = eng.build_track_filter(chain, env)

    timeline_edits = [e for e in project.edit_decisions if e.track_id == track.id]

    paths = [resolve_clip_audio_path(project, track, c) for c in track_clips]
    return _render_placed_track(
        project,
        track,
        track_clips,
        paths,
        output_path,
        eng=eng,
        af=af,
        timeline_edits=timeline_edits,
        crossfade_curve=crossfade_curve,
    )


def _render_placed_track(
    project: EpisodeProject,
    track: Track,
    sorted_clips: list[Clip],
    paths: list[Path],
    output_path: Path,
    *,
    eng: FFmpegEngine,
    af: str,
    timeline_edits: list,
    crossfade_curve: str = "tri",
    window: tuple[float, float] | None = None,
    context_clips: list[Clip] | None = None,
    clip_indices: list[int] | None = None,
) -> Path:
    placed: list[PlacedSegment] = []
    ignored_lookup = IgnoredWordRegions(project)
    lane_clips = context_clips if context_clips is not None else sorted_clips
    lane_indices = clip_indices if clip_indices is not None else list(range(len(sorted_clips)))
    if len(lane_indices) != len(sorted_clips):
        raise ValueError("clip_indices must align with sorted_clips")
    running_end: float | None = None
    authored_frontier = 0.0
    clock_shift = 0.0
    clock_origin = window[0] if window is not None else 0.0
    fills = gate_fill_paths(project, track, paths)

    for clip_i, (clip, src) in enumerate(zip(sorted_clips, paths, strict=True)):
        timeline_start = clip.timeline_start
        timeline_end = clip.timeline_end
        source_start = clip.source_start
        source_end = clip.source_end
        if window is not None:
            timeline_start = max(window[0], clip.timeline_start)
            timeline_end = min(window[1], clip.timeline_end)
            if timeline_end <= timeline_start:
                continue
            source_bounds = clip_timeline_overlap_to_source(clip, timeline_start, timeline_end)
            if source_bounds is None:
                continue
            source_start, source_end = source_bounds

        ignored = ignored_lookup.for_clip(clip)
        mapped = edits_for_clip_source(timeline_edits, track.id, clip)
        segments = eng.segments_after_edits(
            clip.source_end - clip.source_start,
            mapped,
            track.id,
        )
        lane_i = lane_indices[clip_i]
        prev = lane_clips[lane_i - 1] if lane_i > 0 else None
        nxt = lane_clips[lane_i + 1] if lane_i + 1 < len(lane_clips) else None
        crossfade_prev = crossfade_ms_at_join(prev, clip) / 1000.0 if prev is not None else 0.0
        effective_start = timeline_start - clock_origin - clock_shift
        gap_before = 0.0
        overlap_prev = 0.0
        if running_end is None:
            gap_before = max(0.0, effective_start)
        elif crossfade_prev <= 0:
            delta = effective_start - running_end
            if delta > JOIN_GAP_TOLERANCE_SEC:
                gap_before = delta
            elif delta < -JOIN_GAP_TOLERANCE_SEC:
                overlap_prev = -delta

        at_clip_start = timeline_start <= clip.timeline_start + 1e-4
        at_clip_end = timeline_end >= clip.timeline_end - 1e-4
        contributing: list[tuple[float, float]] = []
        for seg in segments:
            src_start = max(seg.start + clip.source_start, source_start)
            src_end = min(seg.end + clip.source_start, source_end)
            if src_end > src_start:
                contributing.append((src_start, src_end))

        for si, (src_start, src_end) in enumerate(contributing):
            first = si == 0
            last = si == len(contributing) - 1
            placed.append(
                PlacedSegment(
                    src_start=src_start,
                    src_end=src_end,
                    fade_in_sec=(
                        _segment_fade_in(prev, clip, first=True) if first and at_clip_start else 0.0
                    ),
                    fade_out_sec=(
                        _segment_fade_out(clip, nxt, last=True) if last and at_clip_end else 0.0
                    ),
                    gap_before_sec=gap_before if first else 0.0,
                    crossfade_prev_sec=crossfade_prev if first else 0.0,
                    overlap_prev_sec=overlap_prev if first else 0.0,
                    mute_spans=mute_spans_for_source_window(
                        clip, src_start, src_end, extra=ignored
                    ),
                    source_path=src,
                    fill_path=fills[clip_i],
                )
            )
            placed.extend(_room_tone_under_mutes(project, track, clip, src_start, src_end))
            duration = src_end - src_start
            if running_end is None:
                running_end = gap_before + duration
            elif first and crossfade_prev > 0:
                actual_crossfade = max(0.001, min(crossfade_prev, duration * 0.5))
                running_end += duration - actual_crossfade
            elif first and overlap_prev > 0:
                delay = max(0.0, running_end - min(overlap_prev, running_end))
                running_end = max(running_end, delay + duration)
            elif first and gap_before > 0:
                running_end += gap_before + duration
            else:
                running_end += duration
            gap_before = 0.0

        if contributing and running_end is not None:
            authored_frontier = max(authored_frontier, timeline_end - clock_origin)
            clock_shift = authored_frontier - running_end

    if not placed:
        raise ValueError(f"no clips to render for track {track.id}")

    lead_in = placed[0].gap_before_sec
    if window is None:
        lead_in = (
            sorted_clips[0].timeline_start
            if sorted_clips[0].timeline_start > JOIN_GAP_TOLERANCE_SEC
            else 0.0
        )
    eng.render_timeline(
        paths[0],
        output_path,
        placed,
        af,
        crossfade_curve=crossfade_curve,
        lead_in_sec=lead_in,
        output_duration_sec=(window[1] - window[0] - clock_shift) if window is not None else None,
    )

    if track.transcript_gate and window is None:
        from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate

        dur = timeline_duration_sec(project)
        apply_track_transcript_gate(
            project,
            track.id,
            output_path,
            timeline_start=0.0 if window is None else window[0],
            timeline_end=dur if window is None else window[1],
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
    fill = gate_fill_paths(project, track, [src])[0]
    if fill is None:
        inputs = ["-i", str(src), "-af", af if af else "anull"]
    else:
        fmt = eng.probe(src).sample_fmt
        restore = f",aformat=sample_fmts={fmt}" if fmt else ""
        graph = f"[0:a][1:a]amix=inputs=2:normalize=0:duration=first{restore},{af or 'anull'}"
        inputs = ["-i", str(src), "-i", str(fill), "-filter_complex", graph]
    cmd = [eng.ffmpeg, "-y", *inputs, "-acodec", "pcm_s16le", str(output_path)]
    run(cmd, check=True, capture_output=True)

    probe = eng.probe(output_path)
    if track.transcript_gate:
        from podcast_mcp.engines.transcript_gated_play import (
            apply_bleed_gate_plan,
            build_bleed_gate_plan,
        )

        plan = build_bleed_gate_plan(project, track.id, source_clock=True)
        apply_bleed_gate_plan(
            output_path,
            plan,
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
    if not track:
        raise CodedValueError(
            f"track {track_id!r} not found or has no media", code="track_not_found"
        )
    track_clips = clips_for_track(project, track.id)
    if not track_clips and track.timeline_empty:
        return (engine or FFmpegEngine()).silence(output_path, timeline_end - timeline_start)
    if not track_clips:
        if not track.media:
            raise CodedValueError(
                f"track {track_id!r} not found or has no media", code="track_has_no_media"
            )
        primary = resolve_under_workspace(project, track.media.path)
        eng = engine or FFmpegEngine()
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
    else:
        eng = engine or FFmpegEngine()

    crossfade_curve = str(defaults.get("render", {}).get("crossfade_curve", "tri"))
    chain = next((c for c in project.processing_chains if c.track_id == track.id), None)
    env = project.volume_envelope_for(track.id)
    af = eng.build_track_filter(chain, env, timeline_origin_sec=timeline_start)
    timeline_edits = [e for e in project.edit_decisions if e.track_id == track.id]

    overlapping: list[tuple[int, Clip, float, float]] = []
    for clip_i, clip in enumerate(track_clips):
        ov_tl_start = max(timeline_start, clip.timeline_start)
        ov_tl_end = min(timeline_end, clip.timeline_end)
        if ov_tl_end > ov_tl_start:
            overlapping.append((clip_i, clip, ov_tl_start, ov_tl_end))

    if not overlapping:
        return eng.silence(output_path, timeline_end - timeline_start)

    overlapping_clips = [clip for _, clip, _, _ in overlapping]
    source_paths = [resolve_clip_audio_path(project, track, clip) for clip in overlapping_clips]
    tmp = output_path.with_suffix(".render_tmp.wav") if track.gain_db else output_path
    _render_placed_track(
        project,
        track,
        overlapping_clips,
        source_paths,
        tmp,
        eng=eng,
        af=af,
        timeline_edits=timeline_edits,
        crossfade_curve=crossfade_curve,
        window=(timeline_start, timeline_end),
        context_clips=track_clips,
        clip_indices=[clip_i for clip_i, _, _, _ in overlapping],
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
