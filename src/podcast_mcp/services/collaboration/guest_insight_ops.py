"""The Editor's read of the project's edit impact and social clips, shared by the HTTP twins and
the guest MCP tools.

Each function is the body of a ``GUEST_OWNER_ROUTES`` row. It reads the live project, as the host
does (not the share's pinned review version), and answers a key allowlist of the host's
``edit_impact_report`` and social clip candidates. Text that names a host path is withheld: null in
the JSON, ``(withheld)`` in the Markdown. Nothing here writes, so nothing records who asked.
"""

from __future__ import annotations

from typing import Any

from podcast_mcp.clips import list_social_clips
from podcast_mcp.edits import edit_impact_report, format_edit_impact_markdown
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_project_ops import guest_only_keys
from podcast_mcp.services.collaboration.share import drop_absolute_path_strings
from podcast_mcp.util.redact import mentions_host_path

GUEST_LIST_MAX = 500
WITHHELD = "(withheld)"
IMPACT_KEYS = (
    "total_removed_sec",
    "by_track_sec",
    "applied_count",
    "pending_review_count",
    "clip_count",
    "gap_count",
    "timeline_duration_sec",
)
SEGMENT_KEYS = (
    "id",
    "track_id",
    "start",
    "end",
    "duration_sec",
    "reason",
    "applied",
    "review_required",
)
SEGMENT_TEXT_KEYS = ("id", "track_id", "reason")
CLIP_KEYS = (
    "id",
    "track_id",
    "start",
    "end",
    "score",
    "reasons",
    "title_suggestion",
    "caption_suggestion",
    "transcript_excerpt",
    "speaker",
    "review_required",
    "approved",
)
CLIP_TEXT_KEYS = (
    "id",
    "track_id",
    "title_suggestion",
    "caption_suggestion",
    "transcript_excerpt",
    "speaker",
)


def _text(value: Any, mask: str | None = None) -> Any:
    """Free text as the host wrote it, unless it names a host path (then *mask*)."""
    return mask if isinstance(value, str) and mentions_host_path(value) else value


def _segment(row: dict[str, Any], mask: str | None) -> dict[str, Any]:
    segment = guest_only_keys(row, SEGMENT_KEYS)
    for key in SEGMENT_TEXT_KEYS:
        segment[key] = _text(segment[key], mask)
    if mask is not None and segment["reason"] is None:
        segment["reason"] = ""  # the host wrote no reason; the report prints nothing for it
    return segment


def _by_track(by_track: dict[str, float], mask: str | None) -> dict[str, float]:
    out: dict[str, float] = {}
    for tid, sec in by_track.items():
        key = _text(str(tid), mask or WITHHELD)
        out[key] = out.get(key, 0.0) + sec
    return out


def guest_edit_impact_view(ws: ProjectWorkspace, *, markdown: bool) -> dict[str, Any]:
    """Seconds cut, edits applied and pending, and the segments behind them.

    The Markdown is the host's report format over the same filtered view, so a withheld value
    reads ``(withheld)`` and it lists at most 50 segments, as the host's does.
    """
    report = edit_impact_report(ws.project)
    mask = WITHHELD if markdown else None
    rows = report["segments"]
    view: dict[str, Any] = guest_only_keys(report, IMPACT_KEYS)
    view["by_track_sec"] = _by_track(report["by_track_sec"], mask)
    view["segments"] = [_segment(row, mask) for row in rows[:GUEST_LIST_MAX]]
    view["segments_total"] = len(rows)
    view = drop_absolute_path_strings(view)
    if markdown:
        return {"markdown": format_edit_impact_markdown(view)}
    return view


def guest_social_clip_view(
    ws: ProjectWorkspace, *, approved: bool | None, review_required: bool | None
) -> dict[str, Any]:
    """The project's social clip candidates, optionally by approval or review state."""
    found = list_social_clips(ws.project, approved=approved, review_required=review_required)
    clips = []
    for clip in found[:GUEST_LIST_MAX]:
        row = guest_only_keys(clip.model_dump(), CLIP_KEYS)
        for key in CLIP_TEXT_KEYS:
            row[key] = _text(row[key])
        row["reasons"] = [_text(reason) for reason in row["reasons"]]
        row["exported"] = bool(clip.exported_path)
        clips.append(row)
    return {"clips": drop_absolute_path_strings(clips), "total": len(found)}
