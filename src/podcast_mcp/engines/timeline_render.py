from __future__ import annotations

from dataclasses import dataclass
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
from podcast_mcp.engines.audio import (
    At,
    Audio,
    CrossfadeAudio,
    MixAudio,
    SequenceAudio,
    SilenceAudio,
    SourceAudio,
    duration,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.media_seek import MediaSeek
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
# 14: saved-neighbor crossfades extend connected components before independent mixing.
RENDER_SEMANTICS_REV = 14


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
) -> list[At]:
    """Room-tone tiles for ``clip``'s filled mutes in the segment ``[src_start, src_end)``.

    Each tile is placed inside its owner piece and mixed over
    the hole: the fill fades in while the clip fades out at the region's start and
    fades out while the clip fades back in at its end.
    """
    seg_dur = src_end - src_start
    tiles: list[At] = []
    for env, fill in room_tone_fills_for_source_window(clip, src_start, src_end):
        path = _source_audio_path(project, track, fill.source_id, owner=f"clip {clip.id} fill")
        piece = fill.end_s - fill.start_s
        t, end = max(0.0, env.start), min(seg_dur, env.end)
        while t < end - 1e-6:
            use = min(piece, end - t)
            tiles.append(
                At(
                    t,
                    SourceAudio(
                        path=path,
                        src_start=fill.start_s,
                        src_end=fill.start_s + use,
                        fade_in_sec=env.fade_out_sec if t == env.start else 0.0,
                        fade_out_sec=env.fade_in_sec if t + use >= env.end - 1e-6 else 0.0,
                    ),
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

    return _render_placed_track(
        project,
        track,
        track_clips,
        output_path,
        eng=eng,
        af=af,
        timeline_edits=timeline_edits,
        crossfade_curve=crossfade_curve,
    )


@dataclass(frozen=True)
class _ClipContent:
    timeline_start: float
    timeline_end: float
    head: Audio
    tail: tuple[Audio, ...]

    @property
    def body(self) -> Audio:
        return SequenceAudio(self.head, self.tail) if self.tail else self.head


@dataclass(frozen=True)
class _PreparedClip:
    clip: Clip
    content: _ClipContent | None


def _place_clips(prepared: list[_PreparedClip], *, window_length: float | None = None) -> Audio:
    components: list[At] = []
    previous_component: int | None = None
    authored_frontier = 0.0
    clock_shift = 0.0
    for index, item in enumerate(prepared):
        content = item.content
        if content is None:
            previous_component = None
            continue
        prev = prepared[index - 1].clip if index else None
        crossfade = crossfade_ms_at_join(prev, item.clip) / 1000.0 if prev else 0.0
        if crossfade > 0 and previous_component is not None:
            left = components[previous_component]
            overlap = max(0.001, min(crossfade, duration(content.head) * 0.5))
            components[previous_component] = At(
                left.start_sec, CrossfadeAudio(left.audio, content.body, overlap)
            )
        else:
            start = max(0.0, content.timeline_start - clock_shift)
            if components:
                frontier = max(at.start_sec + duration(at.audio) for at in components)
                if abs(start - frontier) <= JOIN_GAP_TOLERANCE_SEC:
                    start = frontier
            elif start <= JOIN_GAP_TOLERANCE_SEC:
                start = 0.0
            components.append(At(start, content.body))
            previous_component = len(components) - 1
        authored_frontier = max(authored_frontier, content.timeline_end)
        frontier = max(at.start_sec + duration(at.audio) for at in components)
        clock_shift = authored_frontier - frontier
    if not components:
        raise ValueError("no clips to render")
    if window_length is not None:
        components.append(At(0.0, SilenceAudio(window_length - clock_shift)))
    return MixAudio(components[0], tuple(components[1:]))


def _render_placed_track(
    project: EpisodeProject,
    track: Track,
    sorted_clips: list[Clip],
    output_path: Path,
    *,
    eng: FFmpegEngine,
    af: str,
    timeline_edits: list[EditDecision],
    crossfade_curve: str = "tri",
    window: tuple[float, float] | None = None,
) -> Path:
    prepared: list[_PreparedClip] = []
    ignored_lookup = IgnoredWordRegions(project)
    clock_origin = window[0] if window else 0.0
    for index, clip in enumerate(sorted_clips):
        timeline_start = max(window[0], clip.timeline_start) if window else clip.timeline_start
        timeline_end = min(window[1], clip.timeline_end) if window else clip.timeline_end
        source_bounds = (
            clip_timeline_overlap_to_source(clip, timeline_start, timeline_end)
            if window
            else (clip.source_start, clip.source_end)
        )
        if source_bounds is None:
            prepared.append(_PreparedClip(clip, None))
            continue
        source_start, source_end = source_bounds
        mapped = edits_for_clip_source(timeline_edits, track.id, clip)
        segments = eng.segments_after_edits(clip.source_end - clip.source_start, mapped, track.id)
        contributing = [
            (
                max(seg.start + clip.source_start, source_start),
                min(seg.end + clip.source_start, source_end),
            )
            for seg in segments
            if min(seg.end + clip.source_start, source_end)
            > max(seg.start + clip.source_start, source_start)
        ]
        if not contributing:
            prepared.append(_PreparedClip(clip, None))
            continue
        src = resolve_clip_audio_path(project, track, clip)
        fill = gate_fill_paths(project, track, [src])[0]
        ignored = ignored_lookup.for_clip(clip)
        prev = sorted_clips[index - 1] if index else None
        nxt = sorted_clips[index + 1] if index + 1 < len(sorted_clips) else None
        pieces: list[Audio] = []
        for si, (src_start, src_end) in enumerate(contributing):
            if window is not None and si == len(contributing) - 1 and timeline_end == window[1]:
                # The old window trim bounded fractional terminal samples to this extent.
                rate = eng.probe(src).sample_rate
                seek = MediaSeek.at(min(start for start, _end in contributing))
                first_sample = seek.first_sample(src_start, rate)
                selected_samples = int((src_end - src_start) * rate + 1e-6)
                src_end = min(src_end, (first_sample + selected_samples) / rate)
            leaf = SourceAudio(
                path=src,
                src_start=src_start,
                src_end=src_end,
                fade_in_sec=(
                    _segment_fade_in(prev, clip, first=True)
                    if si == 0 and timeline_start <= clip.timeline_start + 1e-4
                    else 0.0
                ),
                fade_out_sec=(
                    _segment_fade_out(clip, nxt, last=True)
                    if si == len(contributing) - 1 and timeline_end >= clip.timeline_end - 1e-4
                    else 0.0
                ),
                mute_spans=mute_spans_for_source_window(clip, src_start, src_end, extra=ignored),
                fill_path=fill,
            )
            tiles = _room_tone_under_mutes(project, track, clip, src_start, src_end)
            pieces.append(MixAudio(At(0.0, leaf), tuple(tiles)) if tiles else leaf)
        prepared.append(
            _PreparedClip(
                clip,
                _ClipContent(
                    timeline_start - clock_origin,
                    timeline_end - clock_origin,
                    pieces[0],
                    tuple(pieces[1:]),
                ),
            )
        )
    audio = _place_clips(prepared, window_length=window[1] - window[0] if window else None)
    eng.render_timeline(output_path, audio, af, crossfade_curve=crossfade_curve)
    if track.transcript_gate and window is None:
        from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate

        apply_track_transcript_gate(
            project,
            track.id,
            output_path,
            timeline_start=0.0,
            timeline_end=timeline_duration_sec(project),
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

    if not any(
        clip.timeline_end > timeline_start and clip.timeline_start < timeline_end
        for clip in track_clips
    ):
        return eng.silence(output_path, timeline_end - timeline_start)

    tmp = output_path.with_suffix(".render_tmp.wav") if track.gain_db else output_path
    _render_placed_track(
        project,
        track,
        track_clips,
        tmp,
        eng=eng,
        af=af,
        timeline_edits=timeline_edits,
        crossfade_curve=crossfade_curve,
        window=(timeline_start, timeline_end),
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
