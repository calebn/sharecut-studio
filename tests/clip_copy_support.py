"""A Clip with every field set to a non-default value, and a walk over what a copy shares."""

from __future__ import annotations

from enum import Enum
from typing import Any

from podcast_mcp.models import Clip, ClipJoinMode
from podcast_mcp.models.episode import (
    ClipBleedRestore,
    ClipMuteRegion,
    ClipOffSpeakerMuteRegion,
    RoomToneFill,
    SourceSpan,
)

_ATOMS = (str, int, float, bool, type(None), Enum)

_VALUES: dict[str, Any] = {
    "id": "clip_full",
    "track_id": "host",
    "source_start": 1.5,
    "source_end": 9.5,
    "timeline_start": 3.25,
    "source_id": "src_a",
    "fade_in_ms": 7,
    "fade_out_ms": 9,
    "join_in_mode": ClipJoinMode.CROSSFADE,
}


def full_clip() -> Clip:
    """Every field differs from its default, each list holds entries, the first mute region a fill."""
    values = {
        **_VALUES,
        "mute_regions": [
            ClipMuteRegion(
                start_s=2.0, end_s=2.5, fill=RoomToneFill(start_s=0.5, end_s=0.9, source_id="rt")
            ),
            ClipMuteRegion(start_s=4.0, end_s=4.2, gain_db=-12.0, fade_in_ms=3, fade_out_ms=4),
        ],
        "off_speaker_mute_regions": [
            ClipOffSpeakerMuteRegion(start_s=5.0, end_s=5.3, fade_in_ms=2, fade_out_ms=2)
        ],
        "bleed_restore": ClipBleedRestore(
            source_sha256="a" * 64,
            regions=[SourceSpan(start_s=6.0, end_s=6.5), SourceSpan(start_s=7.0, end_s=7.5)],
        ),
    }
    return Clip(**values)


def reachable(value: Any, seen: dict[int, Any] | None = None) -> dict[int, Any]:
    """Every non-atomic object under ``value`` (field sets and private/extra stores included)."""
    seen = {} if seen is None else seen
    if isinstance(value, _ATOMS) or id(value) in seen:
        return seen
    seen[id(value)] = value
    if hasattr(value, "__pydantic_fields_set__"):
        reachable(value.__pydantic_fields_set__, seen)
        for store in (value.__dict__, value.__pydantic_extra__, value.__pydantic_private__):
            reachable(store, seen)
    elif isinstance(value, dict):
        for key, member in value.items():
            reachable(key, seen)
            reachable(member, seen)
    elif isinstance(value, (list, tuple, set, frozenset)):
        for member in value:
            reachable(member, seen)
    return seen


def shared_objects(original: Any, made: Any) -> list[Any]:
    """Mutable objects both values reach (tuples and frozensets cannot be written)."""
    before, after = reachable(original), reachable(made)
    return [
        before[key]
        for key in before.keys() & after.keys()
        if not isinstance(before[key], (tuple, frozenset))
    ]
