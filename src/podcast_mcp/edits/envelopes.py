"""Pure envelope rules shared by document commands and MCP tools."""

from __future__ import annotations

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
    envelope = project.volume_envelope_for(track_id)
    actual = {p.id: (p.time, p.value) for p in (envelope.points if envelope else [])}
    expected = {
        str(point["id"]): (float(point["time"]), float(point["value"])) for point in expected_points
    }
    return expected == actual
