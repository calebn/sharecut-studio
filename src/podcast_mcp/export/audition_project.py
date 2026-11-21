from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path, PurePosixPath

from podcast_mcp.export.daw_timeline import (
    DawItem,
    DawLane,
    DawPlacement,
    DawTimeline,
    DawTrack,
    partition_overlapping_items,
)
from podcast_mcp.models import FadeCurve
from podcast_mcp.util.atomic_file import atomic_write
from podcast_mcp.util.coded_error import CodedValueError

AUDITION_SESSION_NAME = "session.sesx"
_FALLBACK_SAMPLE_RATE = 48_000


@dataclass(frozen=True)
class _Media:
    id: int
    path: PurePosixPath
    channels: int
    frames: int


@dataclass(frozen=True)
class _Clip:
    media_id: int
    name: str
    id: int
    z_order: int
    start: int
    end: int
    source_start: int
    source_end: int
    fade_in: int
    fade_out: int


@dataclass(frozen=True)
class _Track:
    id: int
    index: int
    name: str
    clips: tuple[_Clip, ...]


@dataclass(frozen=True)
class AuditionProject:
    sample_rate: int
    media: tuple[_Media, ...]
    tracks: tuple[_Track, ...]
    duration: int
    channel_type: str

    def write(self, destination: Path) -> None:
        root = ET.Element("sesx", {"version": "1.9"})
        session = ET.SubElement(
            root,
            "session",
            {
                "sampleRate": str(self.sample_rate),
                "duration": str(self.duration),
                "audioChannelType": self.channel_type,
                "bitDepth": "32",
            },
        )
        tracks_node = ET.SubElement(session, "tracks")
        for track in self.tracks:
            audio_track = ET.SubElement(
                tracks_node,
                "audioTrack",
                {"index": str(track.index), "id": str(track.id)},
            )
            parameters = ET.SubElement(audio_track, "trackParameters")
            ET.SubElement(parameters, "name").text = track.name
            audio_parameters = ET.SubElement(audio_track, "trackAudioParameters")
            ET.SubElement(
                audio_parameters,
                "trackOutput",
                {"outputID": "1000", "type": "trackID"},
            )
            for clip in track.clips:
                audio_clip = ET.SubElement(
                    audio_track,
                    "audioClip",
                    {
                        "fileID": str(clip.media_id),
                        "name": clip.name,
                        "id": str(clip.id),
                        "zOrder": str(clip.z_order),
                        "startPoint": str(clip.start),
                        "endPoint": str(clip.end),
                        "sourceInPoint": str(clip.source_start),
                        "sourceOutPoint": str(clip.source_end),
                    },
                )
                if clip.fade_in:
                    ET.SubElement(
                        audio_clip,
                        "fadeIn",
                        {"startPoint": "0", "endPoint": str(clip.fade_in), "type": "lin"},
                    )
                if clip.fade_out:
                    ET.SubElement(
                        audio_clip,
                        "fadeOut",
                        {
                            "startPoint": str(clip.end - clip.start - clip.fade_out),
                            "endPoint": str(clip.end - clip.start),
                            "type": "lin",
                        },
                    )
        ET.SubElement(
            tracks_node, "masterTrack", {"index": str(len(self.tracks) + 1), "id": "1000"}
        )
        files = ET.SubElement(root, "files")
        for media in self.media:
            relative_path = media.path.as_posix()
            ET.SubElement(
                files,
                "file",
                {
                    "id": str(media.id),
                    "relativePath": relative_path,
                    "absolutePath": relative_path,
                    "mediaHandler": "AmioWav",
                },
            )
        payload = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        atomic_write(destination, lambda output: output.write(payload))


@dataclass(frozen=True)
class _PlacedClip:
    item: DawItem
    order: int
    start: int
    end: int
    source_start: int
    source_end: int
    fade_in: int
    fade_out: int


def _round_frames(value: Fraction, sample_rate: int) -> int:
    return round(value * sample_rate)


def _fade_frames(
    item: DawItem, duration: int, sample_rate: int, field: str, curve: FadeCurve
) -> int:
    milliseconds = getattr(item, field)
    if milliseconds < 0:
        raise CodedValueError("SESX export found an invalid fade length.", code="sesx_export_fade")
    if not milliseconds:
        return 0
    if curve is not FadeCurve.LINEAR:
        raise CodedValueError(
            "SESX export supports only linear clip fades.", code="sesx_export_fade_curve"
        )
    frames = round(Fraction(milliseconds * sample_rate, 1000))
    if frames > duration:
        raise CodedValueError(
            "SESX export found a fade longer than its clip.", code="sesx_export_fade"
        )
    return frames


def _clip_on_session_clock(item: DawItem, order: int, rate: int) -> _PlacedClip:
    source_start = _round_frames(Fraction(item.start_frame, item.media.sample_rate), rate)
    source_end = _round_frames(Fraction(item.end_frame, item.media.sample_rate), rate)
    start = _round_frames(Fraction(str(item.position_sec)), rate)
    duration = source_end - source_start
    end = start + duration
    if start < 0 or source_start < 0 or source_end <= source_start:
        raise CodedValueError("SESX export found invalid clip bounds.", code="sesx_export_bounds")
    fade_in = _fade_frames(item, duration, rate, "fade_in_ms", item.fade_in_curve)
    fade_out = _fade_frames(item, duration, rate, "fade_out_ms", item.fade_out_curve)
    if fade_in + fade_out > duration:
        raise CodedValueError(
            "SESX export cannot overlap the clip's linear fades.", code="sesx_export_fade_overlap"
        )
    return _PlacedClip(item, order, start, end, source_start, source_end, fade_in, fade_out)


def _lanes(
    track: DawTrack, rate: int, reserved_names: set[str]
) -> tuple[DawLane[_PlacedClip], ...]:
    placements = tuple(
        DawPlacement(clip, clip.start, clip.end, clip.order)
        for order, item in enumerate(track.items)
        for clip in (_clip_on_session_clock(item, order, rate),)
    )
    return partition_overlapping_items(track.label, placements, reserved_names)


def audition_project(timeline: DawTimeline) -> AuditionProject:
    if not timeline.media:
        raise CodedValueError("The saved episode has no audio to export.", code="daw_export_empty")
    rates = {media.sample_rate for media in timeline.media}
    rate = next(iter(rates)) if len(rates) == 1 else _FALLBACK_SAMPLE_RATE
    media_by_package: dict[str, _Media] = {}
    for index, asset in enumerate(timeline.media, start=1):
        path = PurePosixPath(asset.package_name)
        if path.is_absolute() or ".." in path.parts or "\\" in asset.package_name:
            raise CodedValueError(
                "SESX export found an unsafe media path.", code="sesx_export_media_path"
            )
        frames = _round_frames(Fraction(asset.frames, asset.sample_rate), rate)
        media_by_package[asset.package_name] = _Media(index, path, asset.channels, frames)
    reserved_names = {track.label for track in timeline.tracks}
    lanes = tuple(lane for track in timeline.tracks for lane in _lanes(track, rate, reserved_names))
    projected_tracks: list[_Track] = []
    for index, lane in enumerate(lanes, start=1):
        if any(ord(char) < 32 for char in lane.label):
            raise CodedValueError(
                "SESX track names cannot contain control characters.", code="sesx_export_track_name"
            )
        clips = tuple(
            _Clip(
                media_by_package[placed.item.media.package_name].id,
                f"{lane.label} {clip_index + 1}",
                clip_index,
                clip_index,
                placed.start,
                placed.end,
                placed.source_start,
                placed.source_end,
                placed.fade_in,
                placed.fade_out,
            )
            for clip_index, placed in enumerate(lane.items)
        )
        for clip, placed in zip(clips, lane.items, strict=True):
            packaged = media_by_package[placed.item.media.package_name]
            if clip.source_end > packaged.frames:
                raise CodedValueError(
                    "SESX clip bounds exceed the converted WAV media.",
                    code="sesx_export_bounds",
                )
        projected_tracks.append(_Track(1000 + index, index, lane.label, clips))
    duration = max((clip.end for track in projected_tracks for clip in track.clips), default=0)
    channels = {media.channels for media in media_by_package.values()}
    channel_type = "stereo" if any(channel > 1 for channel in channels) else "mono"
    return AuditionProject(
        rate,
        tuple(media_by_package.values()),
        tuple(projected_tracks),
        duration,
        channel_type,
    )
