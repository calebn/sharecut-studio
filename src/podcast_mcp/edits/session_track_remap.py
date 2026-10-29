"""Move one person's staged takes of a pending session suggestion to another track."""

from __future__ import annotations

from podcast_mcp.edits.session_suggestions import find_session_suggestion, staged_take_key
from podcast_mcp.engines.room_tone import room_tone_source_id
from podcast_mcp.models import EpisodeProject


def remap_staged_participant(
    project: EpisodeProject,
    suggestion_id: str,
    *,
    source_ids: set[str],
    bed_path: str,
    track_id: str,
    track_label: str,
    old_track_id: str | None = None,
) -> int:
    """Point the takes with ``source_ids`` and the bed at ``bed_path`` at ``track_id``.

    Sources and files stay as they are; only the track each staged piece will land on (and the
    speaker name of its source) changes. A replace's ``track_ids`` follow the person from
    ``old_track_id``, and ``track_follows`` remembers where from. Returns how many staged pieces
    moved.
    """
    suggestion = find_session_suggestion(project, suggestion_id)
    moved = 0
    for take in suggestion.takes:
        if take.source_id in source_ids and (take.track_id, take.track_label) != (
            track_id,
            track_label,
        ):
            take.track_id, take.track_label = track_id, track_label
            moved += 1
        source = project.source_by_id(take.source_id) if take.source_id in source_ids else None
        if source is not None:
            source.speaker = track_label
    suggestion.takes.sort(key=staged_take_key)
    if old_track_id is not None and old_track_id in suggestion.track_ids:
        # A replace names the tracks it covers; follow the person so Accept still finds them.
        swapped = [track_id if t == old_track_id else t for t in suggestion.track_ids]
        suggestion.track_ids = list(dict.fromkeys(swapped))
        origin = suggestion.track_follows.pop(old_track_id, old_track_id)
        if origin != track_id:
            suggestion.track_follows[track_id] = origin
    for bed in suggestion.room_tone:
        if bed.path == bed_path and bed.track_id != track_id:
            bed.track_id, bed.track_label = track_id, track_label
            bed.source_id = room_tone_source_id(track_id)
            moved += 1
    return moved
