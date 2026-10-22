from __future__ import annotations

import math
from dataclasses import dataclass
from heapq import heappop, heappush
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.audio import (
    At,
    Audio,
    BoundaryClock,
    CrossfadeAudio,
    FrameTransform,
    MaskAudio,
    MixAudio,
    OffSpeakerAudio,
    RenderClock,
    RequestedExtent,
    SequenceAudio,
    SourceAudio,
    SourceMuteEnvelope,
    duration,
    postorder,
    rendered_sources,
    sources,
)
from podcast_mcp.engines.bleed_restore import RestoreSupport, active_restore_regions
from podcast_mcp.engines.clips_ops import (
    JOIN_GAP_TOLERANCE_SEC,
    clips_for_track,
    crossfade_borrow_sec,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.gate_fill import current_gate_fill_path
from podcast_mcp.engines.mute_regions import (
    IgnoredWordRegions,
    mute_spans_for_source_window,
    room_tone_fills_for_source_window,
)
from podcast_mcp.engines.render_clock import read_render_clock
from podcast_mcp.engines.session_timeline import clip_timeline_overlap_to_source
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, Track
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.process import run
from podcast_mcp.util.workspace_paths import resolve_under_workspace

if TYPE_CHECKING:
    from podcast_mcp.engines.bleed_gate import BleedGatePlan

RENDER_SEMANTICS_REV = 17


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
            raise CodedValueError(
                f"{owner} source_id {source_id!r} is not in sources[]. Re-ingest the source or fix the clip's source_id.",
                code="clip_source_missing",
            )
        path = resolve_under_workspace(project, src.path)
        if not path.is_file():
            raise FileNotFoundError(f"{owner} source {source_id!r} is missing: {path}")
        return path
    if not track.media:
        raise CodedValueError(
            f"track {track.id} has no media. Add media to that track first.",
            code="track_has_no_media",
        )
    return resolve_under_workspace(project, track.media.path)


def _room_tone_under_mutes(
    project: EpisodeProject, track: Track, clip: Clip, src_start: float, src_end: float
) -> list[At]:
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
                        clip_id=clip.id,
                        source_id=fill.source_id,
                        is_fill=True,
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


def _segment_fade_in(prev: Clip | None, clip: Clip, *, first: bool, blended: bool) -> float:
    # A cut is per join: a track's first clip has no join, so a leftover cut
    # mode (e.g. after its left neighbour was deleted) keeps its fade-in.
    if not first or (prev is not None and clip.join_in_mode == ClipJoinMode.CUT):
        return 0.0
    if blended:
        return 0.0
    return clip.fade_in_ms / 1000.0


def _segment_fade_out(clip: Clip, nxt: Clip | None, *, last: bool, blended: bool) -> float:
    # A cut is per join: the next clip's cut drops this clip's fade-out.
    if not last or (nxt is not None and nxt.join_in_mode == ClipJoinMode.CUT):
        return 0.0
    if blended:
        return 0.0
    return clip.fade_out_ms / 1000.0


def _restore_dependencies(project: EpisodeProject, track: Track, *, defaults: EffectiveConfig):
    if any(
        clip.track_id == track.id
        and (track.transcript_gate or clip.off_speaker_mute_regions)
        and clip.bleed_restore
        and clip.bleed_restore.regions
        for clip in project.clips
    ):
        from podcast_mcp.engines.play_audit import RenderDependencies

        return RenderDependencies.capture(project, track.id, defaults=defaults)
    return None


def render_track_from_timeline(
    project: EpisodeProject,
    track: Track,
    output_path: Path,
    defaults: dict,
    *,
    engine: FFmpegEngine | None = None,
) -> Path:
    if not track.media:
        raise CodedValueError(
            f"track {track.id} has no media. Add media to that track first.",
            code="track_has_no_media",
        )

    dependencies = _restore_dependencies(project, track, defaults=defaults)
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

    return _render_placed_track(
        project,
        track,
        track_clips,
        output_path,
        eng=eng,
        af=af,
        crossfade_curve=crossfade_curve,
        dependencies=dependencies,
        defaults=defaults,
    )


def unfiltered_track_audio(
    project: EpisodeProject, track: Track, defaults: EffectiveConfig
) -> tuple[Audio, str] | None:
    """The tree ``render_track_from_timeline`` renders and its crossfade curve, when that
    render adds no filter, gate or restore step after the tree; else None."""
    clips = clips_for_track(project, track.id)
    envelope = project.volume_envelope_for(track.id)
    if (
        not track.media
        or not clips
        or track.transcript_gate
        or (envelope and envelope.points)
        or any(
            chain.track_id == track.id and any(not fx.bypass for fx in chain.effects)
            for chain in project.processing_chains
        )
    ):
        return None
    curve = str(defaults.get("render", {}).get("crossfade_curve", "tri"))
    return placed_track_audio(project, track, clips).audio, curve


@dataclass(frozen=True)
class _ClipContent:
    timeline_start: float
    timeline_end: float
    body: Audio


@dataclass(frozen=True)
class _PreparedClip:
    clip: Clip
    content: _ClipContent | None
    # Half the blend at the incoming join: the body already starts this far early.
    borrow_in: float = 0.0


@dataclass
class _Component:
    start: float
    audio: Audio
    end: float


@dataclass(frozen=True)
class _PlacedTrack:
    audio: Audio
    extent: RequestedExtent | None
    bodies: tuple[tuple[str, Audio], ...] = ()


def _place_clips(
    prepared: list[_PreparedClip], *, window_length: float | None = None
) -> _PlacedTrack:
    components: list[_Component] = []
    ends: list[tuple[float, int]] = []
    previous_component: int | None = None
    authored_frontier = 0.0
    clock_shift = 0.0
    frontier = 0.0
    for item in prepared:
        content = item.content
        if content is None:
            previous_component = None
            continue
        body = content.body
        body_duration = duration(body)
        if item.borrow_in > 0 and previous_component is not None:
            left = components[previous_component]
            overlap = 2 * item.borrow_in
            left.audio = CrossfadeAudio(left.audio, body, overlap)
            left.end += body_duration - overlap
        else:
            start = max(0.0, content.timeline_start - clock_shift)
            if abs(start - frontier) <= JOIN_GAP_TOLERANCE_SEC:
                start = frontier
            if (
                previous_component is not None
                and abs(start - components[previous_component].end) < 1e-9
            ):
                left = components[previous_component]
                left.audio = SequenceAudio(left.audio, (body,))
                left.end += body_duration
            else:
                components.append(_Component(start, body, start + body_duration))
                previous_component = len(components) - 1
        component = components[previous_component]
        heappush(ends, (-component.end, previous_component))
        while ends and -ends[0][0] != components[ends[0][1]].end:
            heappop(ends)
        frontier = -ends[0][0]
        authored_frontier = max(authored_frontier, content.timeline_end)
        clock_shift = authored_frontier - frontier
    if not components:
        raise CodedValueError(
            "no clips to render. Add a clip to the track first.", code="missing_argument"
        )
    ats = [At(component.start, component.audio) for component in components]
    return _PlacedTrack(
        MixAudio(ats[0], tuple(ats[1:])),
        RequestedExtent(window_length - clock_shift) if window_length is not None else None,
        tuple((item.clip.id, item.content.body) for item in prepared if item.content is not None),
    )


def placed_track_audio(
    project: EpisodeProject,
    track: Track,
    sorted_clips: list[Clip],
    *,
    window: tuple[float, float] | None = None,
    removed_regions: dict[str, tuple[tuple[float, float], ...]] | None = None,
    mask_clocks: dict[str, tuple[BoundaryClock, int, int, tuple[FrameTransform, ...]]]
    | None = None,
    bypass_regions: dict[str, tuple[tuple[float, float], ...]] | None = None,
) -> _PlacedTrack:
    """Build the exact source, envelope and placement graph without rendering or saving."""
    prepared: list[_PreparedClip] = []
    ignored_lookup = IgnoredWordRegions(project)
    clock_origin = window[0] if window else 0.0
    spans: list[tuple[float, float, tuple[float, float] | None]] = []
    for clip in sorted_clips:
        timeline_start = max(window[0], clip.timeline_start) if window else clip.timeline_start
        timeline_end = min(window[1], clip.timeline_end) if window else clip.timeline_end
        spans.append(
            (
                timeline_start,
                timeline_end,
                clip_timeline_overlap_to_source(clip, timeline_start, timeline_end)
                if window
                else (clip.source_start, clip.source_end),
            )
        )
    # A blending join borrows from both recordings, so the lane keeps its clock.
    # `blends[i]` is the full render's borrow at the join into clip i; a window edge
    # does not change whether the join blends, so the edge fades stay off there.
    # `borrow[i]` is what a window can play: no more than either piece has.
    blends = [0.0] * len(sorted_clips)
    borrow = [0.0] * len(sorted_clips)
    for index in range(1, len(sorted_clips)):
        left, right = sorted_clips[index - 1], sorted_clips[index]
        blends[index] = crossfade_borrow_sec(project, left, right)
        left_span, right_span = spans[index - 1], spans[index]
        if (
            blends[index] > 0
            and left_span[2] is not None
            and right_span[2] is not None
            and left_span[1] >= left.timeline_end - 1e-4
            and right_span[0] <= right.timeline_start + 1e-4
        ):
            borrow[index] = min(
                blends[index], left_span[1] - left_span[0], right_span[1] - right_span[0]
            )
    for index, clip in enumerate(sorted_clips):
        timeline_start, timeline_end, source_bounds = spans[index]
        if source_bounds is None:
            prepared.append(_PreparedClip(clip, None))
            continue
        borrow_in = borrow[index]
        borrow_out = borrow[index + 1] if index + 1 < len(sorted_clips) else 0.0
        source_start, source_end = source_bounds
        source_start -= borrow_in
        source_end += borrow_out
        src = resolve_clip_audio_path(project, track, clip)
        fill = gate_fill_paths(project, track, [src])[0]
        ignored = ignored_lookup.for_clip(clip)
        prev = sorted_clips[index - 1] if index else None
        nxt = sorted_clips[index + 1] if index + 1 < len(sorted_clips) else None
        leaf = SourceAudio(
            path=src,
            src_start=source_start,
            src_end=source_end,
            fade_in_sec=(
                _segment_fade_in(prev, clip, first=True, blended=blends[index] > 0)
                if timeline_start <= clip.timeline_start + 1e-4
                else 0.0
            ),
            fade_out_sec=(
                _segment_fade_out(
                    clip, nxt, last=True, blended=index + 1 < len(blends) and blends[index + 1] > 0
                )
                if timeline_end >= clip.timeline_end - 1e-4
                else 0.0
            ),
            mute_spans=mute_spans_for_source_window(clip, source_start, source_end, extra=ignored),
            fill_path=fill,
            clip_id=clip.id,
            source_id=clip.source_id,
        )
        tiles = _room_tone_under_mutes(project, track, clip, source_start, source_end)
        body: Audio = MixAudio(At(0.0, leaf), tuple(tiles)) if tiles else leaf
        if clip.off_speaker_mute_regions:
            body = OffSpeakerAudio(
                body,
                leaf,
                tuple(
                    SourceMuteEnvelope(
                        r.start_s, r.end_s, r.fade_out_ms / 1000, r.fade_in_ms / 1000
                    )
                    for r in clip.off_speaker_mute_regions
                ),
                (bypass_regions or {}).get(clip.id, ()),
            )
        if removed_regions and clip.id in removed_regions:
            windows = tuple(
                (start, end)
                for start, end in removed_regions[clip.id]
                if start < source_end and end > source_start
            )
            if windows:
                clock, first_frame, source_rate, transforms = (mask_clocks or {})[clip.id]
                body = MaskAudio(
                    body, source_start, windows, clock, first_frame, source_rate, transforms
                )
        prepared.append(
            _PreparedClip(
                clip,
                _ClipContent(
                    timeline_start - clock_origin,
                    timeline_end - clock_origin,
                    body,
                ),
                borrow_in,
            )
        )
    return _place_clips(prepared, window_length=window[1] - window[0] if window else None)


def _render_placed_track(
    project: EpisodeProject,
    track: Track,
    sorted_clips: list[Clip],
    output_path: Path,
    *,
    eng: FFmpegEngine,
    af: str,
    crossfade_curve: str = "tri",
    window: tuple[float, float] | None = None,
    staging_gain_db: float = 0.0,
    dependencies=None,
    defaults: EffectiveConfig,
) -> Path:
    placed = placed_track_audio(
        project,
        track,
        sorted_clips,
        window=window,
    )
    start, end = window or (0.0, timeline_duration_sec(project))
    removed: dict[str, tuple[tuple[float, float], ...]] = {}
    clips = {clip.id: clip for clip in sorted_clips}
    if dependencies is not None:
        with batch_scope():
            for source in sources(placed.audio):
                if source.is_fill or source.clip_id is None:
                    continue
                regions = active_restore_regions(clips[source.clip_id], source.path)
                if any(lo < source.src_end and hi > source.src_start for lo, hi in regions):
                    removed[source.clip_id] = regions
        dependencies.validate(project, track.id, defaults=defaults)

    from podcast_mcp.engines.transcript_gated_play import (
        apply_bleed_gate_plan,
        apply_restored_bleed_gate_plan,
        apply_track_transcript_gate,
        build_bleed_gate_plan,
    )

    automatic = bool(removed) and any(
        clips[clip_id].off_speaker_mute_regions for clip_id in removed
    )
    if removed and track.transcript_gate:
        plan = build_bleed_gate_plan(project, track.id, defaults=defaults)
    elif automatic:
        from podcast_mcp.engines.bleed_gate import BleedGatePlan

        plan = BleedGatePlan()
    else:
        plan = None

    def render(audio: Audio, target: Path, clock_path: Path | None = None) -> None:
        temporary = target.with_suffix(".render_tmp.wav") if staging_gain_db else target
        try:
            options = {"clock_path": clock_path} if clock_path is not None else {}
            eng.render_timeline(
                temporary,
                audio,
                af,
                crossfade_curve=crossfade_curve,
                requested_extent=placed.extent,
                **options,
            )
            if staging_gain_db:
                eng.apply_gain(temporary, target, staging_gain_db)
        finally:
            if temporary != target:
                temporary.unlink(missing_ok=True)

    if plan is not None and (plan.attenuation_spans or automatic):
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix=".bleed-restore-", dir=output_path.parent) as directory:
            authored = Path(directory) / "authored.wav"
            whole = Path(directory) / "whole.wav"
            without = Path(directory) / "without.wav"
            whole_clock_path = Path(directory) / "whole-clock.json"
            without_clock_path = Path(directory) / "without-clock.json"
            dependencies.validate(project, track.id, defaults=defaults)
            render(placed.audio, authored if automatic else whole, whole_clock_path)
            if automatic:
                dependencies.validate(project, track.id, defaults=defaults)
                bypassed = placed_track_audio(
                    project, track, sorted_clips, window=window, bypass_regions=removed
                )
                bypass_clock_path = Path(directory) / "bypass-clock.json"
                render(bypassed.audio, whole, bypass_clock_path)
                if read_render_clock(bypass_clock_path) != read_render_clock(whole_clock_path):
                    raise CodedValueError(
                        "Bleed Restore automatic clocks differ", code="bleed_restore_clock_invalid"
                    )
            dependencies.validate(project, track.id, defaults=defaults)
            clock = read_render_clock(whole_clock_path)
            rendered = rendered_sources(placed.audio, clock)
            supports: list[RestoreSupport] = []
            primary = {}
            for rendered_source in rendered:
                if rendered_source.source.is_fill or rendered_source.source.clip_id not in removed:
                    continue
                primary[rendered_source.source.clip_id] = rendered_source
                rate = rendered_source.source_sample_rate
                for lo, hi in removed[rendered_source.source.clip_id]:
                    if (
                        lo >= rendered_source.source.src_end
                        or hi <= rendered_source.source.src_start
                    ):
                        continue
                    supports.append(
                        RestoreSupport(
                            saved_first_frame=math.ceil(lo * rate),
                            saved_last_frame=math.ceil(hi * rate),
                            active_first_frame=max(
                                math.ceil(lo * rate), rendered_source.source_first_frame
                            ),
                            active_last_frame=min(
                                math.ceil(hi * rate), rendered_source.source_last_frame
                            ),
                            source_first_frame=rendered_source.source_first_frame,
                            source_rate=rate,
                            placement_frame=rendered_source.frame(
                                rendered_source.source_first_frame
                            ),
                            placement_rate=clock.nodes[-1].consumer.sample_rate,
                            timeline_origin_sec=start,
                            transforms=rendered_source.transforms,
                        )
                    )
            output_rate = clock.output.sample_rate
            late_affected = any(
                max(
                    s.output_frame(s.active_first_frame, output_rate),
                    math.ceil(lo * output_rate),
                    round(start * output_rate),
                )
                < min(
                    s.output_frame(s.active_last_frame, output_rate),
                    math.ceil(hi * output_rate),
                    round(end * output_rate),
                )
                for s in supports
                for lo, hi in plan.attenuation_spans
            )
            if late_affected:
                node_indices = {id(node): i for i, node in enumerate(postorder(placed.audio))}
                mask_clocks = {}
                for clip_id, body in placed.bodies:
                    if clip_id not in primary:
                        continue
                    body_index = node_indices[id(body)]
                    body_nodes = [
                        node for node in postorder(body) if not isinstance(node, MaskAudio)
                    ]
                    first_node = body_index + 1 - len(body_nodes)
                    first_leaf = sum(
                        isinstance(node, SourceAudio)
                        for node in list(postorder(placed.audio))[:first_node]
                    )
                    count = len(sources(body))
                    local_clock = RenderClock(
                        clock.trims[first_leaf : first_leaf + count],
                        clock.nodes[first_node : body_index + 1],
                        clock.seek_us[first_leaf : first_leaf + count],
                        clock.nodes[body_index].producer,
                        tuple(
                            (i - first_node, child, boundary)
                            for i, child, boundary in clock.delays
                            if first_node <= i <= body_index
                        ),
                    )
                    local_primary = next(
                        source
                        for source in rendered_sources(body, local_clock)
                        if not source.source.is_fill
                    )
                    mask_clocks[clip_id] = (
                        clock.nodes[body_index],
                        primary[clip_id].source_first_frame,
                        primary[clip_id].source_sample_rate,
                        local_primary.transforms[:-1] if automatic else (),
                    )
                counterfactual = placed_track_audio(
                    project,
                    track,
                    sorted_clips,
                    window=window,
                    removed_regions=removed,
                    mask_clocks=mask_clocks,
                    bypass_regions=removed if automatic else None,
                )
                render(counterfactual.audio, without, without_clock_path)
                dependencies.validate(project, track.id, defaults=defaults)
                if read_render_clock(without_clock_path) != clock:
                    raise CodedValueError(
                        "Bleed Restore render clocks differ", code="bleed_restore_clock_invalid"
                    )
            if late_affected or automatic:
                apply_restored_bleed_gate_plan(
                    whole,
                    without if late_affected else None,
                    plan,
                    tuple(supports),
                    timeline_start=start,
                    timeline_end=end,
                    authored_path=authored if automatic else None,
                )
            else:
                apply_bleed_gate_plan(whole, plan, timeline_start=start, timeline_end=end)
            from podcast_mcp.util.atomic_file import publish_completed_file

            dependencies.validate(project, track.id, defaults=defaults)
            publish_completed_file(whole, output_path)
    else:
        if dependencies is None:
            render(placed.audio, output_path)
            if track.transcript_gate:
                apply_track_transcript_gate(
                    project,
                    track.id,
                    output_path,
                    timeline_start=start,
                    timeline_end=end,
                    defaults=defaults,
                )
        else:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with TemporaryDirectory(prefix=".bleed-restore-", dir=output_path.parent) as directory:
                baseline = Path(directory) / "baseline.wav"
                dependencies.validate(project, track.id, defaults=defaults)
                render(placed.audio, baseline)
                if track.transcript_gate:
                    apply_track_transcript_gate(
                        project,
                        track.id,
                        baseline,
                        timeline_start=start,
                        timeline_end=end,
                        defaults=defaults,
                    )
                from podcast_mcp.util.atomic_file import publish_completed_file

                dependencies.validate(project, track.id, defaults=defaults)
                publish_completed_file(baseline, output_path)
    return output_path


def source_fill_mix_filter(
    engine: FFmpegEngine, source: Path, primary_label: str, fill_label: str
) -> str:
    fmt = engine.probe(source).sample_fmt
    restore = f",aformat=sample_fmts={fmt}" if fmt else ""
    return f"{primary_label}{fill_label}amix=inputs=2:normalize=0:duration=first{restore}"


@dataclass(frozen=True)
class SourceChainProcessing:
    recipe: str
    fill: Path | None
    gate: BleedGatePlan


def render_source_with_chain(
    project: EpisodeProject,
    track: Track,
    output_path: Path,
    *,
    engine: FFmpegEngine | None = None,
    selected_source_path: Path | None = None,
    processing: SourceChainProcessing | None = None,
    defaults: EffectiveConfig,
) -> Path:
    """Render FX + optional transcript gate on the full raw source (no timeline edits).

    Used for guest proxy media. Excludes envelope and gain - the client applies
    both (``gui/web/src/audio/gainCurve.ts``).
    A selected recording retains the track's FX, source gate, and fill eligibility.
    """
    if selected_source_path is not None:
        stored_path = str(selected_source_path)
    elif track.media is not None:
        stored_path = track.media.path
    else:
        raise CodedValueError(
            f"track {track.id} has no media. Add media to that track first.",
            code="track_has_no_media",
        )

    eng = engine or FFmpegEngine()
    src = resolve_under_workspace(project, stored_path)
    if not src.is_file():
        raise FileNotFoundError(f"source media missing for track {track.id}: {src}")

    chain = next((c for c in project.processing_chains if c.track_id == track.id), None)
    af = eng.build_track_filter(chain, None) if processing is None else processing.recipe
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fill = gate_fill_paths(project, track, [src])[0] if processing is None else processing.fill
    if fill is None:
        inputs = ["-i", str(src), "-af", af if af else "anull"]
    else:
        graph = f"{source_fill_mix_filter(eng, src, '[0:a]', '[1:a]')},{af or 'anull'}"
        inputs = ["-i", str(src), "-i", str(fill), "-filter_complex", graph]
    cmd = [eng.ffmpeg, "-y", *inputs, "-acodec", "pcm_s16le", str(output_path)]
    run(cmd, check=True, capture_output=True)

    probe = eng.probe(output_path)
    if track.transcript_gate or processing is not None:
        from podcast_mcp.engines.transcript_gated_play import (
            apply_bleed_gate_plan,
            build_bleed_gate_plan,
        )

        plan = (
            build_bleed_gate_plan(project, track.id, source_clock=True, defaults=defaults)
            if processing is None
            else processing.gate
        )
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
        raise CodedValueError(
            "timeline_end must be after timeline_start. Pick a timeline_end later than timeline_start.",
            code="range_end_before_start",
        )

    track = project.track_by_id(track_id)
    if not track:
        raise CodedValueError(
            f"track {track_id!r} not found or has no media", code="track_not_found"
        )
    dependencies = _restore_dependencies(project, track, defaults=defaults)
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

    if not any(
        clip.timeline_end > timeline_start and clip.timeline_start < timeline_end
        for clip in track_clips
    ):
        return eng.silence(output_path, timeline_end - timeline_start)

    _render_placed_track(
        project,
        track,
        track_clips,
        output_path,
        eng=eng,
        af=af,
        crossfade_curve=crossfade_curve,
        window=(timeline_start, timeline_end),
        staging_gain_db=track.gain_db,
        dependencies=dependencies,
        defaults=defaults,
    )
    return output_path
