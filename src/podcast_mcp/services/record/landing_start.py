"""A session that starts the episode: its audio takes time 0 and everything else moves later.

The session's length is where its own clips end. Each land opens only the time its new clips add
past that point, so the earlier session lands, the clips already on the timeline and their
review state stay put relative to each other. Dropping the session's last audio takes the time
back out.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping
from typing import Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.session_gap import close_session_gap, open_session_gap
from podcast_mcp.engines.ranges import SPAN_EPS_S
from podcast_mcp.models import Clip, EpisodeProject
from podcast_mcp.services.record.landing_math import record_source_prefix


def own_extent_s(clips: Iterable[Clip], session_id: str) -> float:
    """Where the session's own clips end (0 when it has none)."""
    prefix = record_source_prefix(session_id)
    return max(
        (c.timeline_end for c in clips if (c.source_id or "").startswith(prefix)), default=0.0
    )


def is_start_session(project: EpisodeProject, session_id: str) -> bool:
    return any(
        row.session_id == session_id and row.target_kind == "start"
        for row in project.editorial.record_sessions
    )


def open_start_gap(
    project: EpisodeProject,
    session_id: str,
    items: Iterable[Mapping[str, Any]],
    *,
    defaults: EffectiveConfig,
    keep_comment_ids: Collection[str],
) -> list[str]:
    """Move everything after the session's audio to make room for ``items`` (their clips are placed next).

    Returns the tracks that moved, empty when the new clips fit inside the session's length.
    """
    before = own_extent_s(project.clips, session_id)
    after = max(
        (float(item["timeline_s"]) + float(item["duration_s"]) for item in items), default=before
    )
    prefix = record_source_prefix(session_id)
    others = any(not (c.source_id or "").startswith(prefix) for c in project.clips)
    if after - before <= SPAN_EPS_S or not others:
        return []
    track_ids = [track.id for track in project.tracks]
    open_session_gap(
        project,
        before,
        after - before,
        track_ids,
        defaults=defaults,
        keep_comment_ids=keep_comment_ids,
    )
    return track_ids


def close_start_tail(
    project: EpisodeProject,
    session_id: str,
    extent_before: float,
    *,
    defaults: EffectiveConfig,
    keep_comment_ids: Collection[str],
) -> bool:
    """Take back the time the session no longer fills; False when other audio sits in it."""
    extent_now = own_extent_s(project.clips, session_id)
    if extent_before - extent_now <= SPAN_EPS_S:
        return False
    return close_session_gap(
        project,
        extent_now,
        extent_before,
        [track.id for track in project.tracks],
        defaults=defaults,
        keep_comment_ids=keep_comment_ids,
    )
