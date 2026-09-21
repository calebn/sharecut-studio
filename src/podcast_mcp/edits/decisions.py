from __future__ import annotations

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.cut_quality import recommend_cut_fade_ms, recommend_post_pad_fade_in_ms
from podcast_mcp.edits.edit_log import archive_decision
from podcast_mcp.edits.filler_pacing import filler_pad_mode
from podcast_mcp.edits.mute_regions import add_source_mute
from podcast_mcp.edits.timeline_ops import (
    insert_gap,
    insert_room_tone_pad,
    punch_delete,
    ripple_delete,
    split_clips_at,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    ClipJoinMode,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    TrackRole,
)
from podcast_mcp.util.review import reject_by_id
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids


def _tighten_cfg() -> dict:
    return dict(load_defaults().get("tighten", {}) or {})


def _defaults_all() -> dict:
    return load_defaults()


def _edit_to_timeline_range(project: EpisodeProject, edit: EditDecision) -> tuple[float, float]:
    spans = SessionTimeline(project).map_source_span(
        edit.track_id, SourceSec(edit.start), SourceSec(edit.end)
    )
    if not spans:
        return edit.start, edit.end
    return float(spans[0][0]), float(spans[-1][1])


def _per_track_source_for_timeline(
    project: EpisodeProject, timeline_start: float, timeline_end: float
) -> dict[str, list[float]]:
    """Map a timeline hole to each dialogue track's source range (pre-ripple)."""
    st = SessionTimeline(project)
    out: dict[str, list[float]] = {}
    for tid in dialogue_track_ids(project):
        spans = st.map_timeline_span(tid, TimelineSec(timeline_start), TimelineSec(timeline_end))
        if not spans:
            continue
        out[tid] = [float(spans[0][0]), float(spans[-1][1])]
    return out


def apply_join_fades_from_decisions(
    project: EpisodeProject,
    decisions: list[EditDecision],
    *,
    defaults: dict | None = None,
) -> dict:
    """Set per-join fade lengths on clip boundaries from applied edit decisions."""
    cfg = defaults or load_defaults()
    by_track: dict[str, list[EditDecision]] = {}
    for d in decisions:
        by_track.setdefault(d.track_id, []).append(d)

    affected: set[str] = set()
    for tid, decs in by_track.items():
        clips = clips_for_track(project, tid)
        for i in range(len(clips) - 1):
            left, right = clips[i], clips[i + 1]
            gap = right.timeline_start - left.timeline_end
            if gap > 0.05:
                continue
            join_src = left.source_end
            fade = 0
            for d in decs:
                if abs(d.end - join_src) < 0.08 or abs(d.start - join_src) < 0.08:
                    fade = max(fade, d.crossfade_ms)
            if fade <= 0:
                fade = recommend_cut_fade_ms(
                    project,
                    tid,
                    left.source_end,
                    right.source_start,
                    cut_kind="filler",
                    defaults=cfg,
                )
            track = project.track_by_id(tid)
            if track and track.role == TrackRole.DIALOGUE:
                max_ms = int(cfg.get("render", {}).get("join_fade_max_ms", 40))
                fade = min(fade, max_ms)
            left.fade_out_ms = max(left.fade_out_ms, fade)
            right.fade_in_ms = max(right.fade_in_ms, fade)
            right.join_in_mode = ClipJoinMode.FADE
            affected.add(tid)

    return {
        "operation": "apply_join_fades",
        "affected_tracks": sorted(affected),
        "clip_count": len(project.clips),
        "timeline_duration_sec": project.timeline.duration_sec,
    }


def list_edit_decisions(
    project: EpisodeProject,
    *,
    applied: bool | None = None,
    review_required: bool | None = None,
    reason_prefix: str | None = None,
) -> list[EditDecision]:
    out: list[EditDecision] = []
    for e in project.edit_decisions:
        if applied is not None and e.applied != applied:
            continue
        if review_required is not None and e.review_required != review_required:
            continue
        if reason_prefix and not (e.reason or "").startswith(reason_prefix):
            continue
        out.append(e)
    return out


def _join_time_after_ripple(project: EpisodeProject, near_sec: float) -> float:
    """Actual butt-join near ``near_sec`` after a ripple (handles float drift)."""
    best: float | None = None
    best_dist = float("inf")
    for tid in dialogue_track_ids(project):
        clips = clips_for_track(project, tid)
        for i in range(len(clips) - 1):
            left, right = clips[i], clips[i + 1]
            if abs(left.timeline_end - right.timeline_start) > 1e-3:
                continue
            dist = abs(left.timeline_end - near_sec)
            if dist < best_dist:
                best_dist = dist
                best = left.timeline_end
    return best if best is not None and best_dist < 0.1 else near_sec


def _apply_replace_gap_pad(project: EpisodeProject, edit: EditDecision, tl_start: float) -> None:
    gap = edit.replace_gap_sec
    if gap is None or gap <= 0:
        return
    if getattr(edit, "scope", "session") == "track":
        # Track-local punches already leave a hole; do not insert session pads.
        return
    at = _join_time_after_ripple(project, tl_start)
    if filler_pad_mode() == "room_tone":
        insert_room_tone_pad(project, at, gap)
    else:
        # Default: hard silence beat (dry rooms; avoid mismatched stolen air).
        insert_gap(project, at, gap)
    cfg = _tighten_cfg()
    defaults = _defaults_all()
    # Left edge: ripple often stamps a ~15ms fade-out while clips still abut,
    # then the pad opens a hole - that fade swallows consonant releases (N in
    # "mean"). Keep only a tiny declick into silence.
    pre_fade = int(cfg.get("filler_pre_pad_fade_out_ms", 5))
    for tid in dialogue_track_ids(project):
        for clip in clips_for_track(project, tid):
            if abs(clip.timeline_end - at) <= 0.05:
                clip.fade_out_ms = pre_fade
                clip.join_in_mode = ClipJoinMode.FADE
    # Right edge: fade length from resume-edge energy (quiet air → short;
    # late/hot onset → longer so the fade still covers the consonant).
    resume_at = at + gap
    for tid in dialogue_track_ids(project):
        for clip in clips_for_track(project, tid):
            if abs(clip.timeline_start - resume_at) <= 0.05:
                fade_ms = recommend_post_pad_fade_in_ms(
                    project,
                    tid,
                    clip.source_start,
                    defaults=defaults,
                )
                if fade_ms > 0:
                    clip.fade_in_ms = max(int(clip.fade_in_ms), fade_ms)
                    clip.join_in_mode = ClipJoinMode.FADE


def _apply_remove_edit(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    use_inaudible_opt: bool | None = False,
    record_log: bool = False,
) -> tuple[float, float, list[str], dict]:
    """Apply one REMOVE via session ripple or track-local punch."""
    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.speech_energy_guard import resolve_cut_scope

    tl_start, tl_end = _edit_to_timeline_range(project, edit)
    scope = getattr(edit, "scope", "session") or "session"
    if scope != "track":
        try:
            scope, _guard = resolve_cut_scope(
                project,
                edit.track_id,
                edit.start,
                edit.end,
                requested_scope=scope,
                defaults=load_defaults(),
            )
        except ValueError:
            # Explicit approve/apply: fall back to track-local rather than no-op.
            scope = "track"
        if scope == "track":
            edit.scope = "track"
            edit.replace_gap_sec = None

    if scope == "track":
        punch_delete(
            project,
            edit.track_id,
            tl_start,
            tl_end,
            use_inaudible_opt=use_inaudible_opt,
            record_log=record_log,
        )
        track_ids = [edit.track_id]
        per_track = _per_track_source_for_timeline(project, tl_start, tl_end)
    else:
        per_track = _per_track_source_for_timeline(project, tl_start, tl_end)
        track_ids = list(per_track.keys()) or dialogue_track_ids(project) or [edit.track_id]
        ripple_delete(
            project,
            tl_start,
            tl_end,
            use_inaudible_opt=use_inaudible_opt,
            record_log=record_log,
        )
        _apply_replace_gap_pad(project, edit, tl_start)
    return (
        tl_start,
        tl_end,
        track_ids,
        {
            "per_track_source": per_track,
            "replace_gap_sec": edit.replace_gap_sec,
            "scope": scope,
        },
    )


def _apply_mute_edit(
    project: EpisodeProject,
    edit: EditDecision,
) -> tuple[float, float, list[str], dict]:
    """Silence ``edit``'s source span in place; do not move clips."""
    tl_start, tl_end = _edit_to_timeline_range(project, edit)
    written = False
    for clip in clips_for_track(project, edit.track_id):
        if add_source_mute(clip, edit.start, edit.end):
            written = True
    track_ids = [edit.track_id] if written else []
    return (
        tl_start,
        tl_end,
        track_ids,
        {"scope": getattr(edit, "scope", "session") or "session", "mute": True},
    )


def approve_edits(project: EpisodeProject, ids: list[str]) -> int:
    id_set = set(ids)
    applied_ids: set[str] = set()
    to_apply = [e for e in project.edit_decisions if e.id in id_set]
    # Mutes first (timeline-stable). Later removes first so earlier positions
    # stay valid after ripple+pad. Splits run after removes.
    mutes = [e for e in to_apply if e.type == EditDecisionType.MUTE]
    removes = [e for e in to_apply if e.type == EditDecisionType.REMOVE]
    splits = [e for e in to_apply if e.type == EditDecisionType.SPLIT]
    for edit in sorted(mutes, key=lambda e: e.start, reverse=True):
        tl_start, tl_end, track_ids, params = _apply_mute_edit(project, edit)
        if not track_ids:
            continue
        archive_decision(
            project,
            edit,
            operation="approve_edits",
            timeline_start=tl_start,
            timeline_end=tl_end,
            track_ids=track_ids,
            params=params,
        )
        applied_ids.add(edit.id)
    for edit in sorted(removes, key=lambda e: e.start, reverse=True):
        tl_start, tl_end, track_ids, params = _apply_remove_edit(
            project, edit, use_inaudible_opt=False, record_log=False
        )
        if not track_ids:
            continue
        archive_decision(
            project,
            edit,
            operation="approve_edits",
            timeline_start=tl_start,
            timeline_end=tl_end,
            track_ids=track_ids,
            params=params,
        )
        applied_ids.add(edit.id)
    for edit in sorted(splits, key=lambda e: e.start, reverse=True):
        at_time = float(edit.start)
        tids = list(edit.track_ids) if edit.track_ids else [edit.track_id]
        report = split_clips_at(project, at_time, tids, record_log=False)
        archive_decision(
            project,
            edit,
            operation="approve_split",
            timeline_start=at_time,
            timeline_end=at_time,
            track_ids=list(report.get("affected_tracks") or tids),
            params={"at_time": at_time, "track_ids": tids},
        )
        applied_ids.add(edit.id)

    before = len(project.edit_decisions)
    project.edit_decisions = [e for e in project.edit_decisions if e.id not in applied_ids]
    return before - len(project.edit_decisions)


def reject_edits(project: EpisodeProject, ids: list[str]) -> int:
    kept, removed = reject_by_id(
        project.edit_decisions,
        ids,
        get_id=lambda e: e.id,
    )
    project.edit_decisions = kept
    return removed


def update_pending_edit(
    project: EpisodeProject,
    edit_id: str,
    *,
    start: float,
    end: float,
    snap: bool = True,
    track_ids: list[str] | None = None,
) -> EditDecision:
    """Update a pending edit decision's range; optionally inaudible-snap."""
    edit = next((e for e in project.edit_decisions if e.id == edit_id), None)
    if edit is None:
        raise KeyError(f"edit decision not found: {edit_id}")

    if edit.type == EditDecisionType.SPLIT:
        at_time = float(start)
        edit.start = at_time
        edit.end = at_time
        edit.timebase = "timeline"
        if track_ids is not None:
            edit.track_ids = list(track_ids)
            if track_ids:
                edit.track_id = track_ids[0]
        return edit

    if end <= start:
        raise ValueError("end must be after start")

    if snap:
        from podcast_mcp.edits.inaudible_cuts import optimize_source_cut_range

        opt = optimize_source_cut_range(project, edit.track_id, start, end)
        edit.start = opt.start
        edit.end = opt.end
        edit.boundary_mode = opt.mode
        edit.cut_confidence = opt.confidence
    else:
        edit.start = start
        edit.end = end
    return edit


def apply_prefix_edits(
    project: EpisodeProject,
    reason_prefix: str | tuple[str, ...],
    *,
    config_key: str,
) -> int:
    """Apply auto-approved REMOVE (ripple) or MUTE (in-place) edits for reason prefixes."""
    prefixes = (reason_prefix,) if isinstance(reason_prefix, str) else reason_prefix
    applied_decisions: list[EditDecision] = []
    for e in project.edit_decisions:
        if e.review_required or e.type not in (
            EditDecisionType.REMOVE,
            EditDecisionType.MUTE,
        ):
            continue
        reason = e.reason or ""
        if not reason.startswith(prefixes):
            continue
        tl_start, tl_end = _edit_to_timeline_range(project, e)
        if tl_end <= tl_start:
            continue
        applied_decisions.append(e)

    if not applied_decisions:
        return 0

    cfg_all = load_defaults()
    cfg = cfg_all.get(config_key, {})
    inaudible_opt = cfg.get("inaudible_opt", True)

    mutes = [e for e in applied_decisions if e.type == EditDecisionType.MUTE]
    removes = [e for e in applied_decisions if e.type == EditDecisionType.REMOVE]
    for edit in sorted(mutes, key=lambda e: e.start, reverse=True):
        tl_start, tl_end, track_ids, params = _apply_mute_edit(project, edit)
        if not track_ids:
            continue
        params = {**params, "config_key": config_key}
        archive_decision(
            project,
            edit,
            operation="apply_prefix_edits",
            timeline_start=tl_start,
            timeline_end=tl_end,
            track_ids=track_ids,
            params=params,
        )
    for edit in sorted(removes, key=lambda e: e.start, reverse=True):
        tl_start, tl_end, track_ids, params = _apply_remove_edit(
            project,
            edit,
            use_inaudible_opt=inaudible_opt,
            record_log=False,
        )
        if not track_ids:
            continue
        params = {**params, "config_key": config_key}
        archive_decision(
            project,
            edit,
            operation="apply_prefix_edits",
            timeline_start=tl_start,
            timeline_end=tl_end,
            track_ids=track_ids,
            params=params,
        )

    apply_join_fades_from_decisions(
        project,
        [e for e in applied_decisions if e.type == EditDecisionType.REMOVE],
        defaults=cfg_all,
    )
    id_set = {e.id for e in applied_decisions}
    before = len(project.edit_decisions)
    project.edit_decisions = [e for e in project.edit_decisions if e.id not in id_set]
    return before - len(project.edit_decisions)


def apply_auto_edits(project: EpisodeProject) -> int:
    """Apply filler/pause edits (ripple REMOVE or mute-in-place MUTE)."""
    return apply_prefix_edits(project, ("filler:", "pause:"), config_key="tighten")


def edit_impact_report(project: EpisodeProject) -> dict:
    by_track: dict[str, float] = {}
    pending = 0
    applied = 0
    segments: list[dict] = []
    clip_count = len(project.clips)
    timeline_end = 0.0
    gap_count = 0
    for clip in project.clips:
        timeline_end = max(timeline_end, clip.timeline_end)
    for tid in {t.id for t in project.tracks}:
        track_clips = clips_for_track(project, tid)
        for i in range(len(track_clips) - 1):
            gap = track_clips[i + 1].timeline_start - track_clips[i].timeline_end
            if gap > 0.05:
                gap_count += 1
    for e in project.edit_decisions:
        if e.type.value not in ("remove", "mute"):
            continue
        dur = max(0.0, e.end - e.start)
        if e.applied:
            applied += 1
            by_track[e.track_id] = by_track.get(e.track_id, 0.0) + dur
            segments.append(
                {
                    "id": e.id,
                    "track_id": e.track_id,
                    "start": e.start,
                    "end": e.end,
                    "duration_sec": dur,
                    "reason": e.reason,
                    "applied": True,
                    "review_required": e.review_required,
                }
            )
        elif e.review_required:
            pending += 1
            segments.append(
                {
                    "id": e.id,
                    "track_id": e.track_id,
                    "start": e.start,
                    "end": e.end,
                    "duration_sec": dur,
                    "reason": e.reason,
                    "applied": False,
                    "review_required": True,
                }
            )
    total_removed = sum(by_track.values())
    return {
        "total_removed_sec": total_removed,
        "by_track_sec": by_track,
        "applied_count": applied,
        "pending_review_count": pending,
        "segments": segments,
        "clip_count": clip_count,
        "timeline_duration_sec": timeline_end,
        "gap_count": gap_count,
    }


def format_edit_impact_markdown(report: dict) -> str:
    lines = [
        "# Edit impact",
        f"- Total removed (applied): **{report['total_removed_sec']:.1f}s**",
        f"- Applied cuts: {report['applied_count']}",
        f"- Pending review: {report['pending_review_count']}",
        "",
    ]
    for tid, sec in report.get("by_track_sec", {}).items():
        lines.append(f"- {tid}: {sec:.1f}s")
    if report.get("segments"):
        lines.append("\n## Segments\n")
        for s in report["segments"][:50]:
            flag = "pending" if s.get("review_required") else "applied"
            lines.append(
                f"- [{flag}] {s['track_id']} {s['start']:.1f}-{s['end']:.1f}s "
                f"({s['duration_sec']:.1f}s) {s.get('reason', '')}"
            )
    return "\n".join(lines)
