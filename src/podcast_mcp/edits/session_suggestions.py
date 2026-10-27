"""Record sessions staged for an insert or replace target: find, stage, discard and skip."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.audio_check_override import active_override
from podcast_mcp.edits.comment_remap import (
    pending_decisions_in_range,
    remap_review_anchors_for_replace,
    shift_pending_decisions_for_replace,
)
from podcast_mcp.edits.comments import add_comment
from podcast_mcp.edits.cut_speech import (
    UnconfirmedCutSpeech,
    assess_cut_speech,
    replace_confirmation_for,
)
from podcast_mcp.edits.decisions import unplayed_pending_ids
from podcast_mcp.edits.insert_anchor import resolve_insert_anchor, resolve_range
from podcast_mcp.edits.record_placement import place_room_tone, place_take_clip
from podcast_mcp.edits.ripple import RippleRemoval, ripple_insert_clips, ripple_track_ids
from podcast_mcp.edits.session_gap import open_session_gap
from podcast_mcp.edits.timeline_ops import plan_ripple_delete, ripple_delete_range
from podcast_mcp.engines.ranges import SPAN_EPS_S
from podcast_mcp.engines.track_media import refresh_timeline_duration
from podcast_mcp.engines.transcript_sync import rebuild_combined
from podcast_mcp.models import (
    CutSpeech,
    EpisodeProject,
    SessionSuggestion,
    StagedComment,
    StagedRoomTone,
    StagedTake,
    TrackRole,
)
from podcast_mcp.util.coded_error import CodedKeyError, CodedValueError

SUGGESTION_STATUSES = ("pending", "skipped", "accepted")


def session_suggestion_id(session_id: str) -> str:
    """The id of the suggestion a session stages."""
    return f"ss-{session_id}"


def find_session_suggestion(project: EpisodeProject, suggestion_id: str) -> SessionSuggestion:
    for row in project.editorial.session_suggestions:
        if row.id == suggestion_id:
            return row
    raise CodedKeyError(
        f"unknown session suggestion: {suggestion_id}. List the staged sessions to see their ids.",
        code="session_suggestion_not_found",
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


def staged_span_s(offsets_and_durations: Iterable[tuple[float, float]]) -> float:
    """Length a staged insert occupies: the latest end of any segment, relative to its anchor."""
    return max((offset + duration for offset, duration in offsets_and_durations), default=0.0)


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


def session_suggestion_for(project: EpisodeProject, session_id: str) -> SessionSuggestion | None:
    """The suggestion staged for ``session_id``, if any."""
    suggestion_id = session_suggestion_id(session_id)
    return next(
        (row for row in project.editorial.session_suggestions if row.id == suggestion_id), None
    )


def hold_room_tone(suggestion: SessionSuggestion, bed: StagedRoomTone) -> StagedRoomTone:
    """Hold ``bed`` on ``suggestion``, replacing the one held for the same track."""
    for i, existing in enumerate(suggestion.room_tone):
        if existing.track_id == bed.track_id:
            suggestion.room_tone[i] = bed
            return bed
    suggestion.room_tone.append(bed)
    suggestion.room_tone.sort(key=lambda row: row.track_id)
    return bed


def drop_staged_room_tone(
    project: EpisodeProject, session_id: str, track_id: str, path: str
) -> bool:
    """Remove the bed held for ``track_id`` at ``path``; True when one was held."""
    suggestion = session_suggestion_for(project, session_id)
    if suggestion is None:
        return False
    kept = [
        bed for bed in suggestion.room_tone if not (bed.track_id == track_id and bed.path == path)
    ]
    found = len(kept) != len(suggestion.room_tone)
    suggestion.room_tone = kept
    return found


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
            if not row.takes:
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
            if not row.takes:
                continue
        kept.append(row)
    project.editorial.session_suggestions = kept


def _not_pending_message(row: SessionSuggestion) -> str:
    return (
        f"Session {row.session_number} was already {row.status}, so it cannot be changed again. "
        "Undo that step first if you want it back, or record a new session."
    )


def skip_session_suggestion(project: EpisodeProject, suggestion_id: str) -> SessionSuggestion:
    row = find_session_suggestion(project, suggestion_id)
    if row.status != "pending":
        raise CodedValueError(
            _not_pending_message(row),
            code="session_suggestion_not_pending",
        )
    row.status = "skipped"
    return row


def _require_pending(row: SessionSuggestion) -> None:
    if row.status != "pending":
        raise CodedValueError(
            _not_pending_message(row),
            code="session_suggestion_not_pending",
        )


def _require_dialogue_tracks(
    project: EpisodeProject, row: SessionSuggestion, staged: set[str] | None = None
) -> None:
    if staged is None:
        staged = {take.track_id for take in row.takes} | {bed.track_id for bed in row.room_tone}
    for track_id in sorted(staged):
        track = project.track_by_id(track_id)
        if track is not None and track.role != TrackRole.DIALOGUE:
            raise CodedValueError(
                f"track {track_id} is a {track.role.value} track, so Session {row.session_number} "
                "cannot be placed on it. Rename or remove that track, then try again.",
                code="track_not_dialogue",
            )


def _land_staged_comment(
    project: EpisodeProject, comment: StagedComment, at_sec: float
) -> dict[str, Any] | None:
    existing = next((item for item in project.comments if item.id == comment.id), None)
    if existing is not None and existing.author != comment.author:
        return None
    placed = add_comment(
        project,
        body=comment.body,
        author=comment.author,
        timeline_start=at_sec + comment.timeline_offset_s + comment.recording_ms / 1000.0,
        comment_id=comment.id,
    )
    return {"id": placed.id, "timeline_start": placed.timeline_start}


def _place_takes(
    project: EpisodeProject, takes: list[StagedTake], at_sec: float
) -> list[dict[str, Any]]:
    placed: list[dict[str, Any]] = []
    for take in takes:
        source = project.source_by_id(take.source_id)
        if source is None or source.sample_rate is None or source.channels is None:
            raise CodedValueError(
                f"The recording for take {take.take_index} is no longer in the project. "
                "Record the session again.",
                code="staged_source_missing",
            )
        clip = place_take_clip(
            project,
            track_id=take.track_id,
            label=take.track_label,
            source_id=take.source_id,
            rel=source.path,
            timeline_s=at_sec + take.offset_s,
            duration_s=take.duration_s,
            sample_rate=source.sample_rate,
            channels=source.channels,
            previous_rel=None,
            register_source=False,
        )
        placed.append(
            {
                "clip_id": clip.id,
                "track_id": take.track_id,
                "source_id": take.source_id,
                "take_index": take.take_index,
                "segment_index": take.segment_index,
                "timeline_start": clip.timeline_start,
                "duration_s": take.duration_s,
            }
        )
    return placed


def _place_comments(
    project: EpisodeProject, takes: list[StagedTake], at_sec: float
) -> list[dict[str, Any]]:
    return [
        landed
        for take in takes
        for comment in take.comments
        if (landed := _land_staged_comment(project, comment, at_sec)) is not None
    ]


def accept_session_suggestion(
    project: EpisodeProject,
    suggestion_id: str,
    *,
    take_index: int | None = None,
    override_audio_checks: bool = False,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    """Place a staged session on the timeline: an insert opens its span, a replace swaps a range.

    Both find their place again from the suggestion's anchors, so edits since staging move it
    with the audio. Dialogue tracks ripple; other tracks stay where they are and are named in
    ``unmoved_track_ids``. ``take_index`` picks the take of a replace.
    """
    row = find_session_suggestion(project, suggestion_id)
    _require_pending(row)
    if row.kind == "replace":
        return _accept_replace(
            project,
            row,
            take_index=take_index,
            override_audio_checks=override_audio_checks,
            defaults=defaults,
        )
    _require_no_take(row, take_index)
    return _accept_insert(project, row, defaults=defaults)


def _require_no_take(row: SessionSuggestion, take_index: int | None) -> None:
    if take_index is not None:
        raise CodedValueError(
            f"Session {row.session_number} is an insert, whose takes play one after another, so "
            "a take cannot be chosen. Accept it without a take.",
            code="take_not_applicable",
        )


def _insert_plan(project: EpisodeProject, row: SessionSuggestion) -> tuple[float, float]:
    """Where an insert opens and how long it is, or the refusal Accept gives."""
    span = staged_span_s((take.offset_s, take.duration_s) for take in row.takes)
    if span <= 0:
        raise CodedValueError(
            f"Session {row.session_number} has no recorded takes to accept. "
            "Record it again, or skip it.",
            code="session_suggestion_empty",
        )
    _require_dialogue_tracks(project, row)
    if row.anchor is None:
        raise CodedValueError(
            "This session has no recorded insert point. Record it again.", code="stale_anchor"
        )
    at_sec = resolve_insert_anchor(project, row.anchor)
    if at_sec < -SPAN_EPS_S:
        raise CodedValueError(
            "The audio this session was staged at has moved before the start of the episode. "
            "Record the session again at the new spot.",
            code="stale_anchor",
        )
    return max(at_sec, 0.0), span


def _accept_insert(
    project: EpisodeProject, row: SessionSuggestion, *, defaults: EffectiveConfig
) -> dict[str, Any]:
    at_sec, span = _insert_plan(project, row)
    ripple_ids = ripple_track_ids(project)
    open_session_gap(
        project, at_sec, span, ripple_ids, defaults=defaults, except_suggestion_id=row.id
    )
    unmoved = sorted(
        {
            clip.track_id
            for clip in project.clips
            if clip.track_id not in ripple_ids and clip.timeline_end > at_sec
        }
    )
    placed = _place_takes(project, row.takes, at_sec)
    for bed in row.room_tone:
        place_room_tone(
            project,
            track_id=bed.track_id,
            label=bed.track_label,
            rel=bed.path,
            duration_s=bed.duration_s,
            sample_rate=bed.sample_rate,
            channels=bed.channels,
        )
    comments = _place_comments(project, row.takes, at_sec)
    refresh_timeline_duration(project)
    rebuild_combined(project, defaults=defaults)
    row.status = "accepted"
    return {
        "suggestion": row.model_dump(mode="json"),
        "at_sec": at_sec,
        "span_s": span,
        "clips": placed,
        "comments": comments,
        "unmoved_track_ids": unmoved,
    }


def _chosen_take(row: SessionSuggestion, take_index: int | None) -> int:
    available = sorted({take.take_index for take in row.takes})
    if not available:
        raise CodedValueError(
            f"Session {row.session_number} has no recorded takes to accept. "
            "Record it again, or skip it.",
            code="session_suggestion_empty",
        )
    if take_index is not None:
        if take_index not in available:
            raise CodedValueError(
                f"Session {row.session_number} has no take {take_index}. "
                f"Pick one of: {', '.join(str(i) for i in available)}.",
                code="take_not_found",
            )
        return take_index
    if row.selected_take is not None and row.selected_take in available:
        return row.selected_take
    return available[-1]


def _check_take(
    project: EpisodeProject, row: SessionSuggestion, take_index: int | None
) -> tuple[int, list[StagedTake], float, list[str]]:
    """The chosen take, its segments, its length and the tracks it recorded, or Accept's refusal."""
    chosen = _chosen_take(row, take_index)
    takes = [take for take in row.takes if take.take_index == chosen]
    length = staged_span_s((take.offset_s, take.duration_s) for take in takes)
    if length <= 0:
        raise CodedValueError(
            f"Take {chosen} of Session {row.session_number} has no recorded audio. "
            "Pick another take, or record it again.",
            code="session_suggestion_empty",
        )
    recorded = sorted({take.track_id for take in takes})
    missing = [tid for tid in row.track_ids if tid not in recorded]
    if missing:
        raise CodedValueError(
            f"Take {chosen} did not record {', '.join(missing)}, which this pickup was set to "
            "replace. Pick a take that recorded every track, or record the session again.",
            code="track_not_recorded",
        )
    _require_dialogue_tracks(project, row, {*recorded, *row.track_ids})
    for take in takes:
        source = project.source_by_id(take.source_id)
        if source is None or source.sample_rate is None or source.channels is None:
            raise CodedValueError(
                f"The recording for take {take.take_index} is no longer in the project. "
                "Record the session again.",
                code="staged_source_missing",
            )
    return chosen, takes, length, recorded


@dataclass(frozen=True)
class _ReplacePlan:
    """What accepting a replace would do, before anything changes."""

    take_index: int
    takes: list[StagedTake]
    length: float
    from_sec: float
    to_sec: float
    ripple_ids: list[str]
    removal: RippleRemoval
    speech: CutSpeech | None


def _replace_plan(
    project: EpisodeProject,
    row: SessionSuggestion,
    take_index: int | None,
    *,
    defaults: EffectiveConfig,
) -> _ReplacePlan:
    """Choose the take, find the range and plan the removal, or give Accept's refusal."""
    chosen, takes, length, recorded = _check_take(project, row, take_index)
    from_sec, to_sec = resolve_range(project, row)
    ripple_ids = ripple_track_ids(project)
    held = pending_decisions_in_range(project, from_sec, to_sec, set(ripple_ids))
    if held:
        raise CodedValueError(
            f"{len(held)} pending edit{'s sit' if len(held) != 1 else ' sits'} inside the range "
            "this session replaces. Approve or reject them first, then try again.",
            code="pending_edits_in_range",
        )
    removal = plan_ripple_delete(
        project,
        from_sec,
        to_sec,
        edited_track_ids=recorded,
        use_inaudible_opt=False,
        defaults=defaults,
    )
    speech = assess_cut_speech(project, removal, defaults=defaults)
    return _ReplacePlan(chosen, takes, length, from_sec, to_sec, ripple_ids, removal, speech)


def _accept_replace(
    project: EpisodeProject,
    row: SessionSuggestion,
    *,
    take_index: int | None,
    override_audio_checks: bool,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    plan = _replace_plan(project, row, take_index, defaults=defaults)
    if plan.speech is not None and not (override_audio_checks or active_override() is not None):
        raise UnconfirmedCutSpeech(replace_confirmation_for(plan.speech))
    return _apply_replace(project, row, plan, defaults=defaults)


def _apply_replace(
    project: EpisodeProject,
    row: SessionSuggestion,
    plan: _ReplacePlan,
    *,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    chosen, takes, length = plan.take_index, plan.takes, plan.length
    from_sec, to_sec, ripple_ids = plan.from_sec, plan.to_sec, plan.ripple_ids
    removal, speech = plan.removal, plan.speech
    removed = to_sec - from_sec
    delta = length - removed
    unplayed_before = set(unplayed_pending_ids(project))
    clamped = remap_review_anchors_for_replace(project, from_sec, to_sec, length)
    shift_pending_decisions_for_replace(project, to_sec, delta, set(ripple_ids))
    ripple_delete_range(
        project,
        removal,
        record_log=True,
        params={
            "use_inaudible_opt": False,
            "replace": {
                "session_id": row.session_id,
                "suggestion_id": row.id,
                "session_number": row.session_number,
                "take_index": chosen,
                "inserted_s": length,
            },
        },
        cut_speech=speech,
        defaults=defaults,
    )
    ripple_insert_clips(project, from_sec, length, ripple_ids, defaults=defaults)
    unmoved = (
        sorted(
            {
                clip.track_id
                for clip in project.clips
                if clip.track_id not in ripple_ids and clip.timeline_end > from_sec
            }
        )
        if abs(delta) > SPAN_EPS_S
        else []
    )
    placed = _place_takes(project, takes, from_sec)
    comments = _place_comments(project, takes, from_sec)
    refresh_timeline_duration(project)
    rebuild_combined(project, defaults=defaults)
    row.selected_take = chosen
    row.status = "accepted"
    return {
        "suggestion": row.model_dump(mode="json"),
        "at_sec": from_sec,
        "from_sec": from_sec,
        "to_sec": to_sec,
        "removed_s": removed,
        "span_s": length,
        "delta_s": delta,
        "take_index": chosen,
        "clips": placed,
        "comments": comments,
        "comments_not_placed": sum(
            len(take.comments) for take in row.takes if take.take_index != chosen
        ),
        "room_tone_not_placed": len(row.room_tone),
        "clamped_comment_ids": clamped,
        "retired_decision_ids": sorted(set(unplayed_pending_ids(project)) - unplayed_before),
        "unmoved_track_ids": unmoved,
    }


@dataclass(frozen=True)
class SessionPreview:
    """Where a staged session lands and what it takes out, from accepting it on a copy."""

    kind: str
    take_index: int | None
    start_s: float
    removed_s: float
    span_s: float
    speech: CutSpeech | None
    speech_message: str | None


def apply_session_suggestion_for_preview(
    snapshot: EpisodeProject,
    suggestion_id: str,
    *,
    take_index: int | None = None,
    defaults: EffectiveConfig,
) -> SessionPreview:
    """Accept a pending suggestion on ``snapshot`` (a copy) as Accept would, speech hold overridden.

    Gives Accept's own refusals. The caller discards the copy; this only previews.
    """
    row = find_session_suggestion(snapshot, suggestion_id)
    _require_pending(row)
    if row.kind == "replace":
        plan = _replace_plan(snapshot, row, take_index, defaults=defaults)
        _apply_replace(snapshot, row, plan, defaults=defaults)
        confirmation = replace_confirmation_for(plan.speech) if plan.speech else None
        return SessionPreview(
            kind="replace",
            take_index=plan.take_index,
            start_s=plan.from_sec,
            removed_s=plan.to_sec - plan.from_sec,
            span_s=plan.length,
            speech=plan.speech,
            speech_message=confirmation.message if confirmation else None,
        )
    result = accept_session_suggestion(
        snapshot, suggestion_id, take_index=take_index, defaults=defaults
    )
    return SessionPreview(
        kind="insert",
        take_index=None,
        start_s=result["at_sec"],
        removed_s=0.0,
        span_s=result["span_s"],
        speech=None,
        speech_message=None,
    )


def chosen_take_for_preview(
    project: EpisodeProject, row: SessionSuggestion, take_index: int | None
) -> int | None:
    """The take a preview of ``row`` plays (None for an insert), or Accept's refusal.

    Every refusal that depends on the take is given here, ahead of any cache lookup, so a
    take Accept would refuse is refused whether or not its window was rendered before.
    """
    _require_pending(row)
    if row.kind == "replace":
        return _check_take(project, row, take_index)[0]
    _require_no_take(row, take_index)
    return None
