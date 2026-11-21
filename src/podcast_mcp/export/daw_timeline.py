"""Saved audio edit geometry shared by editable DAW exporters."""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Generic, TypeVar

from podcast_mcp.engines.clips_ops import clips_for_track
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timed_pieces import expand_timed_pieces
from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
from podcast_mcp.models import Clip, EpisodeProject, FadeCurve
from podcast_mcp.util.workspace_paths import resolve_under_workspace

T = TypeVar("T")


@dataclass(frozen=True)
class DawMedia:
    path: Path
    package_name: str
    sample_rate: int
    channels: int
    frames: int


@dataclass(frozen=True)
class DawItem:
    media: DawMedia
    position_sec: float
    start_frame: int
    end_frame: int
    fade_in_ms: int
    fade_out_ms: int
    fade_in_curve: FadeCurve
    fade_out_curve: FadeCurve
    gain_db: float

    @property
    def length_sec(self) -> float:
        return (self.end_frame - self.start_frame) / self.media.sample_rate


@dataclass(frozen=True)
class DawTrack:
    label: str
    muted: bool
    gain_db: float
    items: tuple[DawItem, ...]


@dataclass(frozen=True)
class DawTimeline:
    tracks: tuple[DawTrack, ...]
    media: tuple[DawMedia, ...]


@dataclass(frozen=True)
class DawPlacement(Generic[T]):
    item: T
    start: int
    end: int
    order: int


@dataclass(frozen=True)
class DawLane(Generic[T]):
    label: str
    items: tuple[T, ...]


def partition_overlapping_items(
    track_label: str,
    placements: Iterable[DawPlacement[T]],
    reserved_labels: set[str],
) -> tuple[DawLane[T], ...]:
    ordered = sorted(placements, key=lambda placement: (placement.start, placement.order))
    lanes: list[list[T]] = []
    lane_ends: list[int] = []
    for placement in ordered:
        lane = next(
            (index for index, lane_end in enumerate(lane_ends) if lane_end <= placement.start),
            None,
        )
        if lane is None:
            lane = len(lanes)
            lanes.append([])
            lane_ends.append(0)
        lanes[lane].append(placement.item)
        lane_ends[lane] = placement.end
    if not lanes:
        lanes.append([])
    result = [DawLane(track_label, tuple(lanes[0]))]
    for lane_index, items in enumerate(lanes[1:], start=1):
        base_label = f"{track_label} (overlap {lane_index})"
        label = base_label
        suffix = 2
        while label in reserved_labels:
            label = f"{base_label} ({suffix})"
            suffix += 1
        reserved_labels.add(label)
        result.append(DawLane(label, tuple(items)))
    return tuple(result)


def _media_for(path: Path, media: dict[Path, DawMedia], engine: FFmpegEngine) -> DawMedia:
    if path not in media:
        if not path.is_file():
            raise FileNotFoundError(path)
        probe = engine.probe(path)
        media[path] = DawMedia(
            path=path,
            package_name=f"media/{len(media) + 1:04d}.wav",
            sample_rate=probe.sample_rate,
            channels=probe.channels,
            frames=round(probe.require_duration_sec() * probe.sample_rate),
        )
    return media[path]


def _item(clip: Clip, media: DawMedia) -> DawItem:
    if (
        not all(
            math.isfinite(value)
            for value in (clip.source_start, clip.source_end, clip.timeline_start)
        )
        or clip.source_start < 0
        or clip.timeline_start < 0
    ):
        raise ValueError(f"Clip {clip.id} has invalid DAW export bounds.")
    start = round(clip.source_start * media.sample_rate)
    end = round(clip.source_end * media.sample_rate)
    if not start < end <= media.frames:
        raise ValueError(f"Clip {clip.id} is outside its DAW export media.")
    return DawItem(
        media,
        clip.timeline_start,
        start,
        end,
        clip.fade_in_ms,
        clip.fade_out_ms,
        clip.fade_in_curve,
        clip.fade_out_curve,
        clip.gain_db,
    )


def build_daw_timeline(project: EpisodeProject) -> DawTimeline:
    """Project the saved audio placement onto editable items and source files."""
    engine = FFmpegEngine()
    media: dict[Path, DawMedia] = {}
    tracks = []
    for track in project.tracks:
        clips, _, _ = expand_timed_pieces(clips_for_track(project, track.id))
        items = [
            _item(clip, _media_for(resolve_clip_audio_path(project, track, clip), media, engine))
            for clip in clips
        ]
        if not clips and not track.timeline_empty and track.media:
            asset = _media_for(resolve_under_workspace(project, track.media.path), media, engine)
            items.append(
                DawItem(asset, 0, 0, asset.frames, 0, 0, FadeCurve.LINEAR, FadeCurve.LINEAR, 0)
            )
        tracks.append(DawTrack(track.label, track.muted, track.output_gain_db, tuple(items)))
    return DawTimeline(tuple(tracks), tuple(media.values()))
