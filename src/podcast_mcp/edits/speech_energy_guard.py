"""Cross-track speech-energy guard for cut proposals and apply.

Transcript-guided cuts miss unlabeled words. Before session-wide ripple, check
whether another dialogue stem is audibly speaking in the mapped window and
either skip, force review, or convert to a track-local punch (silence hole,
no peer ripple). :func:`measure_peer_speech` is the own-sound evidence the
ripple speech guard (``edits/cut_speech.py``) shares, and
:func:`word_voice_sounds_in` tells it whether a word's voice reaches into a cut.
"""

from __future__ import annotations

import logging
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.join_speech import JoinSpeechConfig
from podcast_mcp.edits.voiced_runs import FRAME_SEC, HOP_SEC
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    TrackRmsCacheSet,
    measure_timeline_rms_db,
    timeline_frame_levels_db,
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


@dataclass(frozen=True)
class PeerSpeechLevels:
    """Own-sound evidence over timeline spans: which peer tracks are speaking there."""

    owner_rms_db: float | None
    peer_rms_db: dict[str, float]
    speaking: tuple[str, ...]


def measure_peer_speech(
    project: EpisodeProject,
    timeline_spans: Sequence[tuple[float, float]],
    *,
    owner_track_ids: Collection[str],
    peer_track_ids: Iterable[str],
    defaults: dict[str, Any] | None = None,
    caches: TrackRmsCacheSet | None = None,
) -> PeerSpeechLevels | None:
    """Peers whose own sound is speech in a span: at audible level, not owner bleed.

    A peer counts when its level reaches ``min_other_rms_db`` and the loudest owner
    track is not ``dominance_db`` louder there (then the peer only carries the owner's
    voice as bleed). ``None`` when no span is at least ``min_overlap_sec`` long.
    """
    cfg = _guard_cfg(defaults)
    policy = AnalysisPolicy.from_defaults(defaults)
    min_other = float(cfg.get("min_other_rms_db", policy.audibility_rms_db))
    dominance = float(cfg.get("dominance_db", 3.0))
    min_overlap = float(cfg.get("min_overlap_sec", 0.03))
    checked = [(s, e) for s, e in timeline_spans if e - s >= min_overlap]
    if not checked:
        return None

    span_owner_rms = [
        max(
            (
                r
                for r in (
                    measure_timeline_rms_db(project, tid, s, e, caches=caches)
                    for tid in owner_track_ids
                )
                if r is not None
            ),
            default=None,
        )
        for s, e in checked
    ]
    owner_rms = max((r for r in span_owner_rms if r is not None), default=None)

    peer_rms: dict[str, float] = {}
    speaking: list[str] = []
    for tid in peer_track_ids:
        if tid in owner_track_ids:
            continue
        speaks = False
        for (tl_start, tl_end), span_owner in zip(checked, span_owner_rms, strict=True):
            rms = measure_timeline_rms_db(project, tid, tl_start, tl_end, caches=caches)
            if rms is None:
                continue
            if tid not in peer_rms or rms > peer_rms[tid]:
                peer_rms[tid] = rms
            if rms < min_other:
                continue
            # The owner holds the moment (the peer is quieter bleed).
            if span_owner is not None and span_owner - rms >= dominance:
                continue
            speaks = True
        if speaks:
            speaking.append(tid)
    return PeerSpeechLevels(owner_rms_db=owner_rms, peer_rms_db=peer_rms, speaking=tuple(speaking))


def word_voice_sounds_in(
    project: EpisodeProject,
    track_id: str,
    word_span: tuple[float, float],
    span: tuple[float, float],
) -> bool:
    """Whether a word's own voice on ``track_id`` sounds inside timeline ``span``.

    ASR stretches a word's span over the silence beside its voice, so the span alone
    does not show that ``span`` holds any of it. The word's loudest frame on its own
    track is its voice level, and a frame of ``span`` is that voice when it sits within
    the speech range of that level (``JoinSpeechConfig.speech_dynamic_db``). Another
    speaker's bleed on this mic is not discounted: it is no louder than the word's own
    quiet start or end, so telling them apart would hide real speech, and a false
    positive only asks. Frames are the tighten grid (``voiced_runs.FRAME_SEC`` every
    ``HOP_SEC``). Audio that cannot be read counts as voice, so a missing file never
    hides speech.
    """

    def levels(start: float, end: float) -> np.ndarray | None:
        return timeline_frame_levels_db(
            project, track_id, start, end, frame_sec=FRAME_SEC, hop_sec=HOP_SEC
        )

    word = levels(*word_span)
    inside = levels(*span)
    if word is None or inside is None:
        return True
    return bool((inside >= float(word.max()) - JoinSpeechConfig().speech_dynamic_db).any())


def guard_min_overlap_sec(defaults: dict[str, Any] | None = None) -> float:
    """Shortest overlap with a removed span that counts as cutting speech."""
    return float(_guard_cfg(defaults).get("min_overlap_sec", 0.03))


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

    spans = SessionTimeline(project).map_source_span(
        cut_track_id, SourceSec(src_start), SourceSec(src_end)
    )
    # A track-local hole inside the gap splits it into several mapped spans;
    # peer speech in any span at or above min_overlap can block, not just the
    # largest one (#793).
    levels = measure_peer_speech(
        project,
        spans,
        owner_track_ids=(cut_track_id,),
        peer_track_ids=dialogue_track_ids(project),
        defaults=defaults,
        caches=caches,
    )
    if levels is None:
        return SpeechEnergyGuardResult(blocking_track_ids=(), action=None)
    if not levels.speaking:
        return SpeechEnergyGuardResult(
            blocking_track_ids=(),
            action=None,
            cut_rms_db=levels.owner_rms_db,
            other_rms_db=levels.peer_rms_db,
        )
    return SpeechEnergyGuardResult(
        blocking_track_ids=levels.speaking,
        action=speech_energy_on_conflict(defaults),
        cut_rms_db=levels.owner_rms_db,
        other_rms_db=levels.peer_rms_db,
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
