from __future__ import annotations

from collections.abc import Callable

from pydantic import ValidationError

from podcast_mcp.edits.clipping_regions import clip_clipping_payload, clip_clipping_truncated
from podcast_mcp.edits.clips_ops import (
    JOIN_GAP_TOLERANCE_SEC,
    build_clips_after_removes,
    clips_for_track,
    extract_clips_in_timeline_range,
    new_clip_id,
    place_clips_at,
    punch_timeline_range_from_clips,
    remove_timeline_range_from_clips,
    set_track_clips,
    shift_clips_timeline,
    split_clip_at,
    update_timeline_duration,
)
from podcast_mcp.edits.clips_ops import (
    move_clips as move_clips_bounds,
)
from podcast_mcp.edits.clips_ops import (
    roll_clip_join as roll_clip_join_bounds,
)
from podcast_mcp.edits.clips_ops import (
    trim_clip_edge as trim_clip_edge_bounds,
)
from podcast_mcp.edits.comment_remap import remap_review_anchors_for_cuts
from podcast_mcp.edits.edit_log import archive_timeline_op
from podcast_mcp.edits.inaudible_cuts import (
    optimize_timeline_cut_range,
    recommend_micro_fades,
)
from podcast_mcp.edits.mute_regions import intersect_mute_regions, mute_regions_payload
from podcast_mcp.edits.ranges import merge_timeline_ranges
from podcast_mcp.edits.transcript_cuts import TranscriptMatch, search_transcript
from podcast_mcp.edits.transcript_sync import (
    apply_batch_transcript_removes,
    rebuild_combined,
)
from podcast_mcp.engines.session_timeline import SessionTimeline, origin_track_id_for_clip
from podcast_mcp.models import Clip, ClipJoinMode, ClipMuteRegion, EpisodeProject
from podcast_mcp.util.change_summary import change_summary
from podcast_mcp.util.timebase import SourceSec
from podcast_mcp.util.tracks import dialogue_track_ids


def batch_ripple_delete(
    project: EpisodeProject,
    ranges: list[tuple[float, float]],
    *,
    use_inaudible_opt: bool | None = None,
) -> dict:
    """Remove many timeline ranges in one pass across all dialogue tracks."""
    removes = merge_timeline_ranges(ranges)
    if not removes:
        return change_summary(project, operation="batch_ripple_delete", affected_tracks=[])

    if use_inaudible_opt is not False:
        optimized: list[tuple[float, float]] = []
        tracks = dialogue_track_ids(project)
        for start, end in removes:
            if tracks:
                starts: list[float] = []
                ends: list[float] = []
                for tid in tracks:
                    opt = optimize_timeline_cut_range(
                        project,
                        tid,
                        start,
                        end,
                        force_enabled=use_inaudible_opt,
                    )
                    starts.append(opt.start)
                    ends.append(opt.end)
                if starts and ends:
                    starts.sort()
                    ends.sort()
                    start = starts[len(starts) // 2]
                    end = ends[len(ends) // 2]
                    if end <= start:
                        start, end = starts[0], ends[-1]
            optimized.append((start, end))
        removes = merge_timeline_ranges(optimized)

    tracks = dialogue_track_ids(project)
    clips_before = {tid: clips_for_track(project, tid) for tid in tracks}
    for tid in tracks:
        set_track_clips(
            project,
            tid,
            build_clips_after_removes(project, tid, removes),
        )
    apply_batch_transcript_removes(project, removes, rebuild=True, clips_before=clips_before)
    remap_review_anchors_for_cuts(project, removes)
    update_timeline_duration(project)
    return change_summary(
        project,
        operation="batch_ripple_delete",
        affected_tracks=tracks,
        range_count=len(removes),
        use_inaudible_opt=use_inaudible_opt,
    )


def ripple_delete(
    project: EpisodeProject,
    timeline_start: float,
    timeline_end: float,
    *,
    use_inaudible_opt: bool | None = None,
    record_log: bool = True,
) -> dict:
    if timeline_end <= timeline_start:
        raise ValueError("timeline_end must be after timeline_start")
    tracks = dialogue_track_ids(project)
    if tracks:
        starts: list[float] = []
        ends: list[float] = []
        for tid in tracks:
            opt = optimize_timeline_cut_range(
                project,
                tid,
                timeline_start,
                timeline_end,
                force_enabled=use_inaudible_opt,
            )
            starts.append(opt.start)
            ends.append(opt.end)
        if starts and ends:
            starts.sort()
            ends.sort()
            timeline_start = starts[len(starts) // 2]
            timeline_end = ends[len(ends) // 2]
            if timeline_end <= timeline_start:
                timeline_start, timeline_end = starts[0], ends[-1]
    clips_before = {tid: clips_for_track(project, tid) for tid in tracks}
    for tid in tracks:
        updated = remove_timeline_range_from_clips(
            clips_for_track(project, tid),
            timeline_start,
            timeline_end,
        )
        set_track_clips(project, tid, updated)
    from podcast_mcp.edits.transcript_sync import (
        apply_source_transcript_removes,
        timeline_removes_to_source_ranges,
    )

    removes_by_track = {
        tid: timeline_removes_to_source_ranges(clips_before[tid], [(timeline_start, timeline_end)])
        for tid in tracks
    }
    apply_source_transcript_removes(project, removes_by_track)
    remap_review_anchors_for_cuts(project, [(timeline_start, timeline_end)])
    update_timeline_duration(project)
    if record_log:
        archive_timeline_op(
            project,
            operation="ripple_delete",
            track_ids=tracks,
            timeline_start=timeline_start,
            timeline_end=timeline_end,
            params={"use_inaudible_opt": use_inaudible_opt},
        )
    return change_summary(
        project,
        operation="ripple_delete",
        affected_tracks=tracks,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        use_inaudible_opt=use_inaudible_opt,
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
    """Remove audio on one track only; leave a silence hole (no peer ripple)."""
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
    from podcast_mcp.edits.transcript_sync import (
        apply_source_transcript_removes,
        timeline_removes_to_source_ranges,
    )

    src_ranges = timeline_removes_to_source_ranges(clips_before, [(timeline_start, timeline_end)])
    if src_ranges:
        apply_source_transcript_removes(project, {track_id: src_ranges})
    else:
        rebuild_combined(project)
    update_timeline_duration(project)
    if record_log:
        archive_timeline_op(
            project,
            operation="punch_delete",
            track_ids=[track_id],
            timeline_start=timeline_start,
            timeline_end=timeline_end,
            params={"use_inaudible_opt": use_inaudible_opt, "scope": "track"},
        )
    return change_summary(
        project,
        operation="punch_delete",
        affected_tracks=[track_id],
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        use_inaudible_opt=use_inaudible_opt,
    )


def ripple_delete_text(
    project: EpisodeProject,
    query: str,
    *,
    use_inaudible_opt: bool | None = None,
) -> dict:
    matches = search_transcript(project, query)
    if not matches:
        raise ValueError(f"no transcript match for {query!r}")
    m = matches[0]
    if m.timeline_start is None or m.timeline_end is None:
        raise ValueError(f"transcript match for {query!r} falls in removed timeline material")
    result = ripple_delete(
        project,
        m.timeline_start,
        m.timeline_end,
        use_inaudible_opt=use_inaudible_opt,
    )
    result["query"] = query
    return result


def insert_gap(
    project: EpisodeProject,
    at_time: float,
    duration_sec: float,
) -> dict:
    if duration_sec <= 0:
        raise ValueError("duration_sec must be positive")
    tracks = dialogue_track_ids(project)
    for tid in tracks:
        clips = list(clips_for_track(project, tid))
        split: list = []
        for clip in clips:
            tl_end = clip.timeline_end
            if clip.timeline_start + 1e-9 < at_time < tl_end - 1e-9:
                before, after = split_clip_at(clip, at_time)
                split.append(before)
                split.append(after)
            else:
                split.append(clip)
        shift_clips_timeline(split, at_time, duration_sec)
        set_track_clips(project, tid, split)
    # Words stay in source coordinates; only clip placement moves.
    rebuild_combined(project)
    update_timeline_duration(project)
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
    tracks = dialogue_track_ids(project)
    extracted_by_track: dict[str, list[Clip]] = {}
    for tid in tracks:
        extracted_by_track[tid] = extract_clips_in_timeline_range(
            clips_for_track(project, tid),
            source_start,
            source_end,
        )
    # Clip-only ripple: keep transcript words (source clocks). Moving remaps
    # them via the new clip placements; deleting words would orphan the audio.
    for tid in tracks:
        updated = remove_timeline_range_from_clips(
            clips_for_track(project, tid),
            source_start,
            source_end,
        )
        set_track_clips(project, tid, updated)
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
        raise ValueError(f"no {label} match for {query!r}")
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
        raise ValueError(f"no clip at timeline {at_time} on track {track_id}")
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
        raise ValueError(f"no clip at timeline {at_time} on tracks {tracks}")
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
            },
        )
    return change_summary(
        project,
        operation="split_clips_at",
        affected_tracks=affected,
        at_time=at_time,
        skipped_track_ids=skipped,
    )


def delete_clips(
    project: EpisodeProject,
    clip_ids: list[str],
    *,
    ripple: bool = False,
    record_log: bool = True,
) -> dict:
    """Delete selected clips by id (punch hole) or ripple-delete their spans."""
    if not clip_ids:
        raise ValueError("clip_ids required")
    by_id = {c.id: c for c in project.clips}
    missing = [cid for cid in clip_ids if cid not in by_id]
    if missing:
        raise KeyError(f"unknown clip_id(s): {missing}")
    clips = [by_id[cid] for cid in clip_ids]
    track_ids = sorted({c.track_id for c in clips})
    # Snapshot ranges before mutating (clip ids change under punch/ripple).
    jobs = [(c.track_id, c.timeline_start, c.timeline_end) for c in clips]
    if ripple:
        ranges = merge_timeline_ranges([(s, e) for _, s, e in jobs])
        for start, end in sorted(ranges, key=lambda r: r[0], reverse=True):
            ripple_delete(
                project,
                start,
                end,
                use_inaudible_opt=False,
                record_log=False,
            )
        if record_log:
            archive_timeline_op(
                project,
                operation="ripple_delete_clips",
                track_ids=track_ids,
                params={"clip_ids": list(clip_ids), "ripple": True},
            )
        return change_summary(
            project,
            operation="ripple_delete_clips",
            affected_tracks=track_ids,
            clip_ids=list(clip_ids),
        )
    for track_id, start, end in sorted(jobs, key=lambda j: j[1], reverse=True):
        punch_delete(
            project,
            track_id,
            start,
            end,
            use_inaudible_opt=False,
            record_log=False,
        )
    if record_log:
        archive_timeline_op(
            project,
            operation="delete_clips",
            track_ids=track_ids,
            params={"clip_ids": list(clip_ids), "ripple": False},
        )
    return change_summary(
        project,
        operation="delete_clips",
        affected_tracks=track_ids,
        clip_ids=list(clip_ids),
    )


def duplicate_segment(
    project: EpisodeProject,
    source_start: float,
    source_end: float,
    insert_at: float,
) -> dict:
    duration = source_end - source_start
    tracks = dialogue_track_ids(project)
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


def paste_segment(
    project: EpisodeProject,
    insert_at: float,
    duration: float,
    extracts: list[dict],
) -> dict:
    """Paste pre-extracted clips at *insert_at* (same-track; gap on all dialogue)."""
    if duration <= 0:
        raise ValueError("duration must be positive")
    tracks = dialogue_track_ids(project)
    by_track: dict[str, list[Clip]] = {tid: [] for tid in tracks}
    for raw in extracts:
        tid = str(raw["track_id"])
        if tid not in by_track:
            by_track[tid] = []
        join_raw = raw.get("join_in_mode", ClipJoinMode.FADE.value)
        try:
            join_mode = ClipJoinMode(str(join_raw))
        except ValueError:
            join_mode = ClipJoinMode.FADE
        src_start = float(raw["source_start"])
        src_end = float(raw["source_end"])
        mute_raw = raw.get("mute_regions") or []
        parsed_mutes: list[ClipMuteRegion] = []
        if isinstance(mute_raw, list):
            for item in mute_raw:
                if not isinstance(item, dict):
                    continue
                start_raw = item.get("start_s")
                end_raw = item.get("end_s")
                if start_raw is None or end_raw is None:
                    continue
                try:
                    start = float(start_raw)
                    end = float(end_raw)
                except (TypeError, ValueError):
                    continue
                try:
                    parsed_mutes.append(ClipMuteRegion(start_s=start, end_s=end))
                except (TypeError, ValueError, ValidationError):
                    continue
        by_track.setdefault(tid, []).append(
            Clip(
                id=new_clip_id(),
                track_id=tid,
                source_start=src_start,
                source_end=src_end,
                timeline_start=float(raw.get("relative_timeline_start", 0.0)),
                source_id=raw.get("source_id"),
                fade_in_ms=int(raw.get("fade_in_ms", 0) or 0),
                fade_out_ms=int(raw.get("fade_out_ms", 0) or 0),
                join_in_mode=join_mode,
                mute_regions=intersect_mute_regions(parsed_mutes, src_start, src_end),
            )
        )
    insert_gap(project, insert_at, duration)
    affected = sorted(by_track.keys())
    for tid, extracted in by_track.items():
        if tid not in tracks and not extracted:
            continue
        clips = clips_for_track(project, tid) if tid in tracks else []
        merged = place_clips_at(clips, extracted, insert_at)
        set_track_clips(project, tid, merged)
    update_timeline_duration(project)
    rebuild_combined(project)
    return change_summary(
        project,
        operation="paste_segment",
        affected_tracks=affected,
        insert_at=insert_at,
        duration=duration,
    )


def set_clip_fade(
    project: EpisodeProject,
    clip_id: str,
    fade_in_ms: int,
    fade_out_ms: int,
) -> dict:
    from podcast_mcp.edits.join_modes import cap_fade_ms

    clip = next((c for c in project.clips if c.id == clip_id), None)
    if not clip:
        raise ValueError(f"unknown clip_id: {clip_id!r}")
    clip.fade_in_ms = cap_fade_ms(project, clip.track_id, int(fade_in_ms))
    clip.fade_out_ms = cap_fade_ms(project, clip.track_id, int(fade_out_ms))
    return change_summary(project, operation="set_clip_fade", affected_tracks=[clip.track_id])


def trim_clip_edge(
    project: EpisodeProject,
    clip_id: str,
    edge: str,
    source_sec: float,
    *,
    mode: str = "ripple",
) -> dict:
    clip = next((c for c in project.clips if c.id == clip_id), None)
    if not clip:
        raise ValueError(f"unknown clip_id: {clip_id!r}")
    old_start = clip.source_start
    old_end = clip.source_end
    old_tl_start = clip.timeline_start
    old_tl_end = clip.timeline_end
    trim_clip_edge_bounds(project, clip_id, edge, source_sec, mode=mode)
    rebuild_combined(project)
    clip = next(c for c in project.clips if c.id == clip_id)
    archive_timeline_op(
        project,
        operation="trim_clip_edge",
        track_ids=[clip.track_id],
        source_start=clip.source_start,
        source_end=clip.source_end,
        timeline_start=clip.timeline_start,
        timeline_end=clip.timeline_end,
        params={
            "edge": edge,
            "mode": mode,
            "previous_source_start": old_start,
            "previous_source_end": old_end,
            "previous_timeline_start": old_tl_start,
            "previous_timeline_end": old_tl_end,
        },
    )
    return change_summary(
        project,
        operation="trim_clip_edge",
        affected_tracks=[clip.track_id],
        clip_id=clip_id,
        edge=edge,
        source_sec=source_sec,
        mode=mode,
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
            raise ValueError(f"unknown clip_id: {cid!r}")
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
        raise ValueError("unknown clip id for roll join")
    old_left_end = left.source_end
    old_right_start = right.source_start
    old_right_tl = right.timeline_start
    roll_clip_join_bounds(project, left_clip_id, right_clip_id, delta_sec)
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


def shorten_word_gaps(
    project: EpisodeProject,
    max_gap_sec: float = 0.35,
    *,
    use_inaudible_opt: bool | None = None,
) -> dict:
    """Ripple-delete excess pause between words on dialogue tracks."""
    st = SessionTimeline(project)
    ranges: list[tuple[float, float]] = []
    for tr in project.transcripts:
        words = tr.words
        for i in range(len(words) - 1):
            gap = words[i + 1].start - words[i].end
            if gap > max_gap_sec:
                trim = gap - max_gap_sec
                src_start = words[i].end
                src_end = words[i].end + trim
                for tl_s, tl_e in st.map_source_span(
                    tr.track_id, SourceSec(src_start), SourceSec(src_end)
                ):
                    ranges.append((float(tl_s), float(tl_e)))

    ranges.sort(key=lambda r: r[0])
    merged: list[tuple[float, float]] = []
    for start, end in ranges:
        if merged and start <= merged[-1][1] + 1e-6:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    for start, end in reversed(merged):
        ripple_delete(
            project,
            start,
            end,
            use_inaudible_opt=use_inaudible_opt,
        )

    return change_summary(
        project,
        operation="shorten_word_gaps",
        affected_tracks=dialogue_track_ids(project),
    )


def list_clips(project: EpisodeProject, track_id: str | None = None) -> dict:
    clips = project.clips
    if track_id:
        clips = [c for c in clips if c.track_id == track_id]
    by_track: dict[str, list[dict]] = {}
    sources = {s.id: s for s in project.sources}
    for c in sorted(clips, key=lambda x: (x.track_id, x.timeline_start)):
        src = sources.get(c.source_id) if c.source_id else None
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
                "source_id": c.source_id,
                "origin_track_id": origin_track_id_for_clip(project, c),
                "mute_regions": mute_regions_payload(c.mute_regions),
                "clipping_regions": clip_clipping_payload(src, c.source_start, c.source_end),
                "clipping_truncated": clip_clipping_truncated(src, c.source_end),
            }
        )
    return {"tracks": by_track, "clip_count": len(clips)}


def _merge_occupied_intervals(
    intervals: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    if not intervals:
        return []
    ordered = sorted(intervals)
    merged: list[tuple[float, float]] = [ordered[0]]
    for start, end in ordered[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end + 1e-9:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _expand_intervals(
    intervals: list[tuple[float, float]],
    *,
    margin_sec: float,
    clip_start: float,
    clip_end: float,
) -> list[tuple[float, float]]:
    """Pad each interval so we do not sample speech tails / onsets / bleed skirts."""
    if margin_sec <= 0:
        return list(intervals)
    out: list[tuple[float, float]] = []
    for start, end in intervals:
        a = max(clip_start, start - margin_sec)
        b = min(clip_end, end + margin_sec)
        if b > a + 1e-9:
            out.append((a, b))
    return out


def _gaps_from_occupied(
    clip_start: float,
    clip_end: float,
    occupied: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    gaps: list[tuple[float, float]] = []
    cursor = clip_start
    for start, end in _merge_occupied_intervals(occupied):
        if start > cursor + 1e-9:
            gaps.append((cursor, start))
        cursor = max(cursor, end)
    if clip_end > cursor + 1e-9:
        gaps.append((cursor, clip_end))
    return gaps


def _own_word_source_occupancy(
    project: EpisodeProject, track_id: str, clip: Clip
) -> list[tuple[float, float]]:
    """Source intervals inside ``clip`` covered by this track's words.

    Suppressed words still have audible audio, so they count as occupied.
    """
    tr = project.transcript_for_track(track_id)
    occupied: list[tuple[float, float]] = []
    if not tr:
        return occupied
    for w in tr.words:
        if w.end <= w.start:
            continue
        if w.end <= clip.source_start or w.start >= clip.source_end:
            continue
        occupied.append((max(clip.source_start, w.start), min(clip.source_end, w.end)))
    return occupied


def _peer_speech_source_occupancy(
    project: EpisodeProject, track_id: str, clip: Clip
) -> list[tuple[float, float]]:
    """Source intervals inside ``clip`` where another dialogue track has words.

    Peer speech on the session clock bleeds into this mic even when this
    track's transcript is empty - tiling that air repeats the other speaker.
    """
    from podcast_mcp.util.timebase import TimelineSec

    st = SessionTimeline(project)
    clip_tl0 = float(clip.timeline_start)
    clip_tl1 = float(clip.timeline_end)
    occupied: list[tuple[float, float]] = []
    for peer_id in dialogue_track_ids(project):
        if peer_id == track_id:
            continue
        tr = project.transcript_for_track(peer_id)
        if not tr:
            continue
        # Narrow to peer source near this clip's timeline window (aligned remotes).
        peer_lo: float | None = None
        peer_hi: float | None = None
        for tl in (clip_tl0, clip_tl1):
            mapped = st.timeline_to_source(peer_id, TimelineSec(tl))
            if mapped is None:
                continue
            v = float(mapped)
            peer_lo = v if peer_lo is None else min(peer_lo, v)
            peer_hi = v if peer_hi is None else max(peer_hi, v)
        for w in tr.words:
            if w.end <= w.start:
                continue
            if (
                peer_lo is not None
                and peer_hi is not None
                and (w.end < peer_lo - 1.0 or w.start > peer_hi + 1.0)
            ):
                continue
            for tl_a, tl_b in st.map_source_span(peer_id, SourceSec(w.start), SourceSec(w.end)):
                a = max(float(tl_a), clip_tl0)
                b = min(float(tl_b), clip_tl1)
                if b <= a + 1e-9:
                    continue
                occupied.append(
                    (
                        clip.source_start + (a - clip_tl0),
                        clip.source_start + (b - clip_tl0),
                    )
                )
    return occupied


def _room_tone_edge_margin_sec(defaults: dict | None = None) -> float:
    from podcast_mcp.config import load_defaults

    cfg = defaults if defaults is not None else load_defaults()
    raw = (cfg.get("tighten") or {}).get("room_tone_edge_margin_sec", 0.15)
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        return 0.15


def _room_tone_min_rms_db(defaults: dict | None = None) -> float:
    """Reject digital-silence 'air' below this RMS (dB). Missing audio → skip check."""
    from podcast_mcp.config import load_defaults

    cfg = defaults if defaults is not None else load_defaults()
    raw = (cfg.get("tighten") or {}).get("room_tone_min_rms_db", -65.0)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return -65.0


def _room_tone_span_has_audible_air(
    project: EpisodeProject,
    track_id: str,
    src_start: float,
    src_end: float,
    *,
    min_rms_db: float | None = None,
) -> bool:
    """True when the sample has measurable room noise (not digital silence).

    When RMS cannot be measured (missing fixture media), allow the span so unit
    tests and offline paths keep prior behavior.
    """
    from pathlib import Path

    from podcast_mcp.engines.audio_audit import measure_window_rms_db

    track = project.track_by_id(track_id)
    if not track or not track.media:
        return False
    path = Path(track.media.path)
    if not path.is_absolute():
        path = Path(project.workspace_dir) / track.media.path
    floor = float(min_rms_db) if min_rms_db is not None else _room_tone_min_rms_db()
    rms = measure_window_rms_db(path, src_start, src_end)
    if rms is None:
        return True
    return rms >= floor


def _room_tone_safe_gaps_in_clip(
    project: EpisodeProject,
    track_id: str,
    clip: Clip,
    *,
    edge_margin_sec: float | None = None,
) -> list[tuple[float, float]]:
    """Source intervals safe to sample as room tone inside ``clip``.

    Excludes this track's words (including suppressed) and peer-track speech
    mapped onto the same timeline window (bleed risk). Word edges are padded by
    ``edge_margin_sec`` so inter-word micro-gaps and speech skirts are not tiled.
    """
    margin = float(edge_margin_sec) if edge_margin_sec is not None else _room_tone_edge_margin_sec()
    occupied = _own_word_source_occupancy(project, track_id, clip)
    occupied.extend(_peer_speech_source_occupancy(project, track_id, clip))
    occupied = _expand_intervals(
        occupied,
        margin_sec=margin,
        clip_start=clip.source_start,
        clip_end=clip.source_end,
    )
    return _gaps_from_occupied(clip.source_start, clip.source_end, occupied)


def _pick_room_tone_from_gaps(
    gaps: list[tuple[float, float]],
    *,
    duration_sec: float,
    prefer_end: bool,
    accept: Callable[[float, float], bool] | None = None,
) -> tuple[float, float] | None:
    """Take a full ``duration_sec`` from a safe gap; prefer gaps nearest the cut.

    Shorter scraps (inter-word micro-gaps after edge margin) are rejected -
    tiling them sounds like stuttered speech or bleed, not room tone.
    ``accept(start, end)`` may reject digital silence or other unusable air.
    """
    if prefer_end:
        ranked = sorted(gaps, key=lambda g: g[1], reverse=True)
    else:
        ranked = sorted(gaps, key=lambda g: g[0])
    for start, end in ranked:
        if end - start >= duration_sec - 1e-9:
            span = (end - duration_sec, end) if prefer_end else (start, start + duration_sec)
            if accept is not None and not accept(span[0], span[1]):
                continue
            return span
    return None


def room_tone_source_id(track_id: str) -> str:
    """Stable ``sources[]`` id for a track's recorded room-tone bed."""
    return f"room-tone-{track_id}"


def _room_tone_bed_span(
    project: EpisodeProject,
    track_id: str,
    *,
    duration_sec: float,
) -> tuple[float, float, str] | None:
    """Return ``(source_start, source_end, source_id)`` from a recorded bed."""
    if duration_sec <= 0:
        return None
    track = project.track_by_id(track_id)
    if track is None or track.room_tone is None:
        return None
    bed_dur = float(track.room_tone.duration_sec or 0.0)
    if bed_dur <= 0:
        return None
    source_id = room_tone_source_id(track_id)
    if not any(src.id == source_id for src in project.sources):
        return None
    use = min(bed_dur, duration_sec)
    if use <= 0:
        return None
    from pathlib import Path

    from podcast_mcp.engines.audio_audit import measure_window_rms_db

    path = Path(track.room_tone.path)
    if not path.is_absolute():
        path = Path(project.workspace_dir) / track.room_tone.path
    rms = measure_window_rms_db(path, 0.0, use)
    if rms is not None and rms < _room_tone_min_rms_db():
        return None
    return (0.0, use, source_id)


def _room_tone_source_span(
    project: EpisodeProject,
    track_id: str,
    left: Clip,
    *,
    duration_sec: float,
    right: Clip | None = None,
    edge_margin_sec: float | None = None,
) -> tuple[float, float, str | None] | None:
    """Pick ``duration_sec`` of near-cut air for a room-tone pad.

    Prefers a recorded ``track.room_tone`` bed when present (returns its
    ``source_id``). Otherwise only samples **safe** stem air: no own-track
    words (suppressed still sound) and no peer-track speech on the session
    clock (bleed). Word edges are padded so inter-word micro-gaps are not
    stolen. Prefers leading air on ``right``, then gaps in ``left`` nearest
    the cut. Never falls back to "last N seconds of left" when that overlaps
    speech or bleed (tiling either sounds like stuttering / repeating the
    other mic). Stem-steal spans return ``source_id=None``.
    """
    bed = _room_tone_bed_span(project, track_id, duration_sec=duration_sec)
    if bed is not None:
        return bed
    if duration_sec <= 0:
        return None
    track = project.track_by_id(track_id)
    if not track or not track.media:
        return None
    margin = float(edge_margin_sec) if edge_margin_sec is not None else _room_tone_edge_margin_sec()
    min_rms = _room_tone_min_rms_db()

    def _accept(s: float, e: float) -> bool:
        return _room_tone_span_has_audible_air(project, track_id, s, e, min_rms_db=min_rms)

    # 1) Leading air on the right clip (quiet before the next word).
    if right is not None and right.source_end > right.source_start:
        right_gaps = _room_tone_safe_gaps_in_clip(project, track_id, right, edge_margin_sec=margin)
        # Only the gap that starts at the clip head is "leading air".
        leading = [g for g in right_gaps if abs(g[0] - right.source_start) < 1e-6]
        span = _pick_room_tone_from_gaps(
            leading,
            duration_sec=duration_sec,
            prefer_end=False,
            accept=_accept,
        )
        if span is not None:
            return (*span, None)

    # 2) Safe gaps in the left clip, preferring air nearest the cut.
    left_gaps = _room_tone_safe_gaps_in_clip(project, track_id, left, edge_margin_sec=margin)
    span = _pick_room_tone_from_gaps(
        left_gaps,
        duration_sec=duration_sec,
        prefer_end=True,
        accept=_accept,
    )
    if span is not None:
        return (*span, None)

    # 3) No safe air - skip rather than tile dialogue, bleed, or digital silence.
    return None


def fill_with_room_tone(
    project: EpisodeProject,
    track_id: str,
    *,
    sample_duration_sec: float = 0.25,
    min_gap_sec: float = JOIN_GAP_TOLERANCE_SEC,
) -> dict:
    """Fill timeline gaps between clips using audio from a nearby non-speech sample.

    Only gaps wider than ``min_gap_sec`` are filled; the default is the shared join
    tolerance, so pairs that already render as a join are left alone.
    """
    clips = clips_for_track(project, track_id)
    if len(clips) < 2:
        return change_summary(project, operation="fill_with_room_tone", affected_tracks=[track_id])

    track = project.track_by_id(track_id)
    if not track:
        raise ValueError(f"track {track_id} not found")
    bed = _room_tone_bed_span(project, track_id, duration_sec=sample_duration_sec)
    if not track.media and bed is None:
        raise ValueError(f"track {track_id} has no media")

    new_clips: list[Clip] = []
    for i, clip in enumerate(clips):
        new_clips.append(clip)
        if i + 1 >= len(clips):
            break
        gap_start = clip.timeline_end
        gap_end = clips[i + 1].timeline_start
        gap = gap_end - gap_start
        if gap <= min_gap_sec:
            continue
        source_id: str | None = None
        if bed is not None:
            sample_src, src_end, source_id = bed
        else:
            span = _room_tone_source_span(
                project,
                track_id,
                clip,
                duration_sec=min(sample_duration_sec, gap),
                right=clips[i + 1],
            )
            if span is None:
                continue
            sample_src, src_end, source_id = span
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
            t += use
            if use <= 0:  # pragma: no cover
                break

    set_track_clips(project, track_id, sorted(new_clips, key=lambda c: c.timeline_start))
    update_timeline_duration(project)
    # Fill clips duplicate existing source audio; word times are untouched.
    rebuild_combined(project)
    return change_summary(project, operation="fill_with_room_tone", affected_tracks=[track_id])


def insert_room_tone_pad(
    project: EpisodeProject,
    at_time: float,
    duration_sec: float,
    *,
    sample_duration_sec: float | None = None,
) -> dict:
    """Open a timeline hole at ``at_time`` and fill it with room-tone clips.

    Used after filler/NL ripple deletes when ``replace_gap_sec`` is set so the
    flanking words keep a natural beat of air instead of butting together.
    """
    if duration_sec <= 0:
        raise ValueError("duration_sec must be positive")
    sample_dur = float(sample_duration_sec) if sample_duration_sec is not None else duration_sec
    tracks = dialogue_track_ids(project)
    insert_gap(project, at_time, duration_sec)
    for tid in tracks:
        clips = clips_for_track(project, tid)
        left: Clip | None = None
        for c in clips:
            if (
                abs(c.timeline_end - at_time) < 1e-3
                or (c.timeline_start < at_time and c.timeline_end <= at_time + 1e-6)
            ) and (left is None or c.timeline_end > left.timeline_end):
                left = c
        if left is None:
            # Closest clip ending at or before the pad.
            before = [c for c in clips if c.timeline_end <= at_time + 1e-6]
            left = max(before, key=lambda c: c.timeline_end) if before else None
        right: Clip | None = None
        after = [c for c in clips if c.timeline_start >= at_time + duration_sec - 1e-3]
        if after:
            right = min(after, key=lambda c: c.timeline_start)
        source_id: str | None = None
        bed = _room_tone_bed_span(project, tid, duration_sec=min(sample_dur, duration_sec))
        if bed is not None:
            sample_src, src_end, source_id = bed
        elif left is None:
            continue
        else:
            span = _room_tone_source_span(
                project,
                tid,
                left,
                duration_sec=min(sample_dur, duration_sec),
                right=right,
            )
            if span is None:
                continue
            sample_src, src_end, source_id = span
        # Tile short samples across the pad when source room tone is shorter.
        fills: list[Clip] = []
        t = at_time
        pad_end = at_time + duration_sec
        piece = src_end - sample_src
        while t < pad_end - 1e-6:
            remain = pad_end - t
            use = min(piece, remain)
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
            if use <= 0:  # pragma: no cover - defensive against zero-length tiles
                break
        merged = sorted(clips + fills, key=lambda c: c.timeline_start)
        set_track_clips(project, tid, merged)
    rebuild_combined(project)
    update_timeline_duration(project)
    return change_summary(
        project,
        operation="insert_room_tone_pad",
        affected_tracks=tracks,
        at_time=at_time,
        duration_sec=duration_sec,
    )
