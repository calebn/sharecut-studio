from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any

from podcast_mcp.engines.play_audit import (
    STEM_DURATION_TOLERANCE_SEC,
    expected_stem_duration_sec,
    probe_stem_duration_sec,
    stem_is_fresh,
    write_stem_hash,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.transcript_gated_play import gate_stem_window, word_intervals
from podcast_mcp.models import EpisodeProject, TrackRole
from podcast_mcp.util.progress import ProgressReporter, resolve_progress_task
from podcast_mcp.util.tracks import dialogue_track_ids

log = logging.getLogger(__name__)


def _stem_path(project: EpisodeProject, track_id: str) -> Path | None:
    p = project.artifacts_dir() / "tracks" / f"{track_id}.wav"
    return p if p.is_file() else None


def _track_duration(project: EpisodeProject, track_id: str) -> float:
    """Timeline-clock duration of the track (stems are rendered on this clock)."""
    extent = SessionTimeline(project).timeline_extent(track_id)
    if extent is not None:
        return float(extent[0])
    track = project.track_by_id(track_id)
    if track and track.media and track.media.duration_sec:
        return float(track.media.duration_sec)
    return 0.0


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
    Gate dialogue stems to non-suppressed word intervals (mute bleed acoustically).
    Requires fresh timeline-length stems under artifacts/tracks/. Sets
    ``track.transcript_gate`` so history/undo and segment play re-apply the gate.
    Optional ``start_sec``/``end_sec`` limit the muted window (rest of stem unchanged).
    Transcript word metadata is unchanged.
    """
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

                intervals = word_intervals(project, tid, win_start, win_end)
                try:
                    from podcast_mcp.engines.speaker_id import (
                        extend_intervals_with_speaker_gaps,
                        load_all_profiles,
                    )
                    from podcast_mcp.transcript_context import load_transcript_context

                    if load_all_profiles(project):
                        ctx = load_transcript_context(project.workspace_path())
                        intervals = extend_intervals_with_speaker_gaps(
                            project, tid, intervals, ctx.speaker_id
                        )
                except Exception as exc:
                    log.debug("speaker gap extension skipped: %s", exc, exc_info=True)
                    speaker_errors.append(f"{tid}: {exc}")
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
                }
                candidates.append(entry)

                if not dry_run:
                    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                        tmp_path = Path(tmp.name)
                    try:
                        gate_stem_window(
                            stem,
                            intervals,
                            tmp_path,
                            duration_sec=dur,
                            win_start=win_start,
                            win_end=win_end,
                        )
                        tmp_path.replace(stem)
                    finally:
                        if tmp_path.is_file():
                            tmp_path.unlink(missing_ok=True)
                    # Gate must not grow the stem past the timeline (wrong-clock pad).
                    after = probe_stem_duration_sec(project, tid)
                    if after is None or after > dur + STEM_DURATION_TOLERANCE_SEC:
                        skipped.append(
                            {
                                "track_id": tid,
                                "reason": "duration_mismatch_after_gate",
                                "expected_duration_sec": dur,
                                "stem_duration_sec": after,
                            }
                        )
                        continue
                    track.transcript_gate = True
                    write_stem_hash(project, tid)
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
