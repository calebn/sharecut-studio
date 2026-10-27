"""Open or close time on the whole timeline for a record session, and move what is keyed to it.

An Accept insert opens a gap at the insert point; a session that starts the episode opens one at
the end of its own audio, so everything already on the timeline moves later. Both go through
:func:`open_session_gap`, so clips, review comments, chapters, pending edits, level automation,
the edit log, alignment records and the anchors of other pending sessions move together.
:func:`close_session_gap` takes a gap back out when a session's last take is discarded or rolled
back.
"""

from __future__ import annotations

from collections.abc import Collection

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.comment_remap import (
    end_after_insert,
    shift_pending_decisions_for_insert,
    shift_review_anchors_for_insert,
    start_after_insert,
)
from podcast_mcp.edits.ripple import ripple_insert_clips, ripple_remove_clips
from podcast_mcp.engines.ranges import SPAN_EPS_S
from podcast_mcp.models import (
    AutomationEnvelope,
    EpisodeProject,
    InsertAnchor,
    SessionSuggestion,
)
from podcast_mcp.util.coded_error import CodedValueError

_EPS = SPAN_EPS_S


def _moved(value: float, at_sec: float, span_s: float) -> float:
    return start_after_insert(value, at_sec, span_s)


def _shift_envelope(env: AutomationEnvelope, at_sec: float, span_s: float) -> AutomationEnvelope:
    points = [
        point.model_copy(update={"time": max(_moved(point.time, at_sec, span_s), 0.0)})
        for point in env.points
    ]
    return env.model_copy(update={"points": points})


def _shift_anchor(anchor: InsertAnchor | None, at_sec: float, span_s: float) -> InsertAnchor | None:
    if anchor is None:
        return None
    return anchor.model_copy(update={"at_sec": max(_moved(anchor.at_sec, at_sec, span_s), 0.0)})


def _shift_suggestion(row: SessionSuggestion, at_sec: float, span_s: float) -> SessionSuggestion:
    def shifted(value: float | None) -> float | None:
        return None if value is None else max(_moved(value, at_sec, span_s), 0.0)

    return row.model_copy(
        update={
            "at_sec": shifted(row.at_sec),
            "from_sec": shifted(row.from_sec),
            "to_sec": shifted(row.to_sec),
            "anchor": _shift_anchor(row.anchor, at_sec, span_s),
            "end_anchor": _shift_anchor(row.end_anchor, at_sec, span_s),
        }
    )


def shift_keyed_state_for_insert(
    project: EpisodeProject,
    at_sec: float,
    span_s: float,
    track_ids: Collection[str],
    *,
    except_suggestion_id: str | None = None,
) -> None:
    """Move the timeline times stored outside clips, comments and decisions (a negative span closes).

    Level automation and alignment records of ``track_ids``, every edit-log record, and the cached
    times of the other pending sessions' anchors. Source-keyed state follows its clips.
    """
    tracks = set(track_ids)
    project.mix.automation_envelopes = [
        _shift_envelope(env, at_sec, span_s) if env.track_id in tracks else env
        for env in project.mix.automation_envelopes
    ]
    editorial = project.editorial
    editorial.edit_log = [
        record.model_copy(
            update={
                "timeline_start": None
                if record.timeline_start is None
                else _moved(record.timeline_start, at_sec, span_s),
                "timeline_end": None
                if record.timeline_end is None or record.timeline_start is None
                else end_after_insert(record.timeline_start, record.timeline_end, at_sec, span_s),
            }
        )
        for record in editorial.edit_log
    ]
    editorial.retained_bleed_alignments = [
        row.model_copy(
            update={
                "timeline_start": max(_moved(row.timeline_start, at_sec, span_s), 0.0),
                "previous_timeline_start": max(
                    _moved(row.previous_timeline_start, at_sec, span_s), 0.0
                ),
            }
        )
        if row.direct_track_id in tracks or row.bleed_track_id in tracks
        else row
        for row in editorial.retained_bleed_alignments
    ]
    editorial.session_suggestions = [
        _shift_suggestion(row, at_sec, span_s)
        if row.status == "pending" and row.id != except_suggestion_id
        else row
        for row in editorial.session_suggestions
    ]


def _move_keyed_state(
    project: EpisodeProject,
    at_sec: float,
    span_s: float,
    track_ids: list[str],
    *,
    keep_comment_ids: Collection[str],
    except_suggestion_id: str | None,
) -> None:
    kept = {c.id: c for c in project.review.comments if c.id in keep_comment_ids}
    shift_review_anchors_for_insert(project, at_sec, span_s)
    shift_pending_decisions_for_insert(project, at_sec, span_s, set(track_ids))
    shift_keyed_state_for_insert(
        project, at_sec, span_s, track_ids, except_suggestion_id=except_suggestion_id
    )
    if kept:
        project.review.comments = [kept.get(c.id, c) for c in project.review.comments]


def _require_no_pending_replace_across(
    project: EpisodeProject, at_sec: float, except_suggestion_id: str | None
) -> None:
    """Refuse to open time inside the range a pending replace session is waiting to replace."""
    for row in project.editorial.session_suggestions:
        if row.kind != "replace" or row.status != "pending" or row.id == except_suggestion_id:
            continue
        start = row.anchor.at_sec if row.anchor is not None else row.from_sec
        stop = row.end_anchor.at_sec if row.end_anchor is not None else row.to_sec
        if start is not None and stop is not None and start + _EPS < at_sec < stop - _EPS:
            raise CodedValueError(
                f"Session {row.session_number} is waiting to replace {start:.1f}s to {stop:.1f}s, "
                "and this would add time inside that range. Accept or skip that session first, "
                "then try again.",
                code="pending_replace_in_the_way",
            )


def open_session_gap(
    project: EpisodeProject,
    at_sec: float,
    span_s: float,
    track_ids: list[str],
    *,
    defaults: EffectiveConfig,
    keep_comment_ids: Collection[str] = (),
    except_suggestion_id: str | None = None,
) -> None:
    """Open ``span_s`` of time at ``at_sec`` on ``track_ids`` and move everything keyed to it.

    ``keep_comment_ids`` stay where they are (a session's own comments, which sit before the gap).
    A pending replace session whose range contains ``at_sec`` is refused
    (``pending_replace_in_the_way``): opening time inside it would widen it over the new audio.
    """
    _require_no_pending_replace_across(project, at_sec, except_suggestion_id)
    ripple_insert_clips(project, at_sec, span_s, track_ids, defaults=defaults)
    _move_keyed_state(
        project,
        at_sec,
        span_s,
        track_ids,
        keep_comment_ids=keep_comment_ids,
        except_suggestion_id=except_suggestion_id,
    )


def close_session_gap(
    project: EpisodeProject,
    start_sec: float,
    end_sec: float,
    track_ids: list[str],
    *,
    defaults: EffectiveConfig,
    keep_comment_ids: Collection[str] = (),
) -> bool:
    """Take the empty ``[start_sec, end_sec)`` back out; False (nothing changes) when audio sits in it."""
    span = end_sec - start_sec
    if span <= _EPS:
        return False
    if any(
        clip.timeline_start < end_sec - _EPS and clip.timeline_end > start_sec + _EPS
        for clip in project.clips
    ):
        return False
    ripple_remove_clips(project, [(start_sec, end_sec)], track_ids, defaults=defaults)
    _move_keyed_state(
        project,
        end_sec,
        -span,
        track_ids,
        keep_comment_ids=keep_comment_ids,
        except_suggestion_id=None,
    )
    return True
