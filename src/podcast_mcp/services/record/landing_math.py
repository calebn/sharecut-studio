"""Pure clock math for record-session timeline landing."""

from __future__ import annotations

import re
from collections.abc import Iterable

from podcast_mcp.engines.timeline_render import timeline_duration_sec
from podcast_mcp.models import Clip, EpisodeProject
from podcast_mcp.services.record.state import (
    SessionTarget,
    TakeState,
    take_recording_duration_ms,
    unsupported_target_message,
)
from podcast_mcp.services.record.upload import KEEPER_SAMPLE_RATE
from podcast_mcp.util.coded_error import CodedValueError

TAKE_GAP_MS = 2000
_RECORD_SOURCE = re.compile(r"^rec-([0-9a-f]{12})-\d+-")
ALIGN_DRIFT_MS = 50
DRIFT_WINDOW_S = 60.0


def record_source_prefix(session_id: str) -> str:
    return f"rec-{session_id}-"


def session_origin_s(
    clips: Iterable[Clip],
    session_id: str,
    *,
    take_gap_ms: int = TAKE_GAP_MS,
) -> float:
    """Where a session's first take starts: after everything the session did not land."""
    prefix = record_source_prefix(session_id)
    ends = [clip.timeline_end for clip in clips if not (clip.source_id or "").startswith(prefix)]
    return max(ends) + take_gap_ms / 1000.0 if ends else 0.0


def check_target_for_project(target: SessionTarget, project: EpisodeProject) -> None:
    """Refuse an insert or replace target the episode cannot hold, naming the field to fix.

    An insert past the end is allowed: it lands at the end. A replace needs real tracks and
    a range inside the timeline.
    """
    if target.kind != "replace":
        return
    known = {track.id for track in project.timeline.tracks}
    missing = [track_id for track_id in target.track_ids if track_id not in known]
    if missing:
        names = ", ".join(sorted(known)) or "none yet"
        raise CodedValueError(
            f"track_ids: this episode has no track named {', '.join(missing)}. "
            f"Pick from the tracks it has: {names}.",
            code="invalid_record_request",
        )
    end = timeline_duration_sec(project)
    if target.to_sec > end + 1e-6:
        raise CodedValueError(
            f"to_sec: the replace range ends at {target.to_sec:g}s but the timeline is only "
            f"{end:g}s long. Pick a range inside the timeline.",
            code="invalid_record_request",
        )


def session_placement(clips: Iterable[Clip], session_id: str, target: SessionTarget) -> float:
    """Where a session's first take starts for ``target``; the one place landing and the live clock agree."""
    refusal = unsupported_target_message(target)
    if refusal is not None:
        raise CodedValueError(refusal, code="invalid_record_request")
    if target.kind == "insert":
        return target.at_sec
    if target.kind == "replace":
        return target.from_sec
    return session_origin_s(clips, session_id)


def session_take_offsets_s(
    takes: list[TakeState],
    clips: Iterable[Clip],
    session_id: str,
    target: SessionTarget,
    *,
    tombstoned: set[int] | frozenset[int] | None = None,
) -> dict[int, float]:
    """Each live take's origin on the timeline for ``target``; landing and the live clock share it.

    End takes follow each other with the take gap. Insert takes concatenate with no gap. Replace
    takes are alternatives, so each starts at the range start.
    """
    return take_offsets_s(
        takes,
        tombstoned=tombstoned,
        take_gap_ms=0 if target.kind == "insert" else TAKE_GAP_MS,
        origin_s=session_placement(clips, session_id, target),
        alternatives=target.kind == "replace",
    )


def session_numbered(project: EpisodeProject, session_id: str) -> bool:
    return any(row.session_id == session_id for row in project.editorial.record_sessions)


def session_landed_before(project: EpisodeProject, session_id: str) -> bool:
    """True when the session has a stored number or clips landed before numbering existed."""
    return session_numbered(project, session_id) or any(
        (found := _RECORD_SOURCE.match(clip.source_id or "")) and found.group(1) == session_id
        for clip in project.clips
    )


def record_session_number(project: EpisodeProject, session_id: str) -> int:
    """The session's number: its stored one, else one past every other session on the timeline.

    Sessions landed before numbering existed count by the ``rec-<session_id>-`` prefix of their clips.
    """
    stored = project.editorial.record_sessions
    for row in stored:
        if row.session_id == session_id:
            return row.number
    others = {row.session_id for row in stored}
    for clip in project.clips:
        found = _RECORD_SOURCE.match(clip.source_id or "")
        if found:
            others.add(found.group(1))
    others.discard(session_id)
    return max(len(others), *(row.number for row in stored), 0) + 1


def pad_samples(join_offset_ms: int, sample_rate: int = KEEPER_SAMPLE_RATE) -> int:
    """Leading zeros when encoding segment 0 as clip@0 (optional; not default)."""
    return round(join_offset_ms * sample_rate / 1000)


def origin_pad_samples(
    *,
    segment_index: int,
    join_offset_ms: int,
    sample_rate: int = KEEPER_SAMPLE_RATE,
) -> int:
    """In-file pad is only legal for segment 0. Later segments stay unpadded."""
    if segment_index != 0:
        return 0
    return pad_samples(join_offset_ms, sample_rate)


def duration_s(samples_written: int, sample_rate: int = KEEPER_SAMPLE_RATE) -> float:
    if samples_written <= 0 or sample_rate <= 0:
        return 0.0
    return samples_written / sample_rate


def expected_span_s(
    join_offset_ms: int,
    *,
    take_duration_ms: int,
    next_join_offset_ms: int | None = None,
) -> float:
    """Recording-clock length this segment should occupy."""
    start = max(0, join_offset_ms)
    end = take_duration_ms
    if next_join_offset_ms is not None:
        end = min(end, next_join_offset_ms)
    if end <= start:
        return 0.0
    return (end - start) / 1000.0


def duration_error_ms(actual_s: float, expected_s: float) -> float | None:
    """File duration minus recording-clock span, in milliseconds."""
    if expected_s <= 0:
        return None
    return (actual_s - expected_s) * 1000.0


def clip_timeline_s(take_offset_s: float, join_offset_ms: int) -> float:
    return take_offset_s + join_offset_ms / 1000.0


def take_offsets_s(
    takes: list[TakeState],
    *,
    tombstoned: set[int] | frozenset[int] | None = None,
    take_gap_ms: int = TAKE_GAP_MS,
    origin_s: float = 0.0,
    alternatives: bool = False,
) -> dict[int, float]:
    """Sequential take origins from ``origin_s``; with ``alternatives`` every take starts there.

    Tombstoned takes do not consume timeline.
    """
    skipped = tombstoned or set()
    offsets: dict[int, float] = {}
    acc_ms = round(origin_s * 1000)
    alive = [
        take
        for take in sorted(takes, key=lambda row: row.take_index)
        if take.take_index not in skipped
    ]
    if alternatives:
        return {take.take_index: acc_ms / 1000.0 for take in alive}
    for i, take in enumerate(alive):
        offsets[take.take_index] = acc_ms / 1000.0
        acc_ms += take_recording_duration_ms(take)
        if i < len(alive) - 1:
            acc_ms += take_gap_ms
    return offsets


def session_start_present(take: TakeState) -> bool:
    return bool(str(take.session_start_iso or "").strip())


def needs_align_fallback(
    takes: list[TakeState],
    *,
    tombstoned: set[int] | frozenset[int] | None = None,
    drift_ms: float | None = None,
) -> bool:
    """Hint that pipeline ``align_tracks`` should run after transcripts exist.

    Land does not invoke conversation align (no ASR yet). ``drift_ms`` is a
    sample-count vs recording-clock error, not GCC-PHAT of dry keepers.
    """
    skipped = tombstoned or set()
    relevant = [take for take in takes if take.take_index not in skipped]
    if any(not session_start_present(take) for take in relevant):
        return True
    return drift_ms is not None and abs(drift_ms) > ALIGN_DRIFT_MS


def overlap_window_s(
    join_a_ms: int,
    duration_a_s: float,
    join_b_ms: int,
    duration_b_s: float,
    *,
    window_s: float = DRIFT_WINDOW_S,
) -> tuple[float, float] | None:
    """Return ``(start_s, duration_s)`` on the recording clock for a bounded overlap."""
    start = max(join_a_ms, join_b_ms) / 1000.0
    end = min(join_a_ms / 1000.0 + duration_a_s, join_b_ms / 1000.0 + duration_b_s)
    span = end - start
    if span < 0.05 or window_s <= 0:
        return None
    return start, min(span, window_s)
