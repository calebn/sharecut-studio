from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from heapq import heappop, heappush
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING

from podcast_mcp.config.defaults import (
    DEFAULT_MICRO_FADE_MS,
    EffectiveConfig,
    join_micro_fade_ms,
)
from podcast_mcp.engines import room_tone as tone
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
    MuteIndex,
    clips_for_track,
    crossfade_borrow_sec,
)
from podcast_mcp.engines.effect_filters import graph_rate
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.gate_fill import current_gate_fill_path
from podcast_mcp.engines.media_probe import audio_start_sec, probe_media
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.mute_regions import (
    IgnoredWordRegions,
    mute_spans_for_source_window,
    room_tone_fills_for_source_window,
)
from podcast_mcp.engines.render_clock import read_render_clock
from podcast_mcp.engines.room_tone_tiles import tile_span
from podcast_mcp.engines.session_timeline import clip_timeline_overlap_to_source
from podcast_mcp.engines.timed_pieces import TimingHole, expand_timed_clips
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, Track
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.process import run
from podcast_mcp.util.workspace_paths import resolve_under_workspace

if TYPE_CHECKING:
    from podcast_mcp.engines.bleed_gate import BleedGatePlan

RENDER_SEMANTICS_REV = 23
_MAX_GRID_RATE = 192_000


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
        t, end = max(0.0, env.start), min(seg_dur, env.end)
        repeats = tile_span(fill.start_s, fill.end_s, end - t, seed_sec=fill.start_s)
        for index, tile in enumerate(repeats):
            blends_in, blends_out = tile.reach_in > 0, tile.reach_out > 0
            tiles.append(
                At(
                    t - tile.reach_in,
                    SourceAudio(
                        path=path,
                        src_start=tile.source_start - tile.reach_in,
                        src_end=tile.source_start + tile.length + tile.reach_out,
                        fade_in_sec=(
                            2 * tile.reach_in
                            if blends_in
                            else (env.fade_out_sec if t == env.start else 0.0)
                        ),
                        fade_out_sec=(
                            2 * tile.reach_out
                            if blends_out
                            else (
                                env.fade_in_sec
                                if index + 1 == len(repeats) and env.end <= seg_dur + 1e-6
                                else 0.0
                            )
                        ),
                        clip_id=clip.id,
                        source_id=fill.source_id,
                        is_fill=True,
                        reach_in=tile.reach_in,
                        reach_out=tile.reach_out,
                    ),
                )
            )
            t += tile.length
    return tiles


def _hole_fill_paths(project: EpisodeProject, track: Track) -> dict[Path, None]:
    """Files a timing hole's room tone can come from: the track's media and its recorded bed."""
    paths = {_source_audio_path(project, track, None, owner=f"track {track.id}"): None}
    bed = project.source_by_id(tone.room_tone_source_id(track.id)) if track.room_tone else None
    if bed is not None:
        paths[resolve_under_workspace(project, bed.path)] = None
    return paths


def _hole_room_tone(
    project: EpisodeProject, track: Track, hole: TimingHole, gap_sec: float, micro_fade_ms: int
) -> Audio | None:
    """The track's room tone for a hole a positive timing step leaves, None for digital silence.

    The same pick a pad or mute fill takes (``room_tone_span``), only when the track has a
    recorded bed or a pool: a track without either is not measured at render time.
    """
    if track.room_tone is None and not tone.read_room_tone_pool(project, track.id):
        return None
    at = hole.right.source_start
    pick = tone.room_tone_span(
        project,
        track.id,
        near_sec=at,
        near_source_id=hole.parent.source_id,
        duration_sec=gap_sec,
    )
    if isinstance(pick, tone.RecordedBedSample):
        path, source_id, span = pick.path, pick.source_id, (pick.start, pick.end)
    elif isinstance(pick, tone.OwnQuietSample):
        owner = f"clip {hole.parent.id} timing hole"
        path = _source_audio_path(project, track, None, owner=owner)
        source_id, span = None, (pick.sample.start, pick.sample.end)
    else:
        return None
    fade = micro_fade_ms / 1000.0
    tiles = tile_span(span[0], span[1], gap_sec, seed_sec=at)
    ats: list[At] = []
    offset = 0.0
    for tile in tiles:
        ats.append(
            At(
                offset - tile.reach_in,
                SourceAudio(
                    path=path,
                    src_start=tile.source_start - tile.reach_in,
                    src_end=tile.source_start + tile.length + tile.reach_out,
                    fade_in_sec=2 * tile.reach_in if tile.reach_in > 0 else fade,
                    fade_out_sec=2 * tile.reach_out if tile.reach_out > 0 else fade,
                    clip_id=hole.parent.id,
                    source_id=source_id,
                    is_fill=True,
                    reach_in=tile.reach_in,
                    reach_out=tile.reach_out,
                ),
            )
        )
        offset += tile.length
    return MixAudio(ats[0], tuple(ats[1:])) if ats else None


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


def restore_applies(project: EpisodeProject, track: Track, *, gated: bool | None = None) -> bool:
    """Whether the render adds a bleed-restore step after the track's tree.

    ``gated`` overrides the track's transcript gate. Pass False to leave the gate off.
    """
    gated = track.transcript_gate if gated is None else gated
    return any(
        clip.track_id == track.id
        and (gated or clip.off_speaker_mute_regions)
        and clip.bleed_restore
        and clip.bleed_restore.regions
        for clip in project.clips
    )


def _restore_dependencies(project: EpisodeProject, track: Track, *, defaults: EffectiveConfig):
    if restore_applies(project, track):
        if any(clip.track_id == track.id and clip.timing is not None for clip in project.clips):
            raise CodedValueError(
                f"track {track.id} has a clip with a timing map, which Bleed Restore does not "
                "support yet. Remove the restore regions or the timing map.",
                code="timing_map_bleed_restore_unsupported",
            )
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
                source_end=probe.require_duration_sec(),
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


def unfiltered_audio_decline(project: EpisodeProject, track: Track) -> str | None:
    """Return the reason the track's render adds a step after its tree, or None if it adds none."""
    if not track.media or not clips_for_track(project, track.id):
        return "empty"
    envelope = project.volume_envelope_for(track.id)
    if envelope and envelope.points:
        return "envelope"
    if restore_applies(project, track, gated=False):
        return "bleed_restore"
    return None


def unfiltered_track_audio(
    project: EpisodeProject, track: Track, defaults: EffectiveConfig
) -> tuple[Audio, str] | None:
    """Return the tree that ``render_track_from_timeline`` renders, with its crossfade curve.

    Return None if that render, with the gate off and the chain left out, adds a filter or
    restore step after the tree.
    """
    if unfiltered_audio_decline(project, track) is not None:
        return None
    curve = str(defaults.get("render", {}).get("crossfade_curve", "tri"))
    clips = clips_for_track(project, track.id)
    # No engine: this runs on track_evidence cache hits, which must not resolve FFmpeg.
    grid = track_grid(project, track, clips)
    return (
        placed_track_audio(
            project, track, clips, grid=grid, micro_fade_ms=join_micro_fade_ms(defaults)
        ).audio,
        curve,
    )


@dataclass(frozen=True)
class TrackGrid:
    """One integer sample grid for every clip of a track, so a window and the stem agree (#2456).

    ``atrim`` rounds a piece's start and end separately, so pieces cut from float seconds
    drift from ``timeline_start * rate`` and drift differently in a window. Placing every
    clip on whole samples, with source times from ``MediaSeek.sample_time``, makes a joined
    run's pieces sum to the clip edges exactly, whichever clip the render starts at.
    """

    rate: int
    seeks: Mapping[Path, MediaSeek]

    def frame(self, seconds: float) -> int:
        return math.floor(seconds * self.rate + 0.5)

    def source_frame(self, path: Path, seconds: float) -> int:
        return self.seeks[path].first_sample(seconds, self.rate)

    def source_time(self, path: Path, frame: int) -> float:
        return self.seeks[path].sample_time(frame, self.rate)


def track_grid(
    project: EpisodeProject,
    track: Track,
    clips: list[Clip],
    eng: FFmpegEngine | None = None,
    *,
    window: tuple[float, float] | None = None,
    forced_rate: int | None = None,
) -> TrackGrid | None:
    """The grid for ``clips``, or None when their recordings do not share one sample rate.

    ``forced_rate`` (from ``graph_rate``) is the rate the render's pieces run at when the chain
    holds a one-rate filter such as ``arnndn``: FFmpeg then resamples every recording to it
    before ``atrim`` (#2456), so the grid is on that rate whatever the recordings' own, and
    mixed-rate recordings share it. Cutting on the recordings' rate instead leaves the pieces
    to ``atrim`` at the forced rate, which rounds each start and end on its own again.

    A recording that cannot be probed has no rate either; the render reports it. None is only
    for rate reasons; ``audio_start_sec`` can raise ``LateMpegAudioError`` (MPEG-TS/PS) or
    ``CodedValueError`` (probe failed), and that propagates, as the render would fail on it
    anyway.
    ``atrim`` runs at each recording's own rate and ``concat`` resamples to a negotiated
    one, so a single integer grid only exists for one rate. Such a track keeps float
    placement, with delays still on whole samples. A ``window`` decides from every clip of
    the track, not only the clips it overlaps, so a window and the stem always take the same
    placement rule; it only limits the seek table.

    ``eng`` is optional: the container lead is read from the probe cache, not through the
    engine, so a caller that must not resolve FFmpeg on a cache hit passes none.
    """
    lead_of = eng.audio_start_sec if eng is not None else audio_start_sec
    # The grid-or-float choice reads every clip of the track, so a window takes the same
    # placement rule as the stem; only the seek table is limited to the window's clips. A
    # clip outside the window that the window never reads (missing or unprobeable file) is
    # skipped: the stem reports it, and the window renders without it.
    recordings: dict[Path, None] = {}
    others: dict[Path, None] = {}
    optional: dict[Path, None] = {}
    for clip in clips:
        inside = window is None or (
            clip.timeline_end > window[0] and clip.timeline_start < window[1]
        )
        found: dict[Path, None] = {}
        try:
            path = resolve_clip_audio_path(project, track, clip)
            found[path] = None
            if (fill := gate_fill_paths(project, track, [path])[0]) is not None:
                found[fill] = None
            if clip.timing is not None and any(step.delta_sec > 0 for step in clip.timing.steps):
                found.update(_hole_fill_paths(project, track))
            for region in clip.mute_regions:
                if region.fill is not None:
                    owner = f"clip {clip.id} fill"
                    found[
                        _source_audio_path(project, track, region.fill.source_id, owner=owner)
                    ] = None
        except (FileNotFoundError, CodedValueError):
            if inside:
                raise
            continue
        if inside:
            recordings[path] = None
            others.update({fill_path: None for fill_path in found if fill_path != path})
        else:
            optional.update(found)

    def seeks() -> dict[Path, MediaSeek]:
        return {path: MediaSeek.at(0.0, lead_sec=lead_of(path)) for path in recordings}

    if forced_rate is not None:
        return TrackGrid(forced_rate, seeks())
    rates = set()
    for path in (*recordings, *others, *optional):
        probe = probe_media(path)
        if probe is None:
            if path in optional and path not in recordings and path not in others:
                continue
            return None
        rates.add(probe.sample_rate)
    if len(rates) != 1:
        return None
    rate = rates.pop()
    if rate > _MAX_GRID_RATE:
        return None
    return TrackGrid(rate, seeks())


@dataclass(frozen=True)
class _ClipContent:
    timeline_start: float
    timeline_end: float
    body: Audio


@dataclass(frozen=True)
class _PreparedClip:
    clip: Clip
    content: _ClipContent | None
    borrow_in: float = 0.0


@dataclass
class _Component:
    start: float  # frames on a track grid, else seconds
    audio: Audio
    end: float


@dataclass(frozen=True)
class _PlacedTrack:
    audio: Audio
    extent: RequestedExtent | None
    bodies: tuple[tuple[str, Audio], ...] = ()


def _place_clips(
    prepared: list[_PreparedClip],
    *,
    window_length: float | None = None,
    rate: int | None = None,
) -> _PlacedTrack:
    """Lay the prepared clips out in components and mix them.

    With ``rate`` (a track grid) every position and length below is a whole number of
    frames, so the microsecond residual of ``duration()`` cannot accumulate in the frontier
    and move a later component one sample (#2456). Without it they are float seconds.
    """
    scale = rate or 1
    tolerance = JOIN_GAP_TOLERANCE_SEC * scale
    join_epsilon = 0.0 if rate else 1e-9

    def units(seconds: float) -> float:
        return float(round(seconds * scale)) if rate else seconds

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
        body_duration = units(duration(body))
        if item.borrow_in > 0 and previous_component is not None:
            left = components[previous_component]
            overlap = 2 * item.borrow_in
            left.audio = CrossfadeAudio(left.audio, body, overlap)
            left.end += body_duration - units(overlap)
        else:
            start = max(0.0, units(content.timeline_start) - clock_shift)
            if abs(start - frontier) <= tolerance:
                start = frontier
            if (
                previous_component is not None
                and abs(start - components[previous_component].end) <= join_epsilon
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
        authored_frontier = max(authored_frontier, units(content.timeline_end))
        clock_shift = authored_frontier - frontier
    if not components:
        raise CodedValueError(
            "no clips to render. Add a clip to the track first.", code="missing_argument"
        )
    ats = [At(component.start / scale, component.audio) for component in components]
    return _PlacedTrack(
        MixAudio(ats[0], tuple(ats[1:])),
        RequestedExtent((units(window_length) - clock_shift) / scale)
        if window_length is not None
        else None,
        tuple((item.clip.id, item.content.body) for item in prepared if item.content is not None),
    )


def placed_track_audio(
    project: EpisodeProject,
    track: Track,
    sorted_clips: list[Clip],
    *,
    grid: TrackGrid | None,
    window: tuple[float, float] | None = None,
    removed_regions: dict[str, tuple[tuple[float, float], ...]] | None = None,
    mask_clocks: dict[str, tuple[BoundaryClock, int, int, tuple[FrameTransform, ...]]]
    | None = None,
    bypass_regions: dict[str, tuple[tuple[float, float], ...]] | None = None,
    micro_fade_ms: int = DEFAULT_MICRO_FADE_MS,
) -> _PlacedTrack:
    """Build the exact source, envelope and placement graph without rendering or saving.

    A clip with a timing map plays as its virtual pieces; the hole at a positive step is
    filled with the track's room tone, or left as digital silence when the track has none.
    """
    sorted_clips, holes = expand_timed_clips(sorted_clips, micro_fade_ms=micro_fade_ms)
    prepared: list[_PreparedClip] = []
    ignored_lookup = IgnoredWordRegions(project)
    clock_origin = window[0] if window else 0.0
    spans: list[tuple[float, float, tuple[float, float] | None]] = []
    cells: list[tuple[int, int, int] | None] = []
    origin_frame = grid.frame(window[0]) if grid and window else 0
    for clip in sorted_clips:
        if grid is None:
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
            continue
        first, last = grid.frame(clip.timeline_start), grid.frame(clip.timeline_end)
        start, end = first, last
        if window:
            start, end = max(first, origin_frame), min(last, grid.frame(window[1]))
        if end <= start:
            spans.append((start / grid.rate, end / grid.rate, None))
            cells.append(None)
            continue
        path = resolve_clip_audio_path(project, track, clip)
        origin = grid.source_frame(path, clip.source_start) + start - first
        cells.append((start, end, origin))
        spans.append(
            (
                start / grid.rate,
                end / grid.rate,
                (grid.source_time(path, origin), grid.source_time(path, origin + end - start)),
            )
        )
    blends = [0.0] * len(sorted_clips)
    borrow = [0.0] * len(sorted_clips)
    mutes = MuteIndex(project)
    for index in range(1, len(sorted_clips)):
        left, right = sorted_clips[index - 1], sorted_clips[index]
        blends[index] = crossfade_borrow_sec(project, left, right, mutes)
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
            if grid:
                borrow[index] = grid.frame(borrow[index]) / grid.rate
    for index, clip in enumerate(sorted_clips):
        timeline_start, timeline_end, source_bounds = spans[index]
        if source_bounds is None:
            prepared.append(_PreparedClip(clip, None))
            continue
        borrow_in = borrow[index]
        borrow_out = borrow[index + 1] if index + 1 < len(sorted_clips) else 0.0
        src = resolve_clip_audio_path(project, track, clip)
        if grid and (cell := cells[index]):
            start, end, origin = cell
            source_start = grid.source_time(src, origin - grid.frame(borrow_in))
            source_end = grid.source_time(src, origin + end - start + grid.frame(borrow_out))
            placed_start = (start - origin_frame) / grid.rate
            placed_end = (end - origin_frame) / grid.rate
        else:
            source_start, source_end = source_bounds
            source_start -= borrow_in
            source_end += borrow_out
            placed_start, placed_end = timeline_start - clock_origin, timeline_end - clock_origin
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
            reach_in=borrow_in,
            reach_out=borrow_out,
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
                _ClipContent(placed_start, placed_end, body),
                borrow_in,
            )
        )
    if holes:
        prepared = _with_hole_fills(
            project,
            track,
            prepared,
            holes,
            grid=grid,
            window=window,
            origin_frame=origin_frame,
            micro_fade_ms=micro_fade_ms,
        )
    window_length = None
    if window:
        window_length = (
            (grid.frame(window[1]) - origin_frame) / grid.rate if grid else window[1] - window[0]
        )
    return _place_clips(prepared, window_length=window_length, rate=grid.rate if grid else None)


def _with_hole_fills(
    project: EpisodeProject,
    track: Track,
    prepared: list[_PreparedClip],
    holes: dict[int, TimingHole],
    *,
    grid: TrackGrid | None,
    window: tuple[float, float] | None,
    origin_frame: int,
    micro_fade_ms: int,
) -> list[_PreparedClip]:
    """``prepared`` with a room-tone item after each piece that leaves a hole to fill."""
    out: list[_PreparedClip] = []
    for index, item in enumerate(prepared):
        out.append(item)
        hole = holes.get(index)
        if hole is None:
            continue
        if grid is not None:
            first, last = grid.frame(hole.start), grid.frame(hole.end)
            if window:
                first, last = max(first, origin_frame), min(last, grid.frame(window[1]))
            placed = ((first - origin_frame) / grid.rate, (last - origin_frame) / grid.rate)
        else:
            start, end = hole.start, hole.end
            if window:
                start, end = max(start, window[0]), min(end, window[1])
            placed = (start - (window[0] if window else 0.0), end - (window[0] if window else 0.0))
        if placed[1] <= placed[0]:
            continue
        body = _hole_room_tone(project, track, hole, placed[1] - placed[0], micro_fade_ms)
        if body is not None:
            out.append(_PreparedClip(hole.parent, _ClipContent(placed[0], placed[1], body)))
    return out


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
    grid = track_grid(project, track, sorted_clips, eng, window=window, forced_rate=graph_rate(af))
    placed = placed_track_audio(
        project,
        track,
        sorted_clips,
        grid=grid,
        window=window,
        micro_fade_ms=join_micro_fade_ms(defaults),
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
                    project,
                    track,
                    sorted_clips,
                    grid=grid,
                    window=window,
                    bypass_regions=removed,
                    micro_fade_ms=join_micro_fade_ms(defaults),
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
                    grid=grid,
                    window=window,
                    removed_regions=removed,
                    mask_clocks=mask_clocks,
                    bypass_regions=removed if automatic else None,
                    micro_fade_ms=join_micro_fade_ms(defaults),
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
        inputs = ["-i", str(src), "-map", "0:a:0", "-af", af if af else "anull"]
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
                source_end=probe.require_duration_sec(),
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
