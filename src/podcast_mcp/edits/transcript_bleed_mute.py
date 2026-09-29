from __future__ import annotations

import functools
import tempfile
from pathlib import Path
from typing import Any

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.bleed_gate import (
    BleedGatePlan,
    build_bleed_gate_plan,
    gate_scope_for_window,
    merge_gate_scopes,
)
from podcast_mcp.engines.play_audit import (
    STEM_DURATION_TOLERANCE_SEC,
    expected_stem_duration_sec,
    probe_stem_duration_sec,
    probe_wav_duration_sec,
    publish_stem,
    stem_is_fresh,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.engines.transcript_gated_play import gate_stem_window, word_intervals
from podcast_mcp.models import EpisodeProject, TrackRole
from podcast_mcp.util.progress import ProgressReporter, resolve_progress_task
from podcast_mcp.util.project_state import render_lock_held
from podcast_mcp.util.tracks import dialogue_track_ids, existing_stem_path


def _stem_path(project: EpisodeProject, track_id: str) -> Path | None:
    return existing_stem_path(project, track_id)


def _track_duration(project: EpisodeProject, track_id: str) -> float:
    """Timeline-clock duration of the track (stems are rendered on this clock)."""
    extent = SessionTimeline(project).timeline_extent(track_id)
    if extent is not None:
        return float(extent[0])
    track = project.track_by_id(track_id)
    if track and track.media and track.media.duration_sec:
        return float(track.media.duration_sec)
    return 0.0


class _GateGrewStemError(Exception):
    """The gated render came out longer than the timeline; it is never published."""

    def __init__(self, duration_sec: float | None) -> None:
        super().__init__(f"gated stem is {duration_sec} s")
        self.duration_sec = duration_sec


def _gate_into(
    tmp: Path,
    *,
    stem: Path,
    intervals: list[tuple[float, float]],
    duration_sec: float,
    win_start: float,
    win_end: float,
    plan: BleedGatePlan,
) -> None:
    """Gate ``stem`` into ``tmp``; reject a render longer than the timeline before the swap."""
    gate_stem_window(
        stem,
        intervals,
        tmp,
        duration_sec=duration_sec,
        win_start=win_start,
        win_end=win_end,
        plan=plan,
    )
    # Gate must not grow the stem past the timeline (wrong-clock pad).
    after = probe_wav_duration_sec(tmp)
    if after is None or after > duration_sec + STEM_DURATION_TOLERANCE_SEC:
        raise _GateGrewStemError(after)


def apply_transcript_bleed_mute(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    dry_run: bool = True,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    """
    Attenuate verified foreign copies while protecting owner and uncertain audio.
    Requires fresh timeline-length stems under artifacts/tracks/. Sets
    ``track.transcript_gate`` and source scope so history and renders reproduce the gate.
    Optional ``start_sec``/``end_sec`` select source audio through its current placement.
    Transcript word metadata is unchanged.
    With ``dry_run=False`` the caller must hold ``render_lock(project)``, taken before the
    project locks (``EditService.apply_bleed_mute`` does); a gated render longer than the
    timeline is rejected before the swap, keeping the old stem and hash.
    """
    if not dry_run and not render_lock_held(project):
        raise RuntimeError(
            "apply_transcript_bleed_mute(dry_run=False) rewrites stems: hold "
            "render_lock(project) before the project locks (#482)"
        )
    targets = [track_id] if track_id else dialogue_track_ids(project)
    targets = [tid for tid in targets if project.track_by_id(tid)]

    candidates: list[dict[str, Any]] = []
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    speaker_errors: list[str] = []

    with resolve_progress_task(
        "bleed-mute",
        "Apply transcript gate",
        total=len(targets) or None,
        prefer_parent=True,
        progress=progress,
    ) as task:
        for tid in targets:
            try:
                track = project.track_by_id(tid)
                if not track or track.role != TrackRole.DIALOGUE:
                    continue
                stem = _stem_path(project, tid)
                if stem is None:
                    skipped.append({"track_id": tid, "reason": "missing_stem"})
                    continue

                expected = expected_stem_duration_sec(project, tid)
                actual = probe_stem_duration_sec(project, tid)
                if not stem_is_fresh(project, tid):
                    skipped.append(
                        {
                            "track_id": tid,
                            "reason": "stem_not_fresh",
                            "expected_duration_sec": expected,
                            "stem_duration_sec": actual,
                        }
                    )
                    continue

                # Timeline-clock stem length (never pad to a longer source-length file).
                stem_dur = actual if actual is not None else _track_duration(project, tid)
                timeline_dur = _track_duration(project, tid)
                dur = min(stem_dur, timeline_dur) if timeline_dur > 0 else stem_dur
                win_start = start_sec if start_sec is not None else 0.0
                win_end = end_sec if end_sec is not None else dur
                if win_end <= win_start:
                    continue

                plan = build_bleed_gate_plan(project, tid, ignore_scope=True)
                intervals = word_intervals(project, tid, win_start, win_end)
                tr = project.transcript_for_track(tid)
                word_count = len(tr.words) if tr else 0
                suppressed = sum(1 for w in tr.words if w.suppressed) if tr else 0
                entry = {
                    "track_id": tid,
                    "stem_path": str(stem),
                    "window_start": win_start,
                    "window_end": win_end,
                    "interval_count": len(intervals),
                    "word_count": word_count,
                    "suppressed_words": suppressed,
                    "duration_sec": dur,
                    "attenuation_count": len(plan.attenuation_spans),
                    "gate_reasons": list(plan.reasons),
                }
                candidates.append(entry)

                if not dry_run:
                    was_gated = track.transcript_gate
                    previous_scope = track.transcript_gate_scope
                    scope = gate_scope_for_window(project, tid, win_start, min(win_end, dur))
                    full_scope = start_sec is None and end_sec is None
                    track.transcript_gate_scope = (
                        None
                        if full_scope or (was_gated and previous_scope is None)
                        else merge_gate_scopes((previous_scope or []) + scope)
                    )
                    track.transcript_gate = True
                    try:
                        with tempfile.TemporaryDirectory(dir=stem.parent) as temporary:
                            ungated_project = project.model_copy(deep=True)
                            ungated_track = ungated_project.track_by_id(tid)
                            assert ungated_track is not None
                            ungated_track.transcript_gate = False
                            ungated = Path(temporary) / "ungated.wav"
                            render_track_from_timeline(
                                ungated_project, ungated_track, ungated, load_defaults()
                            )
                            scoped_plan = build_bleed_gate_plan(project, tid)
                            publish_stem(
                                project,
                                tid,
                                functools.partial(
                                    _gate_into,
                                    stem=ungated,
                                    intervals=list(scoped_plan.attenuation_spans),
                                    duration_sec=dur,
                                    win_start=0.0,
                                    win_end=dur,
                                    plan=scoped_plan,
                                ),
                            )
                    except _GateGrewStemError as exc:
                        track.transcript_gate = was_gated
                        track.transcript_gate_scope = previous_scope
                        skipped.append(
                            {
                                "track_id": tid,
                                "reason": "duration_mismatch_after_gate",
                                "expected_duration_sec": dur,
                                "stem_duration_sec": exc.duration_sec,
                            }
                        )
                        continue
                    except BaseException:
                        track.transcript_gate = was_gated
                        track.transcript_gate_scope = previous_scope
                        raise
                    applied.append(entry)
            finally:
                task.advance(1, total=len(targets))

        task.message(f"{len(applied)} tracks gated")

    return {
        "dry_run": dry_run,
        "candidate_count": len(candidates),
        "candidates": candidates,
        "applied_count": len(applied),
        "applied": applied,
        "skipped": skipped,
        "speaker_errors": speaker_errors or None,
    }
