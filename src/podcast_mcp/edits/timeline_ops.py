from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import ValidationError

from podcast_mcp.edits.clipping_regions import clip_clipping_payload, clip_clipping_truncated
from podcast_mcp.edits.clips_ops import (
    JOIN_GAP_TOLERANCE_SEC,
    clips_for_track,
    extract_clips_in_timeline_range,
    join_render_fields,
    new_clip_id,
    place_clips_at,
    punch_timeline_range_from_clips,
    recording_key,
    remove_timeline_range_from_clips,
    set_track_clips,
    source_duration_sec,
    split_clip_at,
    update_timeline_duration,
)
from podcast_mcp.edits.clips_ops import (
    move_clips as move_clips_bounds,
)
from podcast_mcp.edits.clips_ops import (
    roll_clip_join as roll_clip_join_bounds,
)
from podcast_mcp.edits.comment_remap import remap_review_anchors_for_cuts
from podcast_mcp.edits.cut_speech import SpeechClearance
from podcast_mcp.edits.edit_log import archive_timeline_op, seam_source_by_track
from podcast_mcp.edits.inaudible_cuts import (
    optimize_timeline_cut_range,
    recommend_micro_fades,
)
from podcast_mcp.edits.mute_regions import mute_regions_overlapping, mute_regions_payload
from podcast_mcp.edits.ripple import (
    RippleRemoval,
    TrackExtent,
    TrimPlan,
    apply_trim_geometry,
    ripple_insert_clips,
    ripple_remove_clips,
    ripple_track_ids,
)
from podcast_mcp.edits.room_tone import (
    OwnQuietSample,
    RecordedBedSample,
    SampleAbsent,
    room_tone_span,
)
from podcast_mcp.edits.session_air import GeometricPause, MeasuredPause
from podcast_mcp.edits.transcript_cuts import TranscriptMatch, search_transcript
from podcast_mcp.edits.transcript_sync import (
    apply_batch_transcript_removes,
    rebuild_combined,
    restore_archived_words,
    timeline_removes_by_transcript,
)
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_source_to_timeline_shift,
    origin_track_id_for_clip,
)
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    ClipMuteRegion,
    EditMode,
    EpisodeProject,
    RoomToneFill,
)
from podcast_mcp.util.change_summary import change_summary
from podcast_mcp.util.coded_error import CodedError, CodedKeyError, CodedValueError
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.timebase import SourceSec
from podcast_mcp.util.tracks import dialogue_track_ids, recording_audio_path, unknown_track


def _optimized_ripple_span(
    project: EpisodeProject,
    timeline_start: float,
    timeline_end: float,
    use_inaudible_opt: bool | None,
) -> tuple[float, float]:
    """The median of each dialogue track's inaudible-optimized bounds for one cut."""
    starts: list[float] = []
    ends: list[float] = []
    for tid in dialogue_track_ids(project):
        opt = optimize_timeline_cut_range(
            project,
            tid,
            timeline_start,
            timeline_end,
            force_enabled=use_inaudible_opt,
        )
        starts.append(opt.start)
        ends.append(opt.end)
    if not starts:
        return timeline_start, timeline_end
    starts.sort()
    ends.sort()
    start, end = starts[len(starts) // 2], ends[len(ends) // 2]
    if end <= start:
        start, end = starts[0], ends[-1]
    return start, end


def plan_ripple_delete(
    project: EpisodeProject,
    timeline_start: float,
    timeline_end: float,
    *,
    edited_track_ids: list[str] | tuple[str, ...] = (),
    use_inaudible_opt: bool | None = None,
) -> RippleRemoval:
    """The span :func:`ripple_delete` removes after inaudible optimization.

    ``edited_track_ids`` name whose speech the cut means to remove; the speech guard
    protects every other track's speech in the span.
    """
    if timeline_end <= timeline_start:
        raise ValueError("timeline_end must be after timeline_start")
    start, end = _optimized_ripple_span(project, timeline_start, timeline_end, use_inaudible_opt)
    return RippleRemoval.of(
        [TrackExtent(tid, start, end) for tid in dict.fromkeys(edited_track_ids)],
        unselected=[(start, end)],
    )


def ripple_delete(
    project: EpisodeProject,
    clearance: SpeechClearance,
    *,
    record_log: bool = True,
    params: dict | None = None,
) -> dict:
    """Ripple-remove ``clearance.removal`` on every :func:`ripple_track_ids` track.

    Spans apply latest first, each with its transcript archive, comment remap and
    (with ``record_log``) one applied-edit record. The returned change summary echoes
    the first span's ``timeline_start``/``timeline_end`` and ``per_track_source``
    (``{track_id: [pre, post]}`` seam clocks from :func:`seam_source_by_track`), even
    with ``record_log=False``: approve/prefix removals archive them from this report.
    Add the key to any schema or typed output built over it.
    """
    removal = clearance.removal
    if removal is None:
        raise ValueError("ripple_delete needs a removal")
    tracks = ripple_track_ids(project, removal.edited_track_ids)
    seams: list[dict[str, list[float]]] = []
    for start, end in reversed(removal.spans):
        bounds = [(start, end)]
        clips_before = ripple_remove_clips(project, bounds, tracks)
        apply_batch_transcript_removes(project, bounds, clips_before)
        remap_review_anchors_for_cuts(project, bounds)
        per_track_source = seam_source_by_track(clips_before, start, end)
        seams.append(per_track_source)
        if record_log:
            archive_timeline_op(
                project,
                operation="ripple_delete",
                track_ids=tracks,
                timeline_start=start,
                timeline_end=end,
                params={
                    **(params or {}),
                    "per_track_source": per_track_source,
                    **clearance.log_params(),
                },
            )
    update_timeline_duration(project)
    first_start, first_end = removal.spans[0]
    return change_summary(
        project,
        operation="ripple_delete",
        affected_tracks=tracks,
        timeline_start=first_start,
        timeline_end=first_end,
        span_count=len(removal.spans),
        per_track_source=seams[-1],
        **(params or {}),
        **clearance.log_params(),
    )


def punch_delete(
    project: EpisodeProject,
    track_id: str,
    timeline_start: float,
    timeline_end: float,
    *,
    use_inaudible_opt: bool | None = None,
    record_log: bool = True,
) -> dict:
    """Remove audio on one track only; leave a silence hole (no peer ripple).

    Like :func:`ripple_delete`, the returned summary echoes the optimized
    ``timeline_start``/``timeline_end`` and ``per_track_source`` (seam clocks)
    even with ``record_log=False``.
    """
    if timeline_end <= timeline_start:
        raise ValueError("timeline_end must be after timeline_start")
    opt = optimize_timeline_cut_range(
        project,
        track_id,
        timeline_start,
        timeline_end,
        force_enabled=use_inaudible_opt,
    )
    timeline_start, timeline_end = opt.start, opt.end
    if timeline_end <= timeline_start:
        raise ValueError("timeline_end must be after timeline_start")

    clips_before = clips_for_track(project, track_id)
    updated = punch_timeline_range_from_clips(clips_before, timeline_start, timeline_end)
    set_track_clips(project, track_id, updated)
    from podcast_mcp.edits.transcript_sync import apply_source_transcript_removes

    removes_by_transcript = timeline_removes_by_transcript(
        project, clips_before, [(timeline_start, timeline_end)]
    )
    if removes_by_transcript:
        apply_source_transcript_removes(project, removes_by_transcript)
    else:
        rebuild_combined(project)
    update_timeline_duration(project)
    per_track_source = seam_source_by_track({track_id: clips_before}, timeline_start, timeline_end)
    if record_log:
        archive_timeline_op(
            project,
            operation="punch_delete",
            track_ids=[track_id],
            timeline_start=timeline_start,
            timeline_end=timeline_end,
            params={
                "use_inaudible_opt": use_inaudible_opt,
                "scope": "track",
                "per_track_source": per_track_source,
            },
        )
    return change_summary(
        project,
        operation="punch_delete",
        affected_tracks=[track_id],
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        use_inaudible_opt=use_inaudible_opt,
        per_track_source=per_track_source,
    )


def plan_ripple_delete_text(
    project: EpisodeProject,
    query: str,
    *,
    use_inaudible_opt: bool | None = None,
) -> RippleRemoval:
    """The ripple removal for the first transcript match of ``query``, its speaker edited."""
    matches = search_transcript(project, query)
    if not matches:
        raise CodedValueError(f"no transcript match for {query!r}", code="no_transcript_match")
    m = matches[0]
    if m.timeline_start is None or m.timeline_end is None:
        raise ValueError(f"transcript match for {query!r} falls in removed timeline material")
    return plan_ripple_delete(
        project,
        m.timeline_start,
        m.timeline_end,
        edited_track_ids=[m.track_id],
        use_inaudible_opt=use_inaudible_opt,
    )


def insert_gap(
    project: EpisodeProject,
    at_time: float,
    duration_sec: float,
) -> dict:
    tracks = ripple_track_ids(project)
    ripple_insert_clips(project, at_time, duration_sec, tracks)
    # Words stay in source coordinates; only clip placement moves.
    rebuild_combined(project)
    return change_summary(
        project,
        operation="insert_gap",
        affected_tracks=tracks,
        at_time=at_time,
        duration_sec=duration_sec,
    )


def move_segment(
    project: EpisodeProject,
    source_start: float,
    source_end: float,
    insert_at: float,
) -> dict:
    if source_end <= source_start:
        raise ValueError("source_end must be after source_start")
    duration = source_end - source_start
    insert_point = insert_at
    if insert_at > source_end:
        insert_point = insert_at - duration
    elif insert_at > source_start:
        insert_point = source_start
    tracks = ripple_track_ids(project)
    extracted_by_track: dict[str, list[Clip]] = {}
    for tid in tracks:
        extracted_by_track[tid] = extract_clips_in_timeline_range(
            clips_for_track(project, tid),
            source_start,
            source_end,
        )
    # Clip-only ripple: keep transcript words (source clocks). Moving remaps
    # them via the new clip placements; deleting words would orphan the audio.
    ripple_remove_clips(project, [(source_start, source_end)], tracks)
    remap_review_anchors_for_cuts(project, [(source_start, source_end)])
    insert_gap(project, insert_point, duration)
    for tid in tracks:
        clips = clips_for_track(project, tid)
        merged = place_clips_at(clips, extracted_by_track[tid], insert_point)
        set_track_clips(project, tid, merged)
    update_timeline_duration(project)
    rebuild_combined(project)
    return change_summary(
        project,
        operation="move_segment",
        affected_tracks=tracks,
        source_start=source_start,
        source_end=source_end,
        insert_at=insert_at,
    )


def _tightest_timeline_match(matches: list, *, label: str, query: str):
    """Prefer the shortest mapped span (word-level over containing utterances)."""
    candidates = [m for m in matches if m.timeline_start is not None and m.timeline_end is not None]
    if not candidates:
        raise ValueError(f"{label} match for {query!r} falls in removed timeline material")
    return min(
        candidates,
        key=lambda m: (float(m.timeline_end) - float(m.timeline_start), float(m.timeline_start)),
    )


def _exact_phrase_match(project: EpisodeProject, query: str) -> TranscriptMatch | None:
    """Contiguous word-sequence match (avoids substring hits inside longer lines)."""
    from podcast_mcp.edits.transcript_cuts import (
        _timeline_span_for_source,
    )
    from podcast_mcp.util.text import normalize_text

    q_words = normalize_text(query).split()
    if not q_words:
        return None
    best: TranscriptMatch | None = None
    best_len = float("inf")
    for transcript in project.transcripts:
        words = [w for w in transcript.words if not w.suppressed]
        if len(words) < len(q_words):
            continue
        norms = [normalize_text(w.text) for w in words]
        tr = project.track_by_id(transcript.track_id)
        sp = tr.speaker if tr else transcript.track_id
        for i in range(len(norms) - len(q_words) + 1):
            if norms[i : i + len(q_words)] != q_words:
                continue
            src_start = float(words[i].start)
            src_end = float(words[i + len(q_words) - 1].end)
            tl_start, tl_end = _timeline_span_for_source(
                project, transcript.track_id, src_start, src_end
            )
            if tl_start is None or tl_end is None:
                continue
            span = float(tl_end) - float(tl_start)
            if span >= best_len - 1e-9:
                continue
            best_len = span
            best = TranscriptMatch(
                track_id=transcript.track_id,
                start=src_start,
                end=src_end,
                text=" ".join(w.text for w in words[i : i + len(q_words)]),
                speaker=sp,
                word_start_index=i,
                word_end_index=i + len(q_words) - 1,
                timeline_start=float(tl_start),
                timeline_end=float(tl_end),
            )
    return best


def _resolve_move_match(project: EpisodeProject, query: str, *, label: str):
    exact = _exact_phrase_match(project, query)
    if exact is not None:
        return exact
    matches = search_transcript(project, query)
    if not matches:
        raise CodedValueError(f"no {label} match for {query!r}", code="no_transcript_match")
    return _tightest_timeline_match(matches, label=label, query=query)


def move_by_text(
    project: EpisodeProject,
    source_query: str,
    destination_query: str,
    position: str = "after",
) -> dict:
    src = _resolve_move_match(project, source_query, label="source")
    dst = _resolve_move_match(project, destination_query, label="destination")
    insert_at = float(dst.timeline_end) if position == "after" else float(dst.timeline_start)
    src_start = float(src.timeline_start)
    src_end = float(src.timeline_end)
    # Destination inside the moved span is a no-op after insert-point collapse;
    # fail loudly so agents pick a destination outside the source.
    if src_start < insert_at < src_end:
        raise ValueError(
            "destination lies inside the source span; choose a destination outside "
            "the text being moved"
        )
    return move_segment(project, src_start, src_end, insert_at)


def split_clip(
    project: EpisodeProject,
    track_id: str,
    at_time: float,
) -> dict:
    clips = clips_for_track(project, track_id)
    new_clips: list[Clip] = []
    split = False
    for clip in clips:
        tl_end = clip.timeline_end
        if not split and clip.timeline_start < at_time < tl_end:
            before, after = split_clip_at(clip, at_time)
            new_clips.extend([before, after])
            split = True
        else:
            new_clips.append(clip)
    if not split:
        raise CodedValueError(
            f"no clip at timeline {at_time} on track {track_id}", code="no_clip_at_time"
        )
    fades = recommend_micro_fades()
    if len(new_clips) >= 2:
        ordered = sorted(new_clips, key=lambda c: c.timeline_start)
        for i in range(len(ordered) - 1):
            if abs(ordered[i].timeline_end - ordered[i + 1].timeline_start) <= 1e-6:
                ordered[i].fade_out_ms = max(ordered[i].fade_out_ms, fades["fade_out_ms"])
                ordered[i + 1].fade_in_ms = max(ordered[i + 1].fade_in_ms, fades["fade_in_ms"])
                ordered[i + 1].join_in_mode = ClipJoinMode.FADE
        new_clips = ordered
    set_track_clips(project, track_id, new_clips)
    update_timeline_duration(project)
    return change_summary(project, operation="split_clip", affected_tracks=[track_id])


def split_clips_at(
    project: EpisodeProject,
    at_time: float,
    track_ids: list[str] | None = None,
    *,
    record_log: bool = True,
) -> dict:
    """Split clips on one or more tracks at a shared timeline timecode.

    Tracks with no clip at *at_time* are skipped. Raises if none split.
    When *track_ids* is None/empty, uses all dialogue tracks.
    """
    tracks = list(track_ids) if track_ids else dialogue_track_ids(project)
    if not tracks:
        raise ValueError("no tracks to split")
    affected: list[str] = []
    skipped: list[str] = []
    for tid in tracks:
        try:
            split_clip(project, tid, at_time)
            affected.append(tid)
        except ValueError:
            skipped.append(tid)
    if not affected:
        raise CodedValueError(
            f"no clip at timeline {at_time} on tracks {tracks}", code="no_clip_at_time"
        )
    split_source_by_track: dict[str, float] = {}
    for tid in affected:
        left = next(
            (c for c in clips_for_track(project, tid) if abs(c.timeline_end - at_time) <= 1e-6),
            None,
        )
        if left is not None:
            split_source_by_track[tid] = float(left.source_end)
    if record_log:
        archive_timeline_op(
            project,
            operation="split_clips_at",
            track_ids=affected,
            timeline_start=at_time,
            timeline_end=at_time,
            params={
                "at_time": at_time,
                "track_ids": affected,
                "skipped_track_ids": skipped,
                "split_source_by_track": split_source_by_track,
            },
        )
    return change_summary(
        project,
        operation="split_clips_at",
        affected_tracks=affected,
        at_time=at_time,
        skipped_track_ids=skipped,
        split_source_by_track=split_source_by_track,
    )


def _clips_by_id(project: EpisodeProject, clip_ids: list[str]) -> list[Clip]:
    if not clip_ids:
        raise ValueError("clip_ids required")
    by_id = {c.id: c for c in project.clips}
    missing = [cid for cid in clip_ids if cid not in by_id]
    if missing:
        raise CodedKeyError(f"unknown clip_id(s): {missing}", code="clip_not_found")
    return [by_id[cid] for cid in clip_ids]


def plan_delete_clips(project: EpisodeProject, clip_ids: list[str]) -> RippleRemoval:
    """What a ripple delete of ``clip_ids`` removes; each clip selects only its own extent."""
    return RippleRemoval.of(
        TrackExtent(c.track_id, c.timeline_start, c.timeline_end)
        for c in _clips_by_id(project, clip_ids)
    )


def ripple_delete_clips(
    project: EpisodeProject,
    clip_ids: list[str],
    clearance: SpeechClearance,
    *,
    record_log: bool = True,
) -> dict:
    """Ripple-delete the selected clips' spans on every :func:`ripple_track_ids` track."""
    track_ids = sorted({c.track_id for c in _clips_by_id(project, clip_ids)})
    removal = plan_delete_clips(project, clip_ids)
    clearance.require(removal)
    report = ripple_delete(project, clearance, record_log=False)
    if record_log:
        archive_timeline_op(
            project,
            operation="ripple_delete_clips",
            track_ids=track_ids,
            params={
                "clip_ids": list(clip_ids),
                "mode": EditMode.RIPPLE.value,
                "cut_spans": {
                    tid: [list(r) for r in removal.spans] for tid in report["affected_tracks"]
                },
                **clearance.log_params(),
            },
        )
    return change_summary(
        project,
        operation="ripple_delete_clips",
        affected_tracks=report["affected_tracks"],
        clip_ids=list(clip_ids),
        mode=EditMode.RIPPLE.value,
        **clearance.log_params(),
    )


def punch_delete_clips(
    project: EpisodeProject,
    clip_ids: list[str],
    *,
    record_log: bool = True,
) -> dict:
    """Delete the selected clips and leave silence in their place; nothing else moves."""
    clips = _clips_by_id(project, clip_ids)
    track_ids = sorted({c.track_id for c in clips})
    # Snapshot ranges before mutating (clip ids change under punch).
    jobs = [(c.track_id, c.timeline_start, c.timeline_end) for c in clips]
    punched: dict[str, list[list[float]]] = {}
    for track_id, start, end in sorted(jobs, key=lambda j: j[1], reverse=True):
        punch_delete(
            project,
            track_id,
            start,
            end,
            use_inaudible_opt=False,
            record_log=False,
        )
        punched.setdefault(track_id, []).append([start, end])
    if record_log:
        archive_timeline_op(
            project,
            operation="delete_clips",
            track_ids=track_ids,
            params={"clip_ids": list(clip_ids), "mode": EditMode.GAP.value, "cut_spans": punched},
        )
    return change_summary(
        project,
        operation="delete_clips",
        affected_tracks=track_ids,
        clip_ids=list(clip_ids),
        mode=EditMode.GAP.value,
    )


def punch_delete_range(
    project: EpisodeProject,
    timeline_start: float,
    timeline_end: float,
    track_ids: list[str],
) -> dict:
    """Leave silence over ``[timeline_start, timeline_end)`` on ``track_ids``; nothing moves."""
    if timeline_end <= timeline_start:
        raise ValueError("timeline_end must be after timeline_start")
    if not track_ids:
        raise ValueError("track_ids required")
    for tid in track_ids:
        punch_delete(project, tid, timeline_start, timeline_end, use_inaudible_opt=False)
    return change_summary(
        project,
        operation="punch_delete",
        affected_tracks=list(track_ids),
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        mode=EditMode.GAP.value,
    )


def duplicate_segment(
    project: EpisodeProject,
    source_start: float,
    source_end: float,
    insert_at: float,
) -> dict:
    duration = source_end - source_start
    tracks = ripple_track_ids(project)
    extracted_by_track: dict[str, list[Clip]] = {}
    for tid in tracks:
        extracted_by_track[tid] = extract_clips_in_timeline_range(
            clips_for_track(project, tid),
            source_start,
            source_end,
        )
    insert_gap(project, insert_at, duration)
    for tid in tracks:
        clips = clips_for_track(project, tid)
        merged = place_clips_at(clips, extracted_by_track[tid], insert_at)
        set_track_clips(project, tid, merged)
    update_timeline_duration(project)
    rebuild_combined(project)
    return change_summary(project, operation="duplicate_segment", affected_tracks=tracks)


def copy_segment(
    project: EpisodeProject,
    start: float,
    end: float,
    track_ids: list[str] | None = None,
) -> dict:
    """The clipboard Studio Copy / Cut holds for ``[start, end)``: ``duration`` + ``extracts``.

    Mirrors ``extractClipsInRange`` (``gui/web/src/edit/selectionClipboard.ts``): every
    track with clips in range, or only ``track_ids``. ``paste_segment`` takes it back.
    """
    if end <= start:
        raise ValueError("end must be after start")
    tracks = track_ids or list(dict.fromkeys(c.track_id for c in project.clips))
    extracts = [
        {
            "track_id": clip.track_id,
            "source_start": clip.source_start,
            "source_end": clip.source_end,
            "relative_timeline_start": clip.timeline_start,
            "source_id": clip.source_id,
            "fade_in_ms": clip.fade_in_ms,
            "fade_out_ms": clip.fade_out_ms,
            "join_in_mode": clip.join_in_mode.value,
            "mute_regions": mute_regions_payload(clip.mute_regions),
        }
        for tid in tracks
        for clip in extract_clips_in_timeline_range(clips_for_track(project, tid), start, end)
    ]
    return {"duration": end - start, "extracts": extracts}


class PasteRejectedError(CodedError, ValueError):
    """A clipboard the project cannot take; ``code`` names why (also the message prefix)."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}", code=code)


_PASTE_EDGE_TOLERANCE_SEC = 1e-3


def _paste_number(raw: dict, key: str, index: int) -> float:
    try:
        value = float(raw[key])
    except (KeyError, TypeError, ValueError):
        raise PasteRejectedError(
            "paste_bad_extract", f"extract {index} requires a numeric {key}"
        ) from None
    if not math.isfinite(value):
        raise PasteRejectedError("paste_bad_extract", f"extract {index} {key} must be finite")
    return value


def _paste_source_limit(
    project: EpisodeProject, track_id: str, source_id: str | None
) -> float | None:
    if source_id is not None:
        source = project.source_by_id(source_id)
        return source.duration_sec if source else None
    track = project.track_by_id(track_id)
    return track.media.duration_sec if track and track.media else None


def _clips_from_paste(project: EpisodeProject, extracts: list[dict]) -> dict[str, list[Clip]]:
    """Validate a clipboard against *project* and build its clips, per dialogue track.

    The ``PasteSegment`` boundary: raises ``PasteRejectedError`` for an unknown track
    or source or an impossible range, so ``paste_segment`` never mutates on a bad clipboard.
    """
    tracks = dialogue_track_ids(project)
    by_track: dict[str, list[Clip]] = {tid: [] for tid in tracks}
    for index, raw in enumerate(extracts):
        tid = str(raw.get("track_id"))
        if tid not in by_track:
            raise PasteRejectedError(
                "paste_unknown_track", f"extract {index} names unknown track {tid!r}"
            )
        source_id = raw.get("source_id")
        if source_id is not None and project.source_by_id(str(source_id)) is None:
            raise PasteRejectedError(
                "paste_unknown_source", f"extract {index} names unknown source {source_id!r}"
            )
        src_start = _paste_number(raw, "source_start", index)
        src_end = _paste_number(raw, "source_end", index)
        relative_start = (
            _paste_number(raw, "relative_timeline_start", index)
            if "relative_timeline_start" in raw
            else 0.0
        )
        limit = _paste_source_limit(project, tid, None if source_id is None else str(source_id))
        if (
            src_start < 0
            or src_end <= src_start
            or relative_start < 0
            or (limit is not None and src_end > limit + _PASTE_EDGE_TOLERANCE_SEC)
        ):
            raise PasteRejectedError(
                "paste_bad_range",
                f"extract {index} source range [{src_start}, {src_end}) with timeline offset "
                f"{relative_start} does not fit track {tid!r}"
                + (f" (source length {limit})" if limit is not None else ""),
            )
        try:
            join_mode = ClipJoinMode(str(raw.get("join_in_mode", ClipJoinMode.FADE.value)))
        except ValueError:
            join_mode = ClipJoinMode.FADE
        parsed_mutes: list[ClipMuteRegion] = []
        mute_raw = raw.get("mute_regions") or []
        if isinstance(mute_raw, list):
            for item in mute_raw:
                try:
                    parsed_mutes.append(ClipMuteRegion.model_validate(item))
                except ValidationError:
                    continue
        by_track[tid].append(
            Clip(
                id=new_clip_id(),
                track_id=tid,
                source_start=src_start,
                source_end=src_end,
                timeline_start=relative_start,
                source_id=None if source_id is None else str(source_id),
                fade_in_ms=int(raw.get("fade_in_ms", 0) or 0),
                fade_out_ms=int(raw.get("fade_out_ms", 0) or 0),
                join_in_mode=join_mode,
                mute_regions=mute_regions_overlapping(parsed_mutes, src_start, src_end),
            )
        )
    return by_track


def paste_segment(
    project: EpisodeProject,
    insert_at: float,
    duration: float,
    extracts: list[dict],
    *,
    mode: EditMode,
) -> dict:
    """Paste pre-extracted clips at ``insert_at`` on their own tracks.

    Ripple opens ``duration`` of time on every :func:`ripple_track_ids` track first.
    Gap pastes over: it replaces ``[insert_at, insert_at + duration)`` on the pasted
    tracks only, and nothing moves. A clipboard naming an unknown track or source, or
    an impossible range, raises ``PasteRejectedError`` before anything changes.
    """
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("duration must be positive")
    by_track = {tid: clips for tid, clips in _clips_from_paste(project, extracts).items() if clips}
    if mode is EditMode.RIPPLE:
        affected = ripple_track_ids(project, by_track)
        ripple_insert_clips(project, insert_at, duration, affected)
    else:
        affected = sorted(by_track)
        overwritten = {tid: clips_for_track(project, tid) for tid in affected}
        for tid, clips in overwritten.items():
            set_track_clips(
                project,
                tid,
                punch_timeline_range_from_clips(clips, insert_at, insert_at + duration),
            )
        apply_batch_transcript_removes(
            project, [(insert_at, insert_at + duration)], overwritten, rebuild=False
        )
    for tid, extracted in by_track.items():
        merged = place_clips_at(clips_for_track(project, tid), extracted, insert_at)
        set_track_clips(project, tid, merged)
    update_timeline_duration(project)
    rebuild_combined(project)
    return change_summary(
        project,
        operation="paste_segment",
        affected_tracks=affected,
        insert_at=insert_at,
        duration=duration,
        mode=mode.value,
    )


def set_clip_fade(
    project: EpisodeProject,
    clip_id: str,
    fade_in_ms: int,
    fade_out_ms: int,
) -> dict:
    from podcast_mcp.edits.join_modes import clamp_clip_fades

    clip = next((c for c in project.clips if c.id == clip_id), None)
    if not clip:
        raise CodedValueError(f"unknown clip_id: {clip_id!r}", code="clip_not_found")
    clip.fade_in_ms, clip.fade_out_ms = clamp_clip_fades(
        project, clip, int(fade_in_ms), int(fade_out_ms)
    )
    return change_summary(project, operation="set_clip_fade", affected_tracks=[clip.track_id])


def trim_clip_edge(
    project: EpisodeProject,
    plan: TrimPlan,
    clearance: SpeechClearance,
) -> dict:
    """Apply a :func:`~podcast_mcp.edits.ripple.plan_trim` plan the speech guard cleared.

    Rippling trims move every scope track by the same amount, so the episode stays in
    sync; a gap trim moves only the grabbed edge.
    """
    clearance.require(plan.removal)
    clip = next(c for c in project.clips if c.id == plan.clip_id)
    previous = (clip.source_start, clip.source_end, clip.timeline_start, clip.timeline_end)
    clips_before = apply_trim_geometry(project, plan)
    if plan.removal is not None:
        apply_batch_transcript_removes(
            project, list(plan.removal.spans), clips_before, rebuild=False
        )
        remap_review_anchors_for_cuts(project, list(plan.removal.spans))
    restore_archived_words(project, {move.track_id for move in plan.moves})
    rebuild_combined(project)
    clip = next(c for c in project.clips if c.id == plan.clip_id)
    clip_ids = [move.clip_id for move in plan.moves]
    archive_timeline_op(
        project,
        operation="trim_clip_edge",
        track_ids=plan.track_ids,
        source_start=clip.source_start,
        source_end=clip.source_end,
        timeline_start=clip.timeline_start,
        timeline_end=clip.timeline_end,
        params={
            "edge": plan.edge,
            "mode": plan.mode.value,
            "clip_ids": clip_ids,
            "previous_source_start": previous[0],
            "previous_source_end": previous[1],
            "previous_timeline_start": previous[2],
            "previous_timeline_end": previous[3],
            **clearance.log_params(),
        },
    )
    return change_summary(
        project,
        operation="trim_clip_edge",
        affected_tracks=plan.track_ids,
        clip_id=plan.clip_id,
        edge=plan.edge,
        source_sec=plan.moves[0].source_sec,
        mode=plan.mode.value,
        clip_ids=clip_ids,
        **clearance.log_params(),
    )


def move_clips(project: EpisodeProject, clips: list[dict]) -> dict:
    """Reposition clips (session timeline + optional track). Not MoveSegment."""
    from collections.abc import Mapping

    if not isinstance(clips, list) or not clips:
        raise ValueError("clips must be a non-empty list")
    before: dict[str, tuple[str, float, float]] = {}
    for raw in clips:
        if not isinstance(raw, Mapping):
            raise ValueError("each clip move must be an object")
        cid = str(raw["clip_id"])
        clip = next((c for c in project.clips if c.id == cid), None)
        if clip is None:
            raise CodedValueError(f"unknown clip_id: {cid!r}", code="clip_not_found")
        before[cid] = (clip.track_id, clip.timeline_start, clip.timeline_end)
    moved = move_clips_bounds(project, clips)
    rebuild_combined(project)
    track_ids = sorted({c.track_id for c in moved} | {t for t, _, _ in before.values()})
    tl_lo = min(c.timeline_start for c in moved)
    tl_hi = max(c.timeline_end for c in moved)
    for _tid, old_start, old_end in before.values():
        tl_lo = min(tl_lo, old_start)
        tl_hi = max(tl_hi, old_end)
    archive_timeline_op(
        project,
        operation="move_clips",
        track_ids=track_ids,
        timeline_start=tl_lo,
        timeline_end=tl_hi,
        params={
            "clips": [
                {
                    "clip_id": c.id,
                    "track_id": c.track_id,
                    "timeline_start": c.timeline_start,
                    "previous_track_id": before[c.id][0],
                    "previous_timeline_start": before[c.id][1],
                }
                for c in moved
            ]
        },
    )
    return change_summary(
        project,
        operation="move_clips",
        affected_tracks=track_ids,
        clip_ids=[c.id for c in moved],
    )


def roll_clip_join(
    project: EpisodeProject,
    left_clip_id: str,
    right_clip_id: str,
    delta_sec: float,
) -> dict:
    left = next((c for c in project.clips if c.id == left_clip_id), None)
    right = next((c for c in project.clips if c.id == right_clip_id), None)
    if not left or not right:
        raise CodedValueError("unknown clip id for roll join", code="clip_not_found")
    old_left_end = left.source_end
    old_right_start = right.source_start
    old_right_tl = right.timeline_start
    roll_clip_join_bounds(project, left_clip_id, right_clip_id, delta_sec)
    restore_archived_words(project, {left.track_id})
    rebuild_combined(project)
    left = next(c for c in project.clips if c.id == left_clip_id)
    right = next(c for c in project.clips if c.id == right_clip_id)
    archive_timeline_op(
        project,
        operation="roll_clip_join",
        track_ids=[left.track_id],
        source_start=left.source_end,
        source_end=right.source_start,
        timeline_start=left.timeline_end,
        timeline_end=right.timeline_start,
        params={
            "left_clip_id": left_clip_id,
            "right_clip_id": right_clip_id,
            "delta_sec": delta_sec,
            "previous_left_source_end": old_left_end,
            "previous_right_source_start": old_right_start,
            "previous_right_timeline_start": old_right_tl,
        },
    )
    return change_summary(
        project,
        operation="roll_clip_join",
        affected_tracks=[left.track_id],
        left_clip_id=left_clip_id,
        right_clip_id=right_clip_id,
        delta_sec=delta_sec,
        left_source_end=left.source_end,
        right_source_start=right.source_start,
    )


def plan_shorten_word_gaps(
    project: EpisodeProject,
    max_gap_sec: float = 0.35,
    *,
    use_inaudible_opt: bool | None = None,
) -> RippleRemoval | None:
    """Pause excess beyond ``max_gap_sec`` between each track's words, or ``None``.

    Each span is edited by the track whose pause it shortens; another track talking in
    that pause is the speech the guard protects.
    """
    st = SessionTimeline(project)
    spans: list[TrackExtent] = []
    for tr in project.transcripts:
        words = tr.words
        source_spans: list[tuple[SourceSec, SourceSec]] = []
        for i in range(len(words) - 1):
            gap = words[i + 1].start - words[i].end
            if gap > max_gap_sec:
                trim = gap - max_gap_sec
                src_start = words[i].end
                src_end = words[i].end + trim
                source_spans.append((SourceSec(src_start), SourceSec(src_end)))
        for mapped in st.map_source_spans(tr.track_id, source_spans):
            for s, e in mapped:
                start, end = _optimized_ripple_span(project, float(s), float(e), use_inaudible_opt)
                spans.append(TrackExtent(tr.track_id, start, end))
    return RippleRemoval.of(spans) if spans else None


def list_clips(project: EpisodeProject, track_id: str | None = None, *, secret: bytes) -> dict:
    clips = project.clips
    if track_id:
        clips = [c for c in clips if c.track_id == track_id]
    by_track: dict[str, list[dict]] = {}
    sources = {s.id: s for s in project.sources}
    prev_by_track: dict[str, Clip] = {}
    recordings: dict[tuple[str, str | None], tuple[float | None, str | None]] = {}
    for c in sorted(clips, key=lambda x: (x.track_id, x.timeline_start)):
        src = sources.get(c.source_id) if c.source_id else None
        if (c.track_id, c.source_id) not in recordings:
            known = c.source_id is None or src is not None
            recordings[c.track_id, c.source_id] = (
                source_duration_sec(project, c) if known else None,
                recording_key(project, c, secret=secret),
            )
        duration, key = recordings[c.track_id, c.source_id]
        prev = prev_by_track.get(c.track_id)
        prev_by_track[c.track_id] = c
        by_track.setdefault(c.track_id, []).append(
            {
                "id": c.id,
                "track_id": c.track_id,
                "source_start": c.source_start,
                "source_end": c.source_end,
                "timeline_start": c.timeline_start,
                "timeline_end": c.timeline_end,
                "fade_in_ms": c.fade_in_ms,
                "fade_out_ms": c.fade_out_ms,
                "join_in_mode": c.join_in_mode.value,
                **join_render_fields(prev, c),
                "source_id": c.source_id,
                "source_duration_sec": duration,
                "recording_key": key,
                "origin_track_id": origin_track_id_for_clip(project, c),
                "mute_regions": mute_regions_payload(c.mute_regions),
                "clipping_regions": clip_clipping_payload(src, c.source_start, c.source_end),
                "clipping_truncated": clip_clipping_truncated(src, c.source_end),
            }
        )
    return {"tracks": by_track, "clip_count": len(clips)}


def _pad_samples(clips: Sequence[Clip]) -> list[dict[str, Any]]:
    return [
        {
            "track_id": clip.track_id,
            "source_id": clip.source_id,
            "source_start": clip.source_start,
            "source_end": clip.source_end,
        }
        for clip in clips
    ]


def fill_with_room_tone(
    project: EpisodeProject,
    track_id: str,
    *,
    sample_duration_sec: float = 0.25,
    min_gap_sec: float = JOIN_GAP_TOLERANCE_SEC,
) -> dict:
    """Fill timeline gaps between clips with the track's room tone (``edits/room_tone.py``).

    Only gaps wider than ``min_gap_sec`` are filled; the default is the shared join
    tolerance, so pairs that already render as a join are left alone. A gap with no
    room tone near it stays a gap.
    """
    clips = clips_for_track(project, track_id)
    if len(clips) < 2:
        return change_summary(
            project, operation="fill_with_room_tone", affected_tracks=[track_id], pad_samples=[]
        )

    track = project.track_by_id(track_id)
    if not track:
        raise unknown_track(track_id)
    if not track.media and track.room_tone is None:
        raise CodedValueError(f"track {track_id} has no media", code="track_has_no_media")

    new_clips: list[Clip] = []
    inserted: list[Clip] = []
    for i, clip in enumerate(clips):
        new_clips.append(clip)
        if i + 1 >= len(clips):
            break
        gap_start = clip.timeline_end
        gap_end = clips[i + 1].timeline_start
        gap = gap_end - gap_start
        if gap <= min_gap_sec:
            continue
        span = room_tone_span(
            project,
            track_id,
            near_sec=clip.source_end,
            duration_sec=min(sample_duration_sec, gap),
        )
        if isinstance(span, SampleAbsent):
            continue
        if isinstance(span, OwnQuietSample):
            sample_src, src_end, source_id = span.sample.start, span.sample.end, None
        else:
            sample_src, src_end, source_id = span.start, span.end, span.source_id
        piece = max(1e-3, src_end - sample_src)
        t = gap_start
        while t < gap_end - 1e-6:
            remain = gap_end - t
            use = min(piece, remain)
            new_clips.append(
                Clip(
                    id=new_clip_id(),
                    track_id=track_id,
                    source_start=sample_src,
                    source_end=sample_src + use,
                    timeline_start=t,
                    source_id=source_id,
                    fade_in_ms=10 if t == gap_start else 0,
                    fade_out_ms=10 if t + use >= gap_end - 1e-6 else 0,
                    join_in_mode=ClipJoinMode.FADE,
                )
            )
            inserted.append(new_clips[-1])
            t += use
            if use <= 0:  # pragma: no cover
                break

    set_track_clips(project, track_id, sorted(new_clips, key=lambda c: c.timeline_start))
    update_timeline_duration(project)
    # Fill clips duplicate existing source audio; word times are untouched.
    rebuild_combined(project)
    samples = _pad_samples(inserted)
    if inserted:
        archive_timeline_op(
            project,
            operation="fill_with_room_tone",
            track_ids=[track_id],
            params={
                "pad_samples": samples,
                "clips": [{"clip_id": clip.id, "track_id": clip.track_id} for clip in inserted],
            },
        )
    return change_summary(
        project,
        operation="fill_with_room_tone",
        affected_tracks=[track_id],
        pad_samples=samples,
    )


def mute_room_tone_fill(
    project: EpisodeProject, clip: Clip, src_start: float, src_end: float
) -> RoomToneFill | None:
    """Room tone to lay under ``clip``'s muted ``[src_start, src_end)``.

    An unavailable sample leaves this existing in-place mute unfilled.
    """
    lo, hi = max(src_start, clip.source_start), min(src_end, clip.source_end)
    if hi <= lo:
        return None
    span = room_tone_span(project, clip.track_id, near_sec=(lo + hi) / 2.0, duration_sec=hi - lo)
    if isinstance(span, SampleAbsent):
        return None
    if isinstance(span, OwnQuietSample):
        start, end, source_id = span.sample.start, span.sample.end, None
    else:
        start, end, source_id = span.start, span.end, span.source_id
    return RoomToneFill(start_s=start, end_s=end, source_id=source_id)


@dataclass(frozen=True)
class LaneSample:
    track_id: str
    selection: OwnQuietSample | RecordedBedSample


@dataclass(frozen=True)
class LaneWithoutPlayback:
    track_id: str


@dataclass(frozen=True)
class LaneUnavailable:
    track_id: str
    cause: SampleAbsent | str


@dataclass(frozen=True)
class PauseEdgeFade:
    track_id: str
    source_id: str | None
    source_sec: float
    side: Literal["left", "right"]
    milliseconds: int
    _media: Path = field(repr=False)
    timeline_sec: float
    source_start: float
    source_end: float
    inherited_ms: int


@dataclass(frozen=True)
class RoomTonePad:
    at_time: float
    seconds: float
    lanes: tuple[LaneSample | LaneWithoutPlayback | LaneUnavailable, ...]


def _project_pad_lane(
    project: EpisodeProject, tid: str, at_time: float, removal: RippleRemoval | None
) -> list[Clip] | LaneUnavailable:
    from podcast_mcp.edits.track_media import full_span_clip

    track = project.track_by_id(tid)
    clips = [c.model_copy(deep=True) for c in clips_for_track(project, tid)]
    if not clips and track is not None and not track.timeline_empty and track.media:
        duration = track.media.duration_sec
        if duration is None or not math.isfinite(duration) or duration <= 0:
            return LaneUnavailable(tid, "media_extent_unavailable")
        if any(origin_track_id_for_clip(project, c) == tid for c in project.clips):
            return LaneUnavailable(tid, "implicit_playback_with_parked_source")
        clips = [full_span_clip(tid, duration)]
    if removal:
        for start, end in sorted(removal.spans, reverse=True):
            clips = remove_timeline_range_from_clips(clips, start, end)
    else:
        clips = [
            piece
            for clip in clips
            for piece in (
                split_clip_at(clip, at_time)
                if clip.timeline_start + 1e-9 < at_time < clip.timeline_end - 1e-9
                else [clip]
            )
        ]
    return clips


def bind_pause_effects(
    project: EpisodeProject,
    at_time: float,
    removal: RippleRemoval,
    *,
    observation: GeometricPause | MeasuredPause,
    splice_fade_ms: int,
) -> tuple[PauseEdgeFade, ...] | LaneUnavailable:
    """Bind finite effects to canonical survivors, preserving authored source fades."""
    from podcast_mcp.edits.track_media import full_span_clip

    duration = sum(end - start for start, end in removal.spans)
    fades: list[PauseEdgeFade] = []
    for tid in ripple_track_ids(project, removal.edited_track_ids):
        clips = _project_pad_lane(project, tid, at_time, removal)
        if isinstance(clips, LaneUnavailable):
            return clips
        originals = clips_for_track(project, tid)
        track = project.track_by_id(tid)
        if not originals and clips and track is not None and track.media is not None:
            extent = track.media.duration_sec
            if extent is None or not math.isfinite(extent):
                return LaneUnavailable(tid, "media_extent_unavailable")
            originals = [full_span_clip(tid, extent)]
        for clip in clips:
            for side in ("left", "right"):
                timeline_edge = clip.timeline_end if side == "left" else clip.timeline_start
                if abs(timeline_edge - at_time) > 1e-6:
                    continue
                source_edge = clip.source_end if side == "left" else clip.source_start
                try:
                    media = recording_audio_path(project, tid, clip.source_id).resolve(strict=True)
                except (CodedError, OSError, ValueError):
                    return LaneUnavailable(tid, "effect_media_unavailable")
                before_edge = at_time if side == "left" else at_time + duration
                matches = [
                    original
                    for original in originals
                    if original.source_id == clip.source_id
                    and original.source_start - 1e-6 <= clip.source_start
                    and original.source_end + 1e-6 >= clip.source_end
                    and abs(source_edge + clip_source_to_timeline_shift(original) - before_edge)
                    <= 1e-6
                ]
                if len(matches) != 1 or track is None:
                    return LaneUnavailable(tid, "effect_source_geometry")
                original = matches[0]
                authored_edge = original.source_end if side == "left" else original.source_start
                inherited = (
                    (original.fade_out_ms if side == "left" else original.fade_in_ms)
                    if abs(source_edge - authored_edge) <= 1e-6
                    else 0
                )
                activity = [
                    sound
                    for sound in observation.activity
                    if sound.track_id == tid
                    and sound.media is not None
                    and same_recording(sound.media, media)
                ]
                original_start = (
                    before_edge - (clip.source_end - clip.source_start)
                    if side == "left"
                    else before_edge
                )
                original_end = (
                    before_edge
                    if side == "left"
                    else before_edge + (clip.source_end - clip.source_start)
                )
                if side == "left":
                    quiet_start = max(
                        [original_start]
                        + [
                            min(sound.hi, before_edge)
                            for sound in activity
                            if sound.lo < before_edge - 1e-6 and sound.hi > original_start
                        ]
                    )
                    capacity = max(0.0, before_edge - quiet_start)
                else:
                    quiet_end = min(
                        [original_end]
                        + [
                            max(sound.lo, before_edge)
                            for sound in activity
                            if sound.hi > before_edge + 1e-6 and sound.lo < original_end
                        ]
                    )
                    capacity = max(0.0, quiet_end - before_edge)
                capacity_ms = max(0, math.floor(capacity * 1000.0 + 1e-6))
                if (
                    min(inherited, (clip.source_end - clip.source_start) * 1000.0)
                    > capacity_ms + 1e-6
                ):
                    return LaneUnavailable(tid, "unsafe_inherited_fade")
                milliseconds = max(inherited, min(splice_fade_ms, capacity_ms))
                footprint = min(milliseconds / 1000.0, clip.source_end - clip.source_start)
                fades.append(
                    PauseEdgeFade(
                        tid,
                        clip.source_id,
                        source_edge,
                        "left" if side == "left" else "right",
                        milliseconds,
                        media,
                        at_time,
                        source_edge - footprint if side == "left" else source_edge,
                        source_edge if side == "left" else source_edge + footprint,
                        inherited,
                    )
                )
    return tuple(fades)


def room_tone_pad(
    project: EpisodeProject,
    at_time: float,
    seconds: float,
    *,
    sample_duration_sec: float | None = None,
    avoid: Mapping[str, Sequence[tuple[float, float]]] | None = None,
) -> RoomTonePad:
    """Bind every lane's sample at the current seam before inserting a pad."""
    tracks = ripple_track_ids(project)
    lanes: list[LaneSample | LaneWithoutPlayback | LaneUnavailable] = []
    for tid in tracks:
        clips = _project_pad_lane(project, tid, at_time, None)
        if isinstance(clips, LaneUnavailable):
            lanes.append(clips)
            continue
        if not clips:
            lanes.append(LaneWithoutPlayback(tid))
            continue
        excluded = list((avoid or {}).get(tid, ()))
        left = [c for c in clips if abs(c.timeline_end - at_time) <= 1e-6]
        right = [c for c in clips if abs(c.timeline_start - at_time) <= 1e-6]
        if not left:
            before = [c for c in clips if c.timeline_end <= at_time + 1e-6]
            left = [max(before, key=lambda c: c.timeline_end)] if before else []
        if not right:
            after = [c for c in clips if c.timeline_start >= at_time - 1e-6]
            right = [min(after, key=lambda c: c.timeline_start)] if after else []
        near = left[-1].source_end if left else right[0].source_start if right else None
        if near is None:
            lanes.append(LaneUnavailable(tid, "missing_seam"))
            continue
        selected = room_tone_span(
            project,
            tid,
            near_sec=near,
            duration_sec=min(seconds, sample_duration_sec) if sample_duration_sec else seconds,
            avoid=excluded,
        )
        lanes.append(
            LaneUnavailable(tid, selected)
            if isinstance(selected, SampleAbsent)
            else LaneSample(tid, selected)
        )
    return RoomTonePad(at_time, seconds, tuple(lanes))


def insert_bound_room_tone_pad(project: EpisodeProject, pad: RoomTonePad) -> dict:
    """Insert one common gap and tile exactly the samples already measured."""
    at_time, duration_sec = pad.at_time, pad.seconds
    insert_gap(project, at_time, duration_sec)
    inserted: list[Clip] = []
    for lane in pad.lanes:
        if not isinstance(lane, LaneSample):
            continue
        tid, selected = lane.track_id, lane.selection
        if isinstance(selected, OwnQuietSample):
            sample_src, src_end, source_id = selected.sample.start, selected.sample.end, None
        else:
            sample_src, src_end, source_id = selected.start, selected.end, selected.source_id
        fills: list[Clip] = []
        t, pad_end = at_time, at_time + duration_sec
        piece = src_end - sample_src
        while t < pad_end - 1e-6:
            use = min(piece, pad_end - t)
            fills.append(
                Clip(
                    id=new_clip_id(),
                    track_id=tid,
                    source_start=sample_src,
                    source_end=sample_src + use,
                    timeline_start=t,
                    source_id=source_id,
                    fade_in_ms=10 if t == at_time else 0,
                    fade_out_ms=10 if t + use >= pad_end - 1e-6 else 0,
                    join_in_mode=ClipJoinMode.FADE,
                )
            )
            t += use
        set_track_clips(
            project,
            tid,
            sorted(clips_for_track(project, tid) + fills, key=lambda c: c.timeline_start),
        )
        inserted.extend(fills)
    rebuild_combined(project)
    update_timeline_duration(project)
    return change_summary(
        project,
        operation="insert_room_tone_pad",
        affected_tracks=[lane.track_id for lane in pad.lanes],
        at_time=at_time,
        duration_sec=duration_sec,
        pad_samples=_pad_samples(inserted),
    )


def insert_room_tone_pad(
    project: EpisodeProject,
    at_time: float,
    duration_sec: float,
    *,
    sample_duration_sec: float | None = None,
    avoid: Mapping[str, Sequence[tuple[float, float]]] | None = None,
) -> dict:
    """Open a timeline hole at ``at_time`` and fill it with room-tone clips.

    Used after filler/NL ripple deletes when ``replace_gap_sec`` is set so the
    flanking words keep a natural beat of air instead of butting together. ``avoid``
    is, per track, the source seconds its room tone may not be taken from.
    """
    if duration_sec <= 0:
        raise ValueError("duration_sec must be positive")
    pad = room_tone_pad(
        project, at_time, duration_sec, sample_duration_sec=sample_duration_sec, avoid=avoid
    )
    return insert_bound_room_tone_pad(project, pad)
