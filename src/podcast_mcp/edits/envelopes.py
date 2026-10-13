"""Pure envelope rules shared by document commands and MCP tools."""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from typing import Any

from podcast_mcp.models import EpisodeProject


def volume_envelope_baseline(project: EpisodeProject, track_id: str) -> list[dict[str, Any]]:
    """Current volume points as a ``SetEnvelope`` ``expected_points`` baseline."""
    envelope = project.volume_envelope_for(track_id)
    if envelope is None:
        return []
    return [{"id": p.id, "time": p.time, "value": p.value} for p in envelope.points]


def envelope_matches_baseline(
    project: EpisodeProject,
    track_id: str,
    expected_points: Iterable[Mapping[str, Any]],
) -> bool:
    """True when *expected_points* is exactly the track's current volume envelope.

    Floats compare exactly on purpose: clients must echo the baseline verbatim
    from the server's JSON (doubles round-trip unchanged). Rounding or clamping
    a baseline before sending it would turn every edit into a permanent conflict.
    Callers reject duplicate point IDs before this check (payload validation).
    """
    expected = [
        {"id": str(point["id"]), "time": float(point["time"]), "value": float(point["value"])}
        for point in expected_points
    ]
    return expected == volume_envelope_baseline(project, track_id)


def envelope_time_range_message(timeline_end: float) -> str:
    """The one sentence every caller shows for an out-of-range envelope point time.

    The end is floored to a millisecond so the text never names a time the check refuses.
    """
    end = math.floor(max(timeline_end, 0.0) * 1000) / 1000
    return f"Time must be from 0 to {end:.12g} seconds, the end of the timeline."


def validate_envelope_point_times(
    project: EpisodeProject,
    track_id: str,
    points: Iterable[Mapping[str, Any]],
    timeline_end: float,
) -> None:
    """Refuse a new or moved point whose time is outside ``[0, timeline_end]``.

    A point that keeps its saved ``(id, time)`` is exempt: a cut can shorten the
    timeline under points already saved, and those must not block edits to the rest
    of the envelope.
    """
    saved = {(p["id"], p["time"]) for p in volume_envelope_baseline(project, track_id)}
    for point in points:
        time = float(point["time"])
        if (str(point.get("id")), time) in saved:
            continue
        if not 0.0 <= time <= timeline_end:
            raise ValueError(envelope_time_range_message(timeline_end))
