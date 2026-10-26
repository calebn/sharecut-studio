"""Record sessions staged for an insert or replace target: find, stage, discard and skip."""

from __future__ import annotations

from podcast_mcp.models import (
    EpisodeProject,
    SessionSuggestion,
    StagedComment,
    StagedTake,
)
from podcast_mcp.util.coded_error import CodedKeyError, CodedValueError

SUGGESTION_STATUSES = ("pending", "skipped", "accepted")


def session_suggestion_id(session_id: str) -> str:
    return f"ss-{session_id}"


def find_session_suggestion(project: EpisodeProject, suggestion_id: str) -> SessionSuggestion:
    for row in project.editorial.session_suggestions:
        if row.id == suggestion_id:
            return row
    raise CodedKeyError(
        f"unknown session suggestion: {suggestion_id}", code="session_suggestion_not_found"
    )


def list_session_suggestions(
    project: EpisodeProject, *, status: str | None = None
) -> list[SessionSuggestion]:
    if status is not None and status not in SUGGESTION_STATUSES:
        raise CodedValueError(
            f"status must be one of {', '.join(SUGGESTION_STATUSES)}", code="invalid_status"
        )
    rows = project.editorial.session_suggestions
    return [row for row in rows if status is None or row.status == status]


def staged_take_key(take: StagedTake) -> tuple[int, str, int]:
    return take.take_index, take.track_id, take.segment_index


def ensure_session_suggestion(
    project: EpisodeProject, proposed: SessionSuggestion
) -> SessionSuggestion:
    """The stored suggestion with ``proposed``'s id, appending ``proposed`` when there is none."""
    for row in project.editorial.session_suggestions:
        if row.id == proposed.id:
            return row
    project.editorial.session_suggestions.append(proposed)
    return proposed


def upsert_staged_take(suggestion: SessionSuggestion, take: StagedTake) -> StagedTake:
    """Add ``take`` or replace the one with the same (take, track, segment); comments carry over."""
    key = staged_take_key(take)
    for i, existing in enumerate(suggestion.takes):
        if staged_take_key(existing) == key:
            take.comments = take.comments or existing.comments
            suggestion.takes[i] = take
            return take
    suggestion.takes.append(take)
    suggestion.takes.sort(key=staged_take_key)
    return take


def staged_comment_ids(suggestion: SessionSuggestion) -> set[str]:
    return {comment.id for take in suggestion.takes for comment in take.comments}


def stage_comments(suggestion: SessionSuggestion, rows: list[tuple[int, StagedComment]]) -> int:
    """Hold live comments on the first staged segment of their take; returns how many were new.

    A comment whose take has no staged segment yet is left out, so it stays unlanded.
    """
    held = staged_comment_ids(suggestion)
    added = 0
    for take_index, comment in rows:
        if comment.id in held:
            continue
        host = next((t for t in suggestion.takes if t.take_index == take_index), None)
        if host is None:
            continue
        host.comments.append(comment)
        held.add(comment.id)
        added += 1
    return added


def drop_staged_segment(project: EpisodeProject, session_id: str, source_id: str) -> bool:
    """Remove the staged segment registered for ``source_id``; True when one was staged."""
    found = False
    kept: list[SessionSuggestion] = []
    for row in project.editorial.session_suggestions:
        if row.session_id == session_id:
            before = len(row.takes)
            row.takes = [take for take in row.takes if take.source_id != source_id]
            found = found or len(row.takes) != before
            if not row.takes and row.status == "pending":
                continue
        kept.append(row)
    project.editorial.session_suggestions = kept
    return found


def drop_staged_takes(project: EpisodeProject, session_id: str, take_index: int) -> None:
    """Remove a discarded take's staged segments; an emptied suggestion goes with them."""
    kept: list[SessionSuggestion] = []
    for row in project.editorial.session_suggestions:
        if row.session_id == session_id:
            row.takes = [take for take in row.takes if take.take_index != take_index]
            if row.selected_take == take_index:
                row.selected_take = None
            if not row.takes and row.status == "pending":
                continue
        kept.append(row)
    project.editorial.session_suggestions = kept


def skip_session_suggestion(project: EpisodeProject, suggestion_id: str) -> SessionSuggestion:
    row = find_session_suggestion(project, suggestion_id)
    if row.status != "pending":
        raise CodedValueError(
            f"session suggestion {suggestion_id} is {row.status}, not pending",
            code="session_suggestion_not_pending",
        )
    row.status = "skipped"
    return row
