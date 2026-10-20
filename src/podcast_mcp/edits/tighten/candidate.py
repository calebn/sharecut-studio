"""Shared candidate/result types for the tighten analysis."""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.models import (
    EpisodeProject,
    TranscriptWord,
)
from podcast_mcp.util.tracks import dialogue_track_ids

if TYPE_CHECKING:
    pass

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class _SpeakerCutContext:
    config: Any
    profiles: dict[str, Any]


def _speaker_cut_context(project: EpisodeProject) -> _SpeakerCutContext | None:
    """Take one profile/config snapshot before candidate analysis starts."""
    try:
        from podcast_mcp.engines.speaker_id import load_all_profiles
        from podcast_mcp.project.transcript_context import load_transcript_context

        profiles = load_all_profiles(project)
        if not profiles:
            return _SpeakerCutContext(None, {})
        config = load_transcript_context(project.workspace_path()).speaker_id
        return _SpeakerCutContext(config, profiles)
    except Exception as exc:
        log.debug("speaker bleed cut guard skipped: %s", exc, exc_info=True)
        return _SpeakerCutContext(None, {})


def _word_indexes(
    project: EpisodeProject, candidates: Sequence[_CutCandidate]
) -> dict[str, CutWordIndex]:
    """One word index per track the candidates are on or a session ripple cuts, built once.

    A pause trim reads the room of every dialogue track, so each is indexed once per
    proposal run and shared, never rebuilt per decision. No candidates, no indexes.
    """
    if not candidates:
        return {}
    track_ids = dict.fromkeys([*(c.track_id for c in candidates), *dialogue_track_ids(project)])
    return {
        track_id: CutWordIndex.from_transcript(
            project.transcript_for_source(track_id, None), track_id
        )
        for track_id in track_ids
    }


def _word_not_owner(word: TranscriptWord, track_id: str) -> bool:
    """True when ``word`` is bleed or speaker-matched to another track."""
    if word.audibility_status == "bleed":
        return True
    return bool(word.speaker_match_track and word.speaker_match_track != track_id)


def _cut_span_is_bleed_not_owner(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    speaker_context: _SpeakerCutContext | None = None,
    word_index: CutWordIndex | None = None,
) -> bool:
    if word_index is not None:
        if word_index.has_bleed_overlap(start, end):
            return True
    else:
        tr = project.transcript_for_source(track_id, None)
        if tr:
            for w in tr.words:
                if w.end <= start or w.start >= end:
                    continue
                if _word_not_owner(w, track_id):
                    return True
    try:
        from podcast_mcp.engines.speaker_id import assess_speaker_cut_role

        context = speaker_context if speaker_context is not None else _speaker_cut_context(project)
        if context is None or not context.profiles:
            return False
        role = assess_speaker_cut_role(
            project, track_id, start, end, context.config, profiles=context.profiles
        )
        return bool(role and role.get("role") == "bleed")
    except Exception as exc:
        log.debug("speaker bleed cut guard skipped: %s", exc, exc_info=True)
        return False


def _count_skip(skip_counts: dict[str, int] | None, reason: str) -> None:
    if skip_counts is None:
        return
    skip_counts[reason] = skip_counts.get(reason, 0) + 1


def normalize_edit_mode(raw: Any) -> str:
    mode = str(raw or "ripple").strip().lower()
    return mode if mode in ("ripple", "mute") else "ripple"


def _edit_mode(tighten: dict[str, Any]) -> str:
    return normalize_edit_mode(tighten.get("edit_mode"))


@dataclass(frozen=True)
class _CutCandidate:
    """A filler/pause span worth analyzing, before waveform/risk analysis runs."""

    track_id: str
    start: float
    end: float
    reason: str
    cut_kind: str
    filler_confidence: float | None = None
    # Pause cuts: hard ceiling so trailing-energy / breath cannot eat the retain floor.
    max_end: float | None = None
    # Strictly bounded candidates (acoustic gap runs; repetition/restart word
    # spans): hard floor so waveform snapping, breath extension, and pacing
    # never move the cut off the identified span onto a neighboring word; such
    # candidates also skip gap expansion during pacing.
    min_start: float | None = None
    # Proposal-only regardless of risk (never auto-applied).
    review_only: bool = False
    # An acoustic run whose level rises and falls like a laugh (``edits/acoustic_laugh.py``).
    likely_laugh: bool = False
    # Pause candidates: the next word's onset. The pause is the whole word gap;
    # ``end`` is only where the retain floor trims it.
    gap_end: float | None = None
    # Pause candidates: how long the pause plays on the timeline.
    pause_sec: float | None = None
    decision_id: str | None = None

    @property
    def strictly_bounded(self) -> bool:
        return self.min_start is not None

    @property
    def hit_id(self) -> str:
        """The id of every decision proposed for this hit, on every run (#999).

        A hit is its track, its kind and the source material it targets: the
        filler, repeated or restarted words, the acoustic run, or a pause's whole
        word gap. Analysis output (cut edges, review flags, the pause's trim end)
        is not identity, so re-proposal hands an unchanged hit its id back and
        Ask threads linked to it keep resolving. Same-kind hits on one track
        never share a span, so distinct hits never share an id.
        """
        if self.decision_id is not None:
            return self.decision_id
        end = self.end if self.gap_end is None else self.gap_end
        track = hashlib.sha256(self.track_id.encode()).hexdigest()[:10]
        return f"cut_{self.cut_kind}_{round(self.start * 1000)}_{round(end * 1000)}_{track}"


def _candidate_order(candidate: _CutCandidate) -> tuple[float, float, str]:
    return (candidate.start, candidate.end, candidate.reason)


def _clamp_to_candidate(
    candidate: _CutCandidate, start: float, end: float
) -> tuple[float, float] | None:
    """Clamp a cut to the candidate's hard bounds; ``None`` when nothing is left."""
    if candidate.min_start is not None:
        start = max(start, candidate.min_start)
    if candidate.max_end is not None:
        end = min(end, candidate.max_end)
    if end <= start:
        return None
    return start, end


@dataclass(frozen=True)
class _AnalyzedCut:
    """Result of analyzing one candidate -- everything needed to append a decision.

    Produced by the read-only, parallelizable _analyze_candidate; applying it
    (mutating project.edit_decisions) is a separate, serial step so callers can
    gather many of these concurrently and apply them afterward in a fixed order.
    """

    hit_id: str
    track_id: str
    start: float
    end: float
    reason: str
    review_required: bool
    crossfade_ms: int
    cut_confidence: float
    boundary_mode: str
    replace_gap_sec: float | None = None
    next_burst_sec: float | None = None
    scope: str = "session"
    decision_type: str = "remove"
    # A pause trim: how long nobody speaks around it, the pause a listener hears shorten.
    pause_sec: float | None = None
    # Another track speaks over the cut, so approving the ripple asks to confirm it.
    peers_speaking: bool = False
