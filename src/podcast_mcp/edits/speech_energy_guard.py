"""Cross-track speech-energy guard for cut proposals and apply.

Transcript-guided cuts miss unlabeled words. Before session-wide ripple, check
whether another dialogue stem is audibly speaking in the mapped window and
either skip, force review, or convert to a track-local punch (silence hole,
no peer ripple).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    TrackRmsCacheSet,
    measure_timeline_rms_db,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.timebase import SourceSec
from podcast_mcp.util.tracks import dialogue_track_ids

log = logging.getLogger(__name__)

ConflictAction = Literal["track_local", "skip", "review"]


@dataclass(frozen=True)
class SpeechEnergyGuardResult:
    """Outcome of checking other tracks over a proposed source cut."""

    blocking_track_ids: tuple[str, ...]
    action: ConflictAction | None
    """None when the cut is safe for session ripple."""

    cut_rms_db: float | None = None
    other_rms_db: dict[str, float] = field(default_factory=dict)

    @property
    def blocked(self) -> bool:
        return bool(self.blocking_track_ids)


def _guard_cfg(defaults: dict[str, Any] | None) -> dict[str, Any]:
    cfg = defaults if defaults is not None else load_defaults()
    return dict((cfg.get("tighten") or {}).get("speech_energy_guard") or {})


def speech_energy_guard_enabled(defaults: dict[str, Any] | None = None) -> bool:
    return bool(_guard_cfg(defaults).get("enabled", True))


def speech_energy_on_conflict(defaults: dict[str, Any] | None = None) -> ConflictAction:
    raw = str(_guard_cfg(defaults).get("on_conflict", "track_local")).strip().lower()
    if raw in ("skip", "review", "track_local"):
        return raw  # type: ignore[return-value]
    return "track_local"


def assess_cross_track_speech(
    project: EpisodeProject,
    cut_track_id: str,
    src_start: float,
    src_end: float,
    *,
    defaults: dict[str, Any] | None = None,
    caches: TrackRmsCacheSet | None = None,
) -> SpeechEnergyGuardResult:
    """Return tracks that are speaking over the cut's mapped timeline window."""
    if src_end <= src_start or not speech_energy_guard_enabled(defaults):
        return SpeechEnergyGuardResult(blocking_track_ids=(), action=None)

    cfg = _guard_cfg(defaults)
    policy = AnalysisPolicy.from_defaults(defaults)
    min_other = float(cfg.get("min_other_rms_db", policy.audibility_rms_db))
    dominance = float(cfg.get("dominance_db", 3.0))
    min_overlap = float(cfg.get("min_overlap_sec", 0.03))

    spans = SessionTimeline(project).map_source_span(
        cut_track_id, SourceSec(src_start), SourceSec(src_end)
    )
    if not spans:
        return SpeechEnergyGuardResult(blocking_track_ids=(), action=None)

    tl_start, tl_end = max(spans, key=lambda s: s[1] - s[0])
    if tl_end - tl_start < min_overlap:
        return SpeechEnergyGuardResult(blocking_track_ids=(), action=None)

    cut_rms = measure_timeline_rms_db(project, cut_track_id, tl_start, tl_end, caches=caches)
    other_rms: dict[str, float] = {}
    blocking: list[str] = []
    for tid in dialogue_track_ids(project):
        if tid == cut_track_id:
            continue
        rms = measure_timeline_rms_db(project, tid, tl_start, tl_end, caches=caches)
        if rms is None:
            continue
        other_rms[tid] = rms
        if rms < min_other:
            continue
        # Cut track owns the moment (other is quieter bleed) → allow session ripple.
        if cut_rms is not None and cut_rms - rms >= dominance:
            continue
        blocking.append(tid)

    if not blocking:
        return SpeechEnergyGuardResult(
            blocking_track_ids=(),
            action=None,
            cut_rms_db=cut_rms,
            other_rms_db=other_rms,
        )
    return SpeechEnergyGuardResult(
        blocking_track_ids=tuple(blocking),
        action=speech_energy_on_conflict(defaults),
        cut_rms_db=cut_rms,
        other_rms_db=other_rms,
    )


def resolve_cut_scope(
    project: EpisodeProject,
    cut_track_id: str,
    src_start: float,
    src_end: float,
    *,
    requested_scope: str = "session",
    defaults: dict[str, Any] | None = None,
    caches: TrackRmsCacheSet | None = None,
) -> tuple[str, SpeechEnergyGuardResult | None]:
    """Return ``(scope, guard)`` with scope ``session`` or ``track``.

    Raises ``ValueError`` when ``on_conflict`` is ``skip`` and peers are speaking.
    """
    if requested_scope == "track":
        return "track", None

    try:
        from podcast_mcp.engines.speaker_id import (
            assess_speaker_cut_role,
            load_all_profiles,
        )
        from podcast_mcp.transcript_context import load_transcript_context

        if load_all_profiles(project):
            ctx = load_transcript_context(project.workspace_path())
            speaker = assess_speaker_cut_role(
                project,
                cut_track_id,
                src_start,
                src_end,
                ctx.speaker_id,
            )
            if speaker and speaker.get("role") == "bleed":
                return "track", None
    except Exception as exc:
        log.debug("speaker cut scope guard skipped: %s", exc, exc_info=True)

    guard = assess_cross_track_speech(
        project,
        cut_track_id,
        src_start,
        src_end,
        defaults=defaults,
        caches=caches,
    )
    if not guard.blocked:
        return "session", guard
    if guard.action == "skip":
        peers = ", ".join(guard.blocking_track_ids)
        raise ValueError(
            f"cut blocked: other track(s) speaking in window ({peers}); "
            "leave in or use a track-local punch"
        )
    # track_local and review: never session-ripple over live peer speech.
    return "track", guard
