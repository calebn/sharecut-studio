"""AAF serialization for saved audio timeline geometry."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

from podcast_mcp.export.daw_timeline import (
    DawItem,
    DawPlacement,
    DawTimeline,
    DawTrack,
    partition_overlapping_items,
)
from podcast_mcp.util.coded_error import CodedValueError

AAF_SESSION_NAME = "session.aaf"
_EMPTY_EDIT_RATE = 48_000


@dataclass(frozen=True)
class _PlacedItem:
    item: DawItem
    start: int
    end: int
    order: int


@dataclass(frozen=True)
class _TrackLane:
    label: str
    sample_rate: int
    items: tuple[_PlacedItem, ...]


def _lanes_for_track(track: DawTrack, reserved_labels: set[str]) -> tuple[_TrackLane, ...]:
    rates = {item.media.sample_rate for item in track.items}
    if len(rates) > 1:
        raise CodedValueError(
            f"AAF export needs one sample rate per track. Split mixed-rate media on {track.label!r} into separate tracks.",
            code="aaf_export_mixed_track_rates",
        )
    sample_rate = next(iter(rates), _EMPTY_EDIT_RATE)
    placements = tuple(
        DawPlacement(
            item=placed,
            start=placed.start,
            end=placed.end,
            order=placed.order,
        )
        for placed in (
            _PlacedItem(
                item,
                round(Fraction(str(item.position_sec)) * sample_rate),
                round(Fraction(str(item.position_sec)) * sample_rate)
                + item.end_frame
                - item.start_frame,
                order,
            )
            for order, item in enumerate(track.items)
        )
    )
    lanes = partition_overlapping_items(track.label, placements, reserved_labels)
    return tuple(_TrackLane(lane.label, sample_rate, lane.items) for lane in lanes)


def _timeline_lanes(timeline: DawTimeline) -> tuple[_TrackLane, ...]:
    original_labels = {track.label for track in timeline.tracks}
    reserved_labels = set(original_labels)
    return tuple(
        lane for track in timeline.tracks for lane in _lanes_for_track(track, reserved_labels)
    )


def require_aaf_writer() -> Any:
    try:
        import aaf2
    except ImportError as exc:
        raise CodedValueError(
            "AAF export needs the optional writer. Install the `aaf` extra and try again.",
            code="aaf_export_dependency_missing",
        ) from exc
    return aaf2


def write_aaf(
    timeline: DawTimeline,
    media_paths: Mapping[str, Path],
    destination: Path,
) -> None:
    """Write one AAF with embedded sources and editable, separately placed clips.

    ``media_paths`` contains only validated temporary WAVs owned by the caller. The
    writer never opens project source paths.
    """
    if not media_paths:
        raise CodedValueError("The saved episode has no audio to export.", code="daw_export_empty")
    lanes = _timeline_lanes(timeline)
    timeline_end = max(
        (Fraction(item.end, lane.sample_rate) for lane in lanes for item in lane.items),
        default=Fraction(0),
    )
    aaf2 = require_aaf_writer()

    with aaf2.open(str(destination), "w") as f:
        source_mobs: dict[str, tuple[Any, Any]] = {}
        for asset in timeline.media:
            path = media_paths.get(asset.package_name)
            if path is None:
                raise CodedValueError(
                    "AAF export media preparation is incomplete.", code="aaf_export_media_missing"
                )
            master = f.create.MasterMob(Path(asset.package_name).stem)
            f.content.mobs.append(master)
            imported_slot = master.import_audio_essence(str(path), edit_rate=asset.sample_rate)
            source_mobs[asset.package_name] = (master, imported_slot)

        composition = f.create.CompositionMob("ShareCut")
        composition.usage = "Usage_TopLevel"
        f.content.mobs.append(composition)
        for track_number, lane in enumerate(lanes, start=1):
            if any(ord(char) < 32 for char in lane.label):
                raise CodedValueError(
                    "AAF track names cannot contain control characters.",
                    code="aaf_export_invalid_track_name",
                )
            slot = composition.create_sound_slot(lane.sample_rate)
            slot.name = lane.label
            slot["PhysicalTrackNumber"].value = track_number
            sequence = slot.segment
            cursor = 0
            if not lane.items:
                end = round(timeline_end * lane.sample_rate)
                if end:
                    sequence.components.append(f.create.Filler(media_kind="sound", length=end))
            for placed in lane.items:
                if placed.start > cursor:
                    sequence.components.append(
                        f.create.Filler(media_kind="sound", length=placed.start - cursor)
                    )
                master, source_slot = source_mobs[placed.item.media.package_name]
                clip = master.create_source_clip(
                    source_slot.slot_id,
                    start=placed.item.start_frame,
                    length=placed.item.end_frame - placed.item.start_frame,
                    media_kind="sound",
                )
                sequence.components.append(clip)
                cursor = placed.end
