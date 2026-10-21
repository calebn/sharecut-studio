"""Per-candidate preparation, finishing and the analyze_candidates driver."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from podcast_mcp.edits import cut_placement, cut_policy, cut_safety
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.breath_detect import (
    PauseAirSkip,
    detect_adjacent_breath,
    extend_cut_for_breaths,
)
from podcast_mcp.edits.cut_placement import CutRejected
from podcast_mcp.edits.cut_proof import shared_timeline_rms_caches
from podcast_mcp.edits.cut_quality import (
    assess_cut_risk,
    optimize_and_assess,
    post_pad_fade_in_bounds_ms,
    recommend_cut_fade_ms,
)
from podcast_mcp.edits.filler_pacing import (
    apply_filler_pacing,
    pause_trim_is_imperceptible,
)
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.session_air import MeasuredPause, SessionAir
from podcast_mcp.edits.tighten_reasons import (
    LIKELY_LAUGH_FLAG,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    EpisodeProject,
)
from podcast_mcp.util.intervals import merge_intervals, subtract_intervals
from podcast_mcp.util.parallel import run_parallel
from podcast_mcp.util.timebase import SourceSec

if TYPE_CHECKING:
    from podcast_mcp.engines.audio_audit import TrackRmsCacheSet
from podcast_mcp.edits.join_continuity import JoinContinuityConfig
from podcast_mcp.edits.pause_floor import PeerTrackSpeechIndex, retained_pause_floor_sec
from podcast_mcp.edits.ripple import RippleRemoval, TrackExtent
from podcast_mcp.edits.tighten.candidate import (
    _AnalyzedCut,
    _clamp_to_candidate,
    _cut_span_is_bleed_not_owner,
    _CutCandidate,
    _edit_mode,
    _SpeakerCutContext,
)
from podcast_mcp.edits.tighten.gate import (
    _AIR_EDGES_FLAG,
    _cut_scope,
    _gate_cut_edges,
    _GatedCut,
)
from podcast_mcp.edits.tighten.plan import (
    _cut_minimum_sec,
    _CutPlan,
)
from podcast_mcp.edits.timeline_ops import LaneUnavailable, bind_pause_effects

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class _PreparedCut:
    candidate: _CutCandidate
    opt: Any
    jump_cache: dict[tuple[str, float], float | None]
    plan: _CutPlan
    scope: str
    reason: str
    review_required: bool
    heard_pause: float | None = None
    peer_observation_span: tuple[float, float] | None = None
    peers_speaking: bool = False


def _prepare_candidate(
    project: EpisodeProject,
    candidate: _CutCandidate,
    defaults: dict[str, Any],
    *,
    audio_cache: TrackAudioCache | None = None,
    speaker_context: _SpeakerCutContext | None = None,
    word_index: CutWordIndex | None = None,
    peer_indexes: dict[str, PeerTrackSpeechIndex] | None = None,
    audio_caches: Mapping[str, TrackAudioCache] | None = None,
    session_air: SessionAir | None = None,
    timeline_caches: TrackRmsCacheSet | None = None,
    force_enabled: bool | None = None,
    _retention_retry: bool = False,
) -> _PreparedCut | CutRejected:
    """Waveform-optimize, risk-assess and edge-check one candidate. Read-only w.r.t.
    project (no mutation) -- safe to call from multiple threads concurrently, as
    long as each call gets its own jump-measurement cache (below); audio_cache
    (one per track, decoded once) is read-only and safe to share across threads.
    ``audio_caches`` holds the other dialogue tracks' decodes for the voiced-speech
    check of a session ripple; a track absent from it is not checked. ``session_air``
    is the run's rooms and sounds, read once, for the air a pause trim reads on each
    track.
    """
    tighten = defaults.get("tighten", {})
    leave_in = bool(tighten.get("leave_in_if_risky", True))
    track_id = candidate.track_id
    # Fresh per-candidate cache: assess_cut_risk and recommend_cut_fade_ms both
    # measure the join jump at the same boundaries in the common case (no breath
    # extension moved them) -- share one measurement instead of taking it twice.
    jump_cache: dict[tuple[str, float], float | None] = {}
    opt, risk = optimize_and_assess(
        project,
        track_id,
        candidate.start,
        candidate.end,
        filler_confidence=candidate.filler_confidence,
        defaults=defaults,
        cache=jump_cache,
        audio_cache=audio_cache,
        word_index=word_index,
        force_enabled=force_enabled,
    )
    cut_start, cut_end = opt.start, opt.end
    if candidate.strictly_bounded:
        # Acoustic evidence is local to the inter-word gap; waveform snapping
        # must never expand it back onto an ASR word.
        snapped = _clamp_to_candidate(candidate, cut_start, cut_end)
        if snapped is None:
            return CutRejected("bounds")
        cut_start, cut_end = snapped

    breaths = detect_adjacent_breath(
        project,
        track_id,
        cut_start,
        cut_end,
        defaults=defaults,
        audio_cache=audio_cache,
        word_index=word_index,
    )
    extended = _clamp_to_candidate(candidate, *extend_cut_for_breaths(cut_start, cut_end, breaths))
    if extended is None:
        return CutRejected("bounds")
    cut_start, cut_end = extended

    if _cut_span_is_bleed_not_owner(
        project,
        track_id,
        cut_start,
        cut_end,
        speaker_context=speaker_context,
        word_index=word_index,
    ):
        return CutRejected("not_owner")

    mute_mode = _edit_mode(tighten) == "mute"
    paced = apply_filler_pacing(
        project,
        track_id,
        cut_start,
        cut_end,
        defaults=defaults,
        cut_kind=candidate.cut_kind,
        # Bounded candidates never widen onto the rest of the gap or get a pad,
        # so the pause left behind is never longer than the original.
        allow_gap_expand=not candidate.strictly_bounded,
        keeps_time=mute_mode,
    )
    if paced is None:
        return CutRejected("pacing")
    paced_span = _clamp_to_candidate(candidate, paced.start, paced.end)
    if paced_span is None:
        return CutRejected("bounds")
    cut_start, cut_end = paced_span
    try:
        resolved = _cut_scope(
            project,
            track_id,
            cut_start,
            cut_end,
            peer_scoped=not mute_mode,
            defaults=defaults,
            caches=timeline_caches,
        )
    except ValueError:
        return CutRejected("scope")
    if isinstance(resolved, CutRejected):
        return resolved
    # A ripple is a session cut whoever speaks over it: peer speech is a review flag the
    # person confirms at approval, never a narrower scope. Only a mute stays on its track.
    scope = "track" if mute_mode else "session"
    if candidate.cut_kind != "pause" and resolved.guard and resolved.guard.action == "skip":
        return CutRejected("scope")
    plan = _CutPlan.for_cut(
        cut_start, cut_end, mute=mute_mode, pad=paced.pad, reason=candidate.reason
    )
    gated = _gate_cut_edges(
        project,
        candidate,
        plan,
        defaults=defaults,
        audio_cache=audio_cache,
        audio_caches=audio_caches,
        word_index=word_index,
        session_air=session_air,
        timeline_caches=timeline_caches,
    )
    if not isinstance(gated, _GatedCut):
        return gated
    plan, guard, flags = gated.plan, gated.guard, gated.flags
    peer_observation_span = None
    if _clamp_to_candidate(candidate, plan.start, plan.end) != (plan.start, plan.end):
        return CutRejected("bounds")
    if candidate.cut_kind == "pause" and not mute_mode:
        words = cut_safety.pause_words(
            project, candidate.track_id, candidate.start, candidate.gap_end or candidate.end
        )
        if isinstance(words, CutRejected):
            return words
        before, after = words
        timeline = SessionTimeline(project)
        before_span = timeline.exact_source_span(
            track_id, SourceSec(before.start), SourceSec(before.end)
        )
        after_span = timeline.exact_source_span(
            track_id, SourceSec(after.start), SourceSec(after.end)
        )
        span = timeline.exact_source_span(track_id, SourceSec(plan.start), SourceSec(plan.end))
        if before_span is None or after_span is None or span is None:
            return CutRejected("source_geometry")
        air = session_air or SessionAir(
            project,
            audio_caches={
                **(audio_caches or {}),
                **({track_id: audio_cache} if audio_cache is not None else {}),
            },
        )
        splice_fade_ms = recommend_cut_fade_ms(
            project,
            track_id,
            plan.start,
            plan.end,
            cut_kind="pause",
            defaults=defaults,
            cache=jump_cache,
            audio_cache=audio_cache,
        )
        effect_reach = (
            max(
                splice_fade_ms,
                post_pad_fade_in_bounds_ms(defaults)[1],
                int(tighten.get("filler_pre_pad_fade_out_ms", 5)),
                max((max(c.fade_in_ms, c.fade_out_ms) for c in project.clips), default=0),
            )
            / 1000.0
        )
        acoustic = bool(tighten.get("breath_handling", {}).get("enabled", True))
        observation_span = (
            min(float(span[0]) - effect_reach, float(before_span[0])),
            max(float(span[1]) + effect_reach, float(after_span[1])),
        )
        observation = air.pause_observation(*observation_span, acoustic=acoustic)
        if isinstance(observation, PauseAirSkip):
            return CutRejected(observation.value)
        original = cut_placement.original_pause_support(project, track_id, words, observation)
        if isinstance(original, CutRejected):
            return original
        quiet = merge_intervals(
            (float(piece.source_start), float(piece.source_end)) for piece in original.pieces
        )
        retained = sum(hi - lo for lo, hi in subtract_intervals(quiet, [(plan.start, plan.end)]))
        floor, _solo = retained_pause_floor_sec(
            project, track_id, before.end, after.start, defaults, peer_indexes
        )
        shortfall = max(0.0, floor - retained)
        if shortfall > 1e-6:
            if _retention_retry or original.seconds < floor - 1e-6:
                return CutRejected("no_air")
            inside = [
                (max(lo, plan.start), min(hi, plan.end))
                for lo, hi in quiet
                if min(hi, plan.end) > max(lo, plan.start)
            ]

            def reserve(amount: float, *, right: bool) -> float | None:
                remaining = amount
                for lo, hi in reversed(inside) if right else inside:
                    if hi - lo >= remaining - 1e-6:
                        return hi - remaining if right else lo + remaining
                    remaining -= hi - lo
                return None

            trials = []
            if quiet:
                lo, hi = quiet[-1]
                preferred = hi - floor
                if lo <= preferred and plan.start < preferred < plan.end:
                    trials.append((plan.start, preferred))
            right = reserve(shortfall, right=True)
            left = reserve(shortfall, right=False)
            if right is not None:
                trials.append((plan.start, right))
            if left is not None:
                trials.append((left, plan.end))
            split_left = reserve(shortfall / 2, right=False)
            split_right = reserve(shortfall / 2, right=True)
            if split_left is not None and split_right is not None:
                trials.append((split_left, split_right))
            seen = set()
            for start, end in trials:
                if (
                    (start, end) in seen
                    or start < plan.start
                    or end > plan.end
                    or end - start <= _cut_minimum_sec(candidate)
                    or (start, end) == (plan.start, plan.end)
                ):
                    continue
                seen.add((start, end))
                preserved = replace(
                    candidate,
                    start=start,
                    end=end,
                    min_start=start,
                    max_end=end,
                    decision_id=candidate.hit_id,
                )
                retry = _prepare_candidate(
                    project,
                    preserved,
                    defaults,
                    audio_cache=audio_cache,
                    speaker_context=speaker_context,
                    word_index=word_index,
                    peer_indexes=peer_indexes,
                    audio_caches=audio_caches,
                    session_air=air,
                    timeline_caches=timeline_caches,
                    force_enabled=force_enabled,
                    _retention_retry=True,
                )
                if isinstance(retry, CutRejected):
                    continue
                finished = _finish_candidate(project, retry, defaults, audio_cache=audio_cache)
                if not isinstance(finished, CutRejected):
                    return replace(retry, candidate=candidate)
            return CutRejected("no_air")
        removal = RippleRemoval.of([TrackExtent(track_id, float(span[0]), float(span[1]))])
        loss = float(span[1] - span[0]) - (plan.replace_gap_sec or 0.0)
        heard = (
            gated.heard_pause
            or air.silence_around(float(span[0]), float(span[1]))
            or candidate.pause_sec
        )
        gated = replace(gated, heard_pause=heard)
        if loss <= 0:
            return CutRejected("pause_not_shorter")
        if heard is not None and pause_trim_is_imperceptible(loss, heard):
            return CutRejected("imperceptible")
        effects = bind_pause_effects(
            project,
            float(span[0]),
            removal,
            observation=observation,
            splice_fade_ms=splice_fade_ms,
            defaults=defaults,
        )
        if isinstance(effects, LaneUnavailable):
            return CutRejected("pause_effects", (effects,))
        plan = replace(plan, effects=effects)
        if isinstance(observation, MeasuredPause):
            final_span = timeline.exact_source_span(
                track_id, SourceSec(plan.start), SourceSec(plan.end)
            )
            if final_span is None or not (
                observation_span[0] <= final_span[0] < final_span[1] <= observation_span[1]
            ):
                return CutRejected("source_geometry")
            support = tuple(
                (float(start), float(end))
                for start, end in timeline.map_source_span(
                    track_id, SourceSec(plan.start), SourceSec(plan.end)
                )
            )
            try:
                resolved = _cut_scope(
                    project,
                    track_id,
                    plan.start,
                    plan.end,
                    peer_scoped=True,
                    defaults=defaults,
                    caches=timeline_caches,
                    _admissible_spans=support,
                )
            except ValueError:
                return CutRejected("scope")
            if isinstance(resolved, CutRejected):
                return resolved
            guard = resolved.guard
            gated = replace(gated, guard=guard)
            peer_observation_span = observation_span
    checks = plan.checks
    cut_start, cut_end = plan.start, plan.end
    if not checks.score_joins or (cut_start, cut_end) != (opt.start, opt.end):
        # Risk was measured on the optimized span, as a splice; re-assess the cut that ships.
        risk = assess_cut_risk(
            project,
            track_id,
            cut_start,
            cut_end,
            filler_confidence=candidate.filler_confidence,
            boundary_confidence=opt.confidence,
            defaults=defaults,
            cache=jump_cache,
            audio_cache=audio_cache,
            word_index=word_index,
            score_joins=checks.score_joins,
        )

    reason = candidate.reason
    if candidate.likely_laugh:
        reason = f"{reason}:{LIKELY_LAUGH_FLAG}"
    # Repetition/restart detection and acoustic-only gap fillers are
    # intentionally proposal-only.  Even an exact token repeat can be emphasis
    # ("very very"), a phrase restart can change meaning if the repair is
    # mistaken for the reparandum, and voiced energy in an ASR gap may be a
    # breath, laugh, or missed word rather than a filler.
    policy = cut_policy.sound_policy(candidate.reason, "mute" if mute_mode else "ripple")
    assert policy is not None
    review_required = candidate.review_only or policy.proposal_review
    if (gated.guard and gated.guard.blocked) or (not mute_mode and resolved.scope == "track"):
        review_required = True
    for flag in flags:
        review_required = review_required or flag != _AIR_EDGES_FLAG
        reason = f"{reason}:{flag}"
    if guard is not None and guard.blocked:
        peers = ",".join(guard.blocking_track_ids)
        review_required = True
        reason = f"{reason}:other_speaking:{peers}"

    if risk.too_risky:
        if leave_in:
            return CutRejected("risky")
        review_required = True
        reason = f"{reason}:risky"

    return _PreparedCut(
        candidate=candidate,
        opt=opt,
        jump_cache=jump_cache,
        plan=plan,
        scope=scope,
        reason=reason,
        review_required=review_required,
        heard_pause=gated.heard_pause,
        peer_observation_span=peer_observation_span,
        peers_speaking=bool(guard is not None and guard.blocked),
    )


def _finish_candidate(
    project: EpisodeProject,
    prepared: _PreparedCut,
    defaults: dict[str, Any],
    *,
    audio_cache: TrackAudioCache | None = None,
) -> _AnalyzedCut | CutRejected:
    """Score the join of a prepared cut and size its fade: the costly half of its analysis."""
    tighten = defaults.get("tighten", {})
    candidate, plan, opt = prepared.candidate, prepared.plan, prepared.opt
    track_id = candidate.track_id
    checks = plan.checks
    cut_start, cut_end = plan.start, plan.end
    reason, review_required = prepared.reason, prepared.review_required
    replace_gap = plan.replace_gap_sec
    if checks.score_joins and bool(tighten.get("join_continuity_gate", False)):
        try:
            jc_cfg = replace(
                JoinContinuityConfig.from_defaults(defaults),
                neural=False,
                calibrate=False,
            )
            jc = cut_safety.assess_proposed_cut(
                project,
                track_id,
                cut_start,
                cut_end,
                timebase="source",
                config=jc_cfg,
                defaults=defaults,
                audio_caches={track_id: audio_cache} if audio_cache is not None else None,
            )
            if jc.verdict == "fail":
                return CutRejected("join_continuity")
            if jc.verdict == "review":
                review_required = True
                reason = f"{reason}:join_review"
        except Exception as exc:
            log.debug("join continuity scoring skipped: %s", exc)
            if candidate.cut_kind == "pause":
                return CutRejected("join_continuity")

    mute = plan.join is cut_policy.CutJoin.MUTE
    if mute:
        # Approval fades the clip into the hole as a padded cut fades into its pad.
        fade_ms = int(tighten.get("filler_pre_pad_fade_out_ms", 5))
        replace_gap = None
    else:
        fade_ms = recommend_cut_fade_ms(
            project,
            track_id,
            cut_start,
            cut_end,
            cut_kind=candidate.cut_kind,
            defaults=defaults,
            cache=prepared.jump_cache,
            audio_cache=audio_cache,
        )
    return _AnalyzedCut(
        hit_id=candidate.hit_id,
        track_id=track_id,
        start=cut_start,
        end=cut_end,
        reason=reason,
        review_required=review_required,
        crossfade_ms=fade_ms,
        cut_confidence=opt.confidence,
        boundary_mode=opt.mode,
        replace_gap_sec=replace_gap,
        next_burst_sec=plan.next_burst,
        scope=prepared.scope,
        decision_type="mute" if mute else "remove",
        pause_sec=prepared.heard_pause,
        peers_speaking=prepared.peers_speaking,
    )


def _analyze_candidate(
    project: EpisodeProject,
    candidate: _CutCandidate,
    defaults: dict[str, Any],
    *,
    audio_cache: TrackAudioCache | None = None,
    speaker_context: _SpeakerCutContext | None = None,
    word_index: CutWordIndex | None = None,
    peer_indexes: dict[str, PeerTrackSpeechIndex] | None = None,
    audio_caches: Mapping[str, TrackAudioCache] | None = None,
    session_air: SessionAir | None = None,
    timeline_caches: TrackRmsCacheSet | None = None,
) -> _AnalyzedCut | CutRejected:
    prepared = _prepare_candidate(
        project,
        candidate,
        defaults,
        audio_cache=audio_cache,
        speaker_context=speaker_context,
        word_index=word_index,
        peer_indexes=peer_indexes,
        audio_caches=audio_caches,
        session_air=session_air,
        timeline_caches=timeline_caches,
    )
    if isinstance(prepared, CutRejected):
        return prepared
    return _finish_candidate(project, prepared, defaults, audio_cache=audio_cache)


def analyze_candidates(
    project: EpisodeProject,
    candidates: list[_CutCandidate],
    defaults: dict[str, Any],
    *,
    audio_caches: Mapping[str, TrackAudioCache],
    speaker_context: _SpeakerCutContext | None,
    peer_indexes: dict[str, PeerTrackSpeechIndex] | None,
    word_indexes: Mapping[str, CutWordIndex],
    max_workers: int | None = None,
) -> list[_AnalyzedCut | CutRejected]:
    """Analyze ``candidates`` in parallel, results in candidate order.

    Duplicate pause trims are dropped after the proposals have been resolved against each
    other (:func:`_resolve_analyzed_cuts`), so a trim whose twin does not survive is not
    lost with it.
    """
    session_air = SessionAir(project, audio_caches=audio_caches, word_indexes=word_indexes)
    timeline_caches = shared_timeline_rms_caches(project, defaults=defaults)

    def analyze(candidate: _CutCandidate) -> _AnalyzedCut | CutRejected:
        prepared = _prepare_candidate(
            project,
            candidate,
            defaults,
            audio_cache=audio_caches.get(candidate.track_id),
            speaker_context=speaker_context,
            word_index=word_indexes.get(candidate.track_id),
            peer_indexes=peer_indexes,
            audio_caches=audio_caches,
            session_air=session_air,
            timeline_caches=timeline_caches,
        )
        if isinstance(prepared, CutRejected):
            return prepared
        return _finish_candidate(
            project, prepared, defaults, audio_cache=audio_caches.get(candidate.track_id)
        )

    return run_parallel(candidates, analyze, max_workers=max_workers)
