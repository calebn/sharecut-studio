"""Edge gating: waveform snap, join gates and peer-bleed checks for a cut."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from podcast_mcp.edits import cut_safety
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.breath_detect import (
    PauseAirSkip,
    pause_air_span,
)
from podcast_mcp.edits.cut_placement import CutRejected
from podcast_mcp.edits.cut_safety import ResolvedCutScope
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.session_air import SessionAir
from podcast_mcp.edits.tighten_reasons import (
    ACOUSTIC_FILLER_REASON,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    EpisodeProject,
)
from podcast_mcp.util.dsp import rms_db
from podcast_mcp.util.timebase import SourceSec

if TYPE_CHECKING:
    from podcast_mcp.edits.speech_energy_guard import SpeechEnergyGuardResult
    from podcast_mcp.engines.audio_audit import TrackRmsCacheSet
from podcast_mcp.edits.tighten.acoustic_scan import (
    _peer_audio_caches,
)
from podcast_mcp.edits.tighten.candidate import (
    _CutCandidate,
)
from podcast_mcp.edits.tighten.plan import (
    _accept_nudge,
    _between_kept_voices,
    _covered_kept_word,
    _cut_minimum_sec,
    _CutPlan,
    _shrink_to_next_onset,
    _start_at_filler_onset,
)
from podcast_mcp.edits.tighten.repeats import (
    _cut_covers_reparandum,
)

# Labels a pause trim that moved off the span pacing proposed (onto the air inside the
# pause); unlike the other edge flags it raises no review.
_AIR_EDGES_FLAG = "air_edges"


@dataclass(frozen=True)
class _GatedCut:
    """A cut that passed its edge checks: the plan with its final span."""

    plan: _CutPlan
    guard: SpeechEnergyGuardResult | None
    # Review flags the edge checks raised, in the order they go on the reason.
    flags: tuple[str, ...]
    # A pause trim: how long nobody speaks around it (``PauseAir.silence_sec``).
    heard_pause: float | None = None


def _cut_scope(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    peer_scoped: bool,
    defaults: dict[str, Any],
    caches: TrackRmsCacheSet | None = None,
    _admissible_spans: Sequence[tuple[float, float]] | None = None,
) -> ResolvedCutScope | CutRejected:
    if not peer_scoped:
        return ResolvedCutScope("intentional_track")
    from podcast_mcp.edits.cut_safety import CutScopeUnavailable, resolve_cut_scope

    resolved = resolve_cut_scope(
        project,
        track_id,
        start,
        end,
        defaults=defaults,
        caches=caches,
        _admissible_spans=_admissible_spans,
    )
    if isinstance(resolved, CutScopeUnavailable):
        return CutRejected("scope_unavailable")
    return resolved


def _gate_cut_edges(
    project: EpisodeProject,
    candidate: _CutCandidate,
    plan: _CutPlan,
    *,
    defaults: dict[str, Any],
    audio_cache: TrackAudioCache | None,
    audio_caches: Mapping[str, TrackAudioCache] | None,
    word_index: CutWordIndex | None,
    session_air: SessionAir | None,
    timeline_caches: TrackRmsCacheSet | None = None,
) -> _GatedCut | CutRejected:
    """Run the edge checks ``plan.checks`` selects, then read who speaks over the final span."""
    track_id = candidate.track_id
    checks = plan.checks
    paced = plan.start, plan.end
    # Every join starts a word filler at its voice, not its word time; acoustic runs
    # are bounded by audio already.
    if (
        audio_cache is not None
        and candidate.cut_kind == "filler"
        and not candidate.strictly_bounded
    ):
        started = _start_at_filler_onset(
            project, plan, candidate, audio_cache=audio_cache, defaults=defaults
        )
        if isinstance(started, CutRejected):
            return started
        plan = started
    if audio_cache is not None and candidate.cut_kind != "pause":
        between = _between_kept_voices(
            project, plan, candidate, audio_cache=audio_cache, defaults=defaults
        )
        if isinstance(between, CutRejected):
            return between
        plan = between
    if checks.end_before_next_onset and audio_cache is not None and candidate.cut_kind != "pause":
        shrunk = _shrink_to_next_onset(plan, candidate, audio_cache=audio_cache, defaults=defaults)
        if isinstance(shrunk, CutRejected):
            return shrunk
        plan = shrunk
    cut_start, cut_end = plan.start, plan.end
    voiced_flag: str | None = None
    if audio_cache is not None and candidate.cut_kind != "pause":
        voiced = cut_safety.assess_voiced_edges(
            cut_start,
            cut_end,
            audio_cache=audio_cache,
            word_index=word_index
            or CutWordIndex.from_transcript(
                project.transcript_for_source(track_id, None), track_id
            ),
            peer_caches=_peer_audio_caches(project, track_id, checks.peer_scoped, audio_caches),
            selected_start=candidate.start,
            selected_end=candidate.end,
            pause=candidate.cut_kind == "pause",
            accept_nudge=lambda before, start, end: _accept_nudge(candidate, before, start, end),
            end_in_valley=plan.end_in_valley,
        )
        cut_start, cut_end, voiced_flag = voiced.start, voiced.end, voiced.flag
    before_protection = cut_start, cut_end
    off_proposal = False
    heard_pause: float | None = None
    if candidate.cut_kind == "pause":
        # A pause trim removes only air: it shrinks to the longest stretch of air
        # inside it on every track the ripple cuts, so no edge sits in a sound. It is
        # reviewed or applied by the same risk checks as a filler (#1055); ``:air_edges``
        # only labels one that moved off the span pacing proposed.
        air = pause_air_span(
            project,
            track_id,
            cut_start,
            cut_end,
            defaults=defaults,
            audio_caches={
                **(audio_caches or {}),
                **({track_id: audio_cache} if audio_cache else {}),
            },
            session_air=session_air,
        )
        if isinstance(air, PauseAirSkip):
            return CutRejected(air.value)
        off_proposal = air.span != paced
        cut_start, cut_end = air.span
        heard_pause = air.silence_sec
        if audio_cache is not None:
            protected_plan = replace(plan, start=cut_start, end=cut_end)
            between = _between_kept_voices(
                project, protected_plan, candidate, audio_cache=audio_cache, defaults=defaults
            )
            if isinstance(between, CutRejected):
                return between
            if checks.end_before_next_onset:
                between = _shrink_to_next_onset(
                    between, candidate, audio_cache=audio_cache, defaults=defaults
                )
                if isinstance(between, CutRejected):
                    return between
            plan = between
            cut_start, cut_end = plan.start, plan.end
            settled = cut_safety.assess_voiced_edges(
                cut_start,
                cut_end,
                audio_cache=audio_cache,
                word_index=word_index
                or CutWordIndex.from_transcript(
                    project.transcript_for_source(track_id, None), track_id
                ),
                peer_caches=_peer_audio_caches(project, track_id, checks.peer_scoped, audio_caches),
                selected_start=candidate.start,
                selected_end=candidate.end,
                pause=candidate.cut_kind == "pause",
                accept_nudge=lambda before, start, end: _accept_nudge(
                    candidate, before, start, end
                ),
            )
            if (settled.start, settled.end) != (cut_start, cut_end):
                if bool(
                    defaults.get("tighten", {}).get("breath_handling", {}).get("enabled", True)
                ):
                    return CutRejected("unsettled_edges")
                cut_start, cut_end = settled.start, settled.end
            voiced_flag = settled.flag
    elif candidate.cut_kind != "pause":
        breath_safe = cut_safety.protect_cut_edges(
            project,
            track_id,
            cut_start,
            cut_end,
            join=plan.join,
            defaults=defaults,
            audio_cache=audio_cache,
            word_index=word_index,
        )
        if breath_safe is None:
            return CutRejected("breath")
        cut_start, cut_end = breath_safe
    protected = cut_start, cut_end
    acoustic = candidate.reason == ACOUSTIC_FILLER_REASON
    if cut_end - cut_start + 1e-9 < _cut_minimum_sec(candidate):
        return CutRejected("too_short")
    if candidate.cut_kind != "pause" and not _cut_covers_reparandum(candidate, cut_start, cut_end):
        return CutRejected("reparandum")
    if checks.keep_whole_words:
        covered = _covered_kept_word(project, candidate, cut_start, cut_end)
        if covered is not None:
            return CutRejected(f"kept_word:{covered}")
    if (
        checks.audible_only
        and audio_cache is not None
        and rms_db(
            audio_cache.window(cut_start, cut_end), floor_db=audio_cache.profile.voice_floor_db
        )
        < audio_cache.profile.voice_floor_db
    ):
        return CutRejected("inaudible")
    admissible_spans = None
    if checks.peer_scoped and candidate.cut_kind != "pause":
        span = SessionTimeline(project).exact_source_span(
            track_id, SourceSec(cut_start), SourceSec(cut_end)
        )
        if span is None:
            return CutRejected("source_geometry")
        admissible_spans = ((float(span[0]), float(span[1])),)
    try:
        resolved = _cut_scope(
            project,
            track_id,
            cut_start,
            cut_end,
            peer_scoped=checks.peer_scoped,
            defaults=defaults,
            caches=timeline_caches,
            _admissible_spans=admissible_spans,
        )
    except ValueError:
        return CutRejected("scope")
    if isinstance(resolved, CutRejected):
        return resolved
    guard = resolved.guard
    if candidate.cut_kind != "pause" and guard is not None and guard.action == "skip":
        return CutRejected("scope")
    plan = replace(plan, start=cut_start, end=cut_end)
    if audio_cache is not None and protected != before_protection and candidate.cut_kind != "pause":
        settled = cut_safety.assess_voiced_edges(
            cut_start,
            cut_end,
            audio_cache=audio_cache,
            word_index=word_index
            or CutWordIndex.from_transcript(
                project.transcript_for_source(track_id, None), track_id
            ),
            peer_caches=_peer_audio_caches(project, track_id, checks.peer_scoped, audio_caches),
            selected_start=candidate.start,
            selected_end=candidate.end,
            pause=candidate.cut_kind == "pause",
            accept_nudge=lambda before, start, end: _accept_nudge(candidate, before, start, end),
            end_in_valley=plan.end_in_valley,
        )
        if (settled.start, settled.end) != protected:
            return CutRejected("unsettled_edges")
        voiced_flag = settled.flag
    if checks.refuse_attached_runs and acoustic and voiced_flag == "voiced_edge":
        return CutRejected("voiced_edge")
    raised = (voiced_flag, _AIR_EDGES_FLAG if off_proposal else None)
    return _GatedCut(plan, guard, tuple(flag for flag in raised if flag), heard_pause)
