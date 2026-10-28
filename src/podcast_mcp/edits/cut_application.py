from __future__ import annotations

import copy
import math
import subprocess
from collections.abc import Callable, Iterable, Mapping, Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from typing import Any, TypeVar, cast

from pydantic import BaseModel

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits import (
    cut_effects,
    cut_placement,
    cut_policy,
    cut_safety,
    suggested_actions,
    verdict_cache,
)
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.audio_check_override import is_human_intent
from podcast_mcp.edits.cut_placement import CutScopeHold, pending_pad_source_spans
from podcast_mcp.edits.cut_proof import (
    BatchBase,
    CarriedTimelineRms,
    RebuiltTimelineRms,
    TimelineRms,
    shared_source_audio_caches,
    shared_timeline_rms_caches,
)
from podcast_mcp.edits.cut_quality import recommend_cut_fade_ms, recommend_post_pad_fade_in_ms
from podcast_mcp.edits.cut_speech import (
    CutSpeechConfirmation,
    SourceExtent,
    UnconfirmedCutSpeech,
    assess_cut_speech,
    confirmation_for,
    cut_speech_params,
    merge_cut_speech,
)
from podcast_mcp.edits.decisions import (
    AskedEdits,
    HeldEdit,
    _near,
    _near_on_timeline,
    _source_extents,
    _speaker_name,
    edit_timeline_range,
    pre_pad_fade_out_ms,
    reject_edits,
    unplayed_pending_ids,
)
from podcast_mcp.edits.edit_log import archive_decision
from podcast_mcp.edits.filler_pacing import filler_pad_mode
from podcast_mcp.edits.join_modes import cap_fade_ms
from podcast_mcp.edits.ripple import RippleRemoval, TrimPlan, ripple_track_ids
from podcast_mcp.edits.source_removals import (
    STALE_REASON,
    ScopeChangedAtApproval,
    cut_label,
    record_suggested_cut_speech,
)
from podcast_mcp.edits.suggested_actions import SuggestedActionsResult, record_sound_action
from podcast_mcp.edits.timeline_ops import (
    _write_punch_delete,
    _write_punch_delete_clips,
    _write_punch_delete_range,
    _write_ripple_delete,
    _write_ripple_delete_clips,
    _write_trim_clip_edge,
    insert_bound_room_tone_pad,
    insert_gap,
    mute_room_tone_fill,
    room_tone_pad,
    split_clips_at,
)
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet
from podcast_mcp.engines.clips_ops import (
    abutting_pairs,
    clip_split_origin,
    clips_for_track,
    punch_timeline_range_from_clips,
    set_track_clips,
)
from podcast_mcp.engines.mute_regions import add_source_mute
from podcast_mcp.engines.off_speaker_regions import MuteOwnership, add_off_speaker_mute
from podcast_mcp.engines.session_timeline import (
    clip_timeline_overlap_to_source,
)
from podcast_mcp.engines.timeline_render import timeline_duration_sec
from podcast_mcp.engines.track_media import full_span_clip
from podcast_mcp.engines.transcript_sync import rebuild_combined
from podcast_mcp.engines.windowed_rms import WindowMiss
from podcast_mcp.models import (
    MUTE_FADE_MS,
    Clip,
    ClipJoinMode,
    ClipMuteRegion,
    ClipOffSpeakerMuteRegion,
    CutIntent,
    CutSpeech,
    EditDecision,
    EditDecisionType,
    EditMode,
    EpisodeProject,
)
from podcast_mcp.models.episode import (
    EditorialSection,
    ExactRangeTarget,
    ProjectMeta,
    RangeInterval,
    ReviewSection,
    TimelineSection,
    TranscriptsSection,
)
from podcast_mcp.project import merge as project_merge
from podcast_mcp.project.merge import adopt_project_state
from podcast_mcp.util.batch_scope import batch_scope, frozen_state, unscoped
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.intervals import subtract_intervals
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.util.process import CalledProcessError
from podcast_mcp.util.timebase import TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids

_PAD_EDGE_MATCH_SEC = 0.05
LOWER_GAIN_DB = -12.0
LOWER_FADE_MS = 20


def _completed_holds(
    before: EpisodeProject,
    candidate: EpisodeProject,
    ids: frozenset[str],
    *,
    defaults: dict,
    manual_ids: frozenset[str] = frozenset(),
    pauses: Mapping[str, cut_safety.HeldPause | cut_placement.CutRejected | None] | None = None,
    contributors_by_clip: Mapping[str, frozenset[str]] | None = None,
    join: cut_policy.CutJoin | None = None,
    observation: cut_safety.SourceCutObservations | None = None,
    pads: Sequence[cut_effects.PadEffect] = (),
    peers: cut_safety.PeerObservations | None = None,
    owned: bool = True,
    exact_ranges: Mapping[str, ExactRangeTarget] | None = None,
    mode: cut_policy.CutMode | None = None,
    measured: cut_safety.MeasuredSources | None = None,
) -> list[cut_placement.CutScopeHold]:
    placement = [
        hold
        for edit_id in sorted(ids)
        if (
            hold := cut_safety.complete_effect_placement(
                before, candidate, edit_id, observation, pads, (exact_ranges or {}).get(edit_id)
            )
        )
        is not None
    ]
    if placement:
        placement = cut_safety.apply_safety_actions(
            before, placement, manual_ids=manual_ids, mode=mode
        )
        if placement:
            return placement
    if peers is not None:
        peer = cut_safety._peer_policy(
            peers, edit_id=next(iter(ids)), manual=ids <= manual_ids, owned=owned
        )
        edit = next((item for item in before.edit_decisions if item.id in ids), None)
        peer_mode = mode or (cut_policy.edit_time_behavior(edit) if edit is not None else "ripple")
        if isinstance(peer, CutSpeechConfirmation):
            policy = cut_policy.action_for_safety_observation("peer_speech", peer_mode)
            if policy.action == "review":
                raise UnconfirmedCutSpeech(peer)
        elif peer is not None:
            peer_holds = cut_safety.apply_safety_actions(
                before, [peer], manual_ids=manual_ids, mode=peer_mode
            )
            if peer_holds:
                return peer_holds
    if ids <= manual_ids:
        return []
    unavailable: frozenset[str] = frozenset()
    try:
        effects = cut_effects.completed_audio_effects(
            before,
            candidate,
            ids,
            defaults=defaults,
            contributors_by_clip=contributors_by_clip,
            introduced_clips=frozenset(clip_id for pad in pads for clip_id in pad.clip_ids),
        )
    except cut_placement.DuplicateSourceOccurrence:
        return cut_safety.apply_safety_actions(
            before,
            [cut_placement.CutScopeHold(edit_id, (), "source_geometry") for edit_id in ids],
            manual_ids=manual_ids,
            mode=mode,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        verdict_cache.mark_unstable()
        effects = ()
        unavailable = ids
    return cut_safety.apply_safety_actions(
        before,
        cut_safety.complete_effect_acoustics(
            before,
            effects,
            defaults=defaults,
            manual_ids=manual_ids,
            pauses=pauses,
            join=join,
            unavailable=unavailable,
            measured=measured,
        ),
        manual_ids=manual_ids,
        mode=mode,
    )


def _checked_trim(
    project: EpisodeProject,
    plan: TrimPlan,
    *,
    application_intent: CutIntent,
    defaults: EffectiveConfig,
) -> tuple[EpisodeProject, dict, list[CutScopeHold]]:
    """The project with ``plan`` applied, the change report, and what the audio checks hold."""
    candidate = project.model_copy(deep=True)
    speech = assess_cut_speech(project, plan.removal, defaults=defaults) if plan.removal else None
    report = _write_trim_clip_edge(candidate, plan, cut_speech=speech, defaults=defaults)
    ids = frozenset({plan.clip_id})
    held = _completed_holds(
        project,
        candidate,
        ids,
        defaults=defaults,
        peers=cut_safety.PeerObservations(None, speech),
        owned=bool(plan.removal and plan.removal.selected),
        manual_ids=ids if is_human_intent(application_intent) else frozenset(),
        mode="ripple" if plan.mode is EditMode.RIPPLE else "mute",
    )
    if held:
        return candidate, report, held
    receipts = cut_effects.complete_effect_receipts(
        project, candidate, operation_ids=ids, trim=plan
    )
    return candidate, report, list(receipts)


@batch_scope()
def trim_holds(
    project: EpisodeProject,
    plan: TrimPlan,
    *,
    application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    defaults: EffectiveConfig,
) -> list[CutScopeHold]:
    """What ``apply_trim`` would refuse ``plan`` for; the project is not changed."""
    return _checked_trim(project, plan, application_intent=application_intent, defaults=defaults)[2]


@batch_scope()
def apply_trim(
    project: EpisodeProject,
    plan: TrimPlan,
    *,
    application_intent: CutIntent,
    defaults: EffectiveConfig,
) -> dict:
    candidate, report, held = _checked_trim(
        project, plan, application_intent=application_intent, defaults=defaults
    )
    if held:
        raise ScopeChangedAtApproval(held, {})
    adopt_project_state(project, candidate)
    return report


@dataclass(frozen=True)
class TimelineCut:
    removal: RippleRemoval
    mode: EditMode
    clip_ids: tuple[str, ...] = ()


@batch_scope()
def apply_timeline_cut(
    project: EpisodeProject,
    request: TimelineCut,
    *,
    application_intent: CutIntent,
    params: dict,
    defaults: EffectiveConfig,
) -> dict:
    candidate = project.model_copy(deep=True)
    speech = (
        assess_cut_speech(project, request.removal, defaults=defaults)
        if request.mode is EditMode.RIPPLE
        else None
    )
    if request.mode is EditMode.RIPPLE:
        report = (
            _write_ripple_delete_clips(
                candidate,
                list(request.clip_ids),
                request.removal,
                cut_speech=speech,
                defaults=defaults,
            )
            if request.clip_ids
            else _write_ripple_delete(
                candidate, request.removal, cut_speech=speech, params=params, defaults=defaults
            )
        )
    elif request.clip_ids:
        report = _write_punch_delete_clips(candidate, list(request.clip_ids), defaults=defaults)
    else:
        start, end = request.removal.spans[0]
        report = _write_punch_delete_range(
            candidate, start, end, list(request.removal.edited_track_ids), defaults=defaults
        )
    ids = frozenset({"timeline_cut"})
    held = _completed_holds(
        project,
        candidate,
        ids,
        defaults=defaults,
        peers=cut_safety.PeerObservations(None, speech),
        owned=bool(request.removal.selected),
        manual_ids=ids if is_human_intent(application_intent) else frozenset(),
        mode="ripple" if request.mode is EditMode.RIPPLE else "mute",
    )
    if held:
        raise ScopeChangedAtApproval(held, {})
    receipts = cut_effects.complete_effect_receipts(
        project, candidate, operation_ids=ids, removal=request.removal, clip_ids=request.clip_ids
    )
    if receipts:
        raise ScopeChangedAtApproval(receipts, {})
    adopt_project_state(project, candidate)
    return report


def _nearest_ripple_join_time(project: EpisodeProject, near_sec: float) -> float:
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


def _apply_replace_gap_pad(
    project: EpisodeProject,
    edit: EditDecision,
    tl_start: float,
    *,
    exact_seam: bool = False,
    source_audio_caches: Mapping[str, TrackAudioCache] | None = None,
    effects: list[cut_effects.PadEffect],
    defaults: EffectiveConfig,
) -> list[dict]:
    gap = edit.replace_gap_sec
    if gap is None or gap <= 0:
        return []
    if getattr(edit, "scope", "session") == "track":
        return []
    pad_start_sec = (
        tl_start
        if exact_seam or (edit.reason or "").startswith("pause:")
        else _nearest_ripple_join_time(project, tl_start)
    )
    if filler_pad_mode(defaults=defaults) == "room_tone":
        plan = room_tone_pad(
            project,
            pad_start_sec,
            gap,
            avoid=pending_pad_source_spans(project, edit),
            defaults=defaults,
        )
        before_ids = {clip.id for clip in project.clips}
        report = insert_bound_room_tone_pad(project, plan, defaults=defaults)
        effect = cut_effects.PadEffect(
            edit.id,
            plan,
            frozenset(clip.id for clip in project.clips if clip.id not in before_ids),
        )
        effects.append(effect)
        cut_effects.native_pad_origins().update((clip_id, effect) for clip_id in effect.clip_ids)
        samples = report["pad_samples"]
    else:
        insert_gap(project, pad_start_sec, gap, defaults=defaults)
        samples = []
    left_pad_fade_out_ms = pre_pad_fade_out_ms(defaults)
    for tid in dialogue_track_ids(project):
        for clip in clips_for_track(project, tid):
            if abs(clip.timeline_end - pad_start_sec) <= _PAD_EDGE_MATCH_SEC:
                clip.fade_out_ms = left_pad_fade_out_ms
    right_pad_edge_sec = pad_start_sec + gap
    for tid in dialogue_track_ids(project):
        for clip in clips_for_track(project, tid):
            if abs(clip.timeline_start - right_pad_edge_sec) <= _PAD_EDGE_MATCH_SEC:
                cache = (source_audio_caches or {}).get(tid)
                right_pad_fade_in_ms = recommend_post_pad_fade_in_ms(
                    project,
                    tid,
                    clip.source_start,
                    next_burst_sec=edit.next_burst_sec,
                    defaults=defaults,
                    audio_cache=cache,
                )
                if right_pad_fade_in_ms > 0:
                    clip.fade_in_ms = max(int(clip.fade_in_ms), right_pad_fade_in_ms)
                    clip.join_in_mode = ClipJoinMode.FADE
    return samples


_M = TypeVar("_M", bound=BaseModel)


def _replaced(model: _M, **fields: Any) -> _M:
    """A shallow copy with ``fields`` swapped in, leaving ``model_fields_set`` as it was.

    ``model_copy(update=...)`` marks every updated field as set, which changes
    ``exclude_unset`` dumps; a deep copy does not.
    """
    copied = model.model_copy()
    copied.__dict__.update(fields)
    return copied


def _shared(section: Any) -> Any:
    return section


def _meta_copy(meta: ProjectMeta) -> ProjectMeta:
    alignment = meta.ingest_alignment
    return _replaced(meta, ingest_alignment=None if alignment is None else dict(alignment))


def _timeline_copy(timeline: TimelineSection) -> TimelineSection:
    return _replaced(
        timeline, tracks=copy.deepcopy(timeline.tracks), clips=copy.deepcopy(timeline.clips)
    )


def _editorial_copy(editorial: EditorialSection) -> EditorialSection:
    return _replaced(
        editorial,
        # shallow copies: _apply_auto_removes rewrites the decisions it applied after the cut
        edit_decisions=[decision.model_copy() for decision in editorial.edit_decisions],
        edit_log=list(editorial.edit_log),
        chapters=list(editorial.chapters),
    )


def _transcripts_copy(section: TranscriptsSection) -> TranscriptsSection:
    return _replaced(
        section,
        per_track=[
            _replaced(
                transcript,
                words=copy.copy(transcript.words),
                archived_words=list(transcript.archived_words),
            )
            for transcript in section.per_track
        ],
    )


def _review_copy(review: ReviewSection) -> ReviewSection:
    return _replaced(review, comments=list(review.comments))


# Every project field needs a row; tests/test_cut_copy.py checks the table against the model.
_SECTION_COPIES: Mapping[str, Callable[[Any], Any]] = {
    "version": _shared,
    "meta": _meta_copy,  # a manual clip's split adds ingest_alignment entries
    "sources": _shared,
    "timeline": _timeline_copy,  # clips and tracks are edited in place
    "editorial": _editorial_copy,  # edit_log appends, chapters are replaced
    "transcript_data": _transcripts_copy,  # words are replaced, archived words appended
    "mix": _shared,
    "render": _shared,
    "social": _shared,
    "review": _review_copy,  # comments are replaced; versions are never written
    "history": _shared,
    "document_sync": _shared,
}


def _cut_copy(project: EpisodeProject) -> EpisodeProject:
    """A private copy of ``project`` for one cut that copies only what a cut writes.

    Sections a cut never writes, and the word and archive-entry objects (a cut archives
    and rebuilds words but never changes one), are shared with ``project``.
    """
    return _replaced(
        project,
        **{
            name: _SECTION_COPIES[name](getattr(project, name))
            for name in type(project).model_fields
        },
    )


_Decided = (
    tuple[EpisodeProject, tuple[float, float, list[str], dict]]
    | CutSpeechConfirmation
    | CutScopeHold
)


def _apply_source_remove(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    defaults: EffectiveConfig,
    application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    batch: Sequence[SourceExtent],
    record_log: bool = False,
    override_peer_holds: set[str] | None = None,
    measured: cut_safety.MeasuredSources | None = None,
    timeline: TimelineRms | None = None,
) -> _Decided:
    """Assess and write an ordinary source removal against current playback.

    Trusted human application intent can override acoustic peer evidence;
    ``override_peer_holds`` records those overrides for the caller's summary.
    Measurements share frozen state only until the first mutation. ``measured`` carries
    held-source measurements between cuts while ``project`` stays the same object.
    This writer completes every source, pad and edge write before policy can publish the copy.
    With the verdict cache on (#1958), a cut whose neighbourhood was already checked reuses
    that check; see ``verdict_cache``.
    """

    manual = is_human_intent(application_intent) or is_human_intent(edit.boundary_intent)
    key = entry = None
    placed = cut_safety.source_cut_placement(project, edit)
    stamp = _base_profile_stamp(project, timeline, defaults) if verdict_cache.enabled() else None
    if stamp is not None:
        key = verdict_cache.verdict_key(
            project,
            edit,
            defaults=defaults,
            manual=manual,
            batch=batch,
            span=placed[1],
            base_profile=stamp,
        )
        entry = verdict_cache.lookup(key)
        if entry is not None and not verdict_cache.verifying():
            if entry.outcome is not None:
                return entry.outcome
            reused = _check_source_remove(
                project,
                edit,
                defaults=defaults,
                manual=manual,
                batch=batch,
                record_log=record_log,
                override_peer_holds=override_peer_holds,
                measured=measured,
                timeline=timeline,
                placed=placed,
                key=key,
                cached=entry,
            )
            if reused is not None:
                return reused
            entry = None
    decided = _check_source_remove(
        project,
        edit,
        defaults=defaults,
        manual=manual,
        batch=batch,
        record_log=record_log,
        override_peer_holds=override_peer_holds,
        measured=measured,
        timeline=timeline,
        placed=placed,
        key=key,
        cached=None,
        verify=entry,
    )
    return cast(_Decided, decided)  # only a reused check can return None


def _base_profile_stamp(
    project: EpisodeProject, timeline: TimelineRms | None, defaults: EffectiveConfig
) -> str | None:
    """The batch-base profile digest a check's verdict key carries; ``None`` if not measurable.

    Every batch (approve, the idle warm, the auto-apply) asks its own ``BatchBase``; a check
    with no batch is a batch of one, whose base is ``project`` itself. The stamp runs the
    whole-track build on a path that may then reuse a stored verdict, so it tolerates what that
    build tolerates for a track (``audio_audit``: ``OSError``, ``CalledProcessError``,
    ``NoAudioDecodedError``, ``ValueError``) and what a key tolerates (``KeyError``). With no key
    the check runs in full, and meets any other failure of the build where it always did.
    """
    base = timeline.base if timeline is not None else BatchBase(project)
    try:
        return base.stamp(defaults=defaults)
    except (OSError, ValueError, KeyError, CalledProcessError, NoAudioDecodedError):
        return None


def _observe(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    defaults: EffectiveConfig,
    manual: bool,
    batch: Sequence[SourceExtent],
    audio_caches: dict[str, TrackAudioCache],
    timeline: TimelineRms | None,
    placed: tuple[CutScopeHold | None, tuple[TimelineSec, TimelineSec]],
) -> cut_safety.SourceCutObservations:
    """Observe the cut on the timeline caches ``timeline`` gives it, else on the project's own.

    A check on a windowed cache that reads outside its window (a word longer than the margin)
    is made again on caches built whole, never answered from a hole (#2357).
    """

    def observe(timeline_caches: TrackRmsCacheSet) -> cut_safety.SourceCutObservations:
        return cut_safety.observe_source_cut(
            project,
            edit,
            defaults=defaults,
            manual=manual,
            batch=batch,
            audio_caches=audio_caches,
            timeline_caches=timeline_caches,
            placed=placed,
        )

    if timeline is None:
        return observe(shared_timeline_rms_caches(project, defaults=defaults))
    reach = verdict_cache.check_reach_sec(project, edit, placed[1], defaults)
    try:
        return observe(timeline.caches_for(project, placed[1], reach=reach, defaults=defaults))
    except WindowMiss:
        return observe(timeline.whole(project, defaults=defaults))


def precompute_verdicts(
    project: EpisodeProject,
    ids: Iterable[str],
    *,
    defaults: EffectiveConfig,
    application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    yield_to_approval: bool = False,
) -> int:
    """Check each pending source remove of ``ids`` now so a later approval can reuse the check.

    With ``yield_to_approval`` (the idle warm) it stops as soon as an approval is running: the
    checks already made stay cached and the approval does the rest rather than duplicating them.

    Nothing in ``project`` changes; every cut is checked on a copy, as ``approve_edits`` does.
    Returns how many cuts were checked; 0 while the verdict cache is off.
    """

    if not verdict_cache.enabled():
        return 0
    wanted = set(ids)
    removes = [
        e
        for e in project.edit_decisions
        if e.id in wanted
        and not e.applied
        and e.type == EditDecisionType.REMOVE
        and e.exact_range is None
        and e.timebase == "source"
    ]
    batch = _source_extents(removes)
    working = _cut_copy(project)
    measured: cut_safety.MeasuredSources = {}
    timeline = CarriedTimelineRms(working)
    checked = 0
    # Its own scope, never the caller's: what a check parks there (a consumed room-tone bed,
    # pad origins) belongs to one batch and must not leak from a trial into the real one.
    with unscoped(), batch_scope():
        # In approval order, each cut on the project as the earlier ones left it, so the
        # neighbourhood a check sees (and so its key) is the one the approval will see.
        for edit in sorted(removes, key=lambda e: e.start, reverse=True):
            if yield_to_approval and verdict_cache.approval_running():
                break
            checked += 1
            applied = _apply_source_remove(
                working,
                edit,
                defaults=defaults,
                application_intent=application_intent,
                batch=tuple(batch.values()),
                measured=measured,
                timeline=timeline,
            )
            if isinstance(applied, (CutSpeechConfirmation, CutScopeHold)):
                batch.pop(edit.id)  # held: the approval drops it from the batch too
                continue
            working = applied[0]
            measured.clear()
            timeline.applied(applied[1][0])
    return checked


def _check_source_remove(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    defaults: EffectiveConfig,
    manual: bool,
    batch: Sequence[SourceExtent],
    record_log: bool,
    override_peer_holds: set[str] | None,
    measured: cut_safety.MeasuredSources | None,
    timeline: TimelineRms | None,
    placed: tuple[CutScopeHold | None, tuple[TimelineSec, TimelineSec]],
    key: str | None,
    cached: verdict_cache.CachedVerdict | None,
    verify: verdict_cache.CachedVerdict | None = None,
) -> (
    tuple[EpisodeProject, tuple[float, float, list[str], dict]]
    | CutSpeechConfirmation
    | CutScopeHold
    | None
):
    """One full check and write; with ``cached``, reuse its observation and skip the check.

    Returns ``None`` only for a reused check whose written cut differs from the recorded one.
    """

    candidate = _cut_copy(project)
    pads: list[cut_effects.PadEffect] = []
    with verdict_cache.recording() as marks, ExitStack() as proof:
        proof.enter_context(frozen_state())
        caches = shared_source_audio_caches(project)
        observation = (
            cached.observation
            if cached is not None
            else _observe(
                project,
                edit,
                defaults=defaults,
                manual=manual,
                batch=batch,
                audio_caches=caches,
                timeline=timeline,
                placed=placed,
            )
        )
        pause = observation.pause if isinstance(observation.pause, cut_safety.HeldPause) else None
        actual = (
            edit.model_copy(update={"replace_gap_sec": None})
            if (edit.reason or "").startswith("pause:") and not manual
            else edit
        )
        result = _write_source_remove(
            candidate,
            edit,
            proof=proof,
            actual=actual,
            span=observation.span,
            prepared_pause=pause,
            removal=observation.removal,
            speech=observation.peers.removed,
            source_audio_caches=caches,
            record_log=record_log,
            pads=pads,
            defaults=defaults,
        )
        written = verdict_cache.written_digest(result)
        padded = verdict_cache.pads_digest(pads)
        if cached is not None and (written, padded) != (cached.written, cached.pads):
            return None
        outcome: CutSpeechConfirmation | CutScopeHold | None = None
        if cached is None:
            ids = frozenset({edit.id})
            try:
                held = _completed_holds(
                    project,
                    candidate,
                    ids,
                    defaults=defaults,
                    manual_ids=ids if manual else frozenset(),
                    pauses={edit.id: observation.pause},
                    join=cut_policy.CutJoin.PADDED
                    if actual.replace_gap_sec
                    else cut_policy.CutJoin.SPLICE,
                    observation=observation,
                    pads=pads,
                    peers=observation.peers,
                    owned=observation.removal is not None and bool(observation.removal.selected),
                    measured=measured,
                )
            except UnconfirmedCutSpeech as asked:
                outcome = asked.confirmation
            else:
                outcome = held[0] if held else None
    if cached is None:
        if verify is not None:
            fresh = verdict_cache.written_digest((outcome, observation))
            known = verdict_cache.written_digest((verify.outcome, verify.observation))
            if (fresh, written, padded) != (known, verify.written, verify.pads):
                raise AssertionError(f"verdict cache entry differs from a full check ({edit.id})")
        verdict_cache.store(
            key, verdict_cache.CachedVerdict(observation, outcome, written, padded), marks
        )
    if outcome is not None:
        return outcome
    if (
        manual
        and override_peer_holds is not None
        and isinstance(observation.peers.mapped, cut_safety.ResolvedCutScope)
        and observation.peers.mapped.cause in {"peer_speech", "speaker_bleed"}
    ):
        override_peer_holds.add(edit.id)
    return candidate, result


def _write_source_remove(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    proof: ExitStack,
    actual: EditDecision,
    span: tuple[TimelineSec, TimelineSec],
    prepared_pause: cut_safety.HeldPause | None,
    removal: RippleRemoval | None,
    speech: CutSpeech | None,
    source_audio_caches: Mapping[str, TrackAudioCache],
    record_log: bool,
    pads: list[cut_effects.PadEffect],
    defaults: EffectiveConfig,
) -> tuple[float, float, list[str], dict]:
    scope = edit.scope or "session"
    tl_start, tl_end = map(float, span)
    pause = prepared_pause is not None
    tracks = (
        [edit.track_id] if removal is None else ripple_track_ids(project, removal.edited_track_ids)
    )
    consumed_inaudible_opt = False
    implicit = []
    for tid in tracks:
        track = project.track_by_id(tid)
        if (
            track
            and track.media
            and not track.timeline_empty
            and not any(c.track_id == tid for c in project.clips)
            and track.media.duration_sec is not None
            and math.isfinite(track.media.duration_sec)
            and track.media.duration_sec > 0
        ):
            implicit.append(full_span_clip(tid, track.media.duration_sec))
    proof.close()
    project.clips.extend(implicit)
    if scope == "track":
        report = _write_punch_delete(
            project, edit.track_id, tl_start, tl_end, record_log=record_log, defaults=defaults
        )
        return (
            tl_start,
            tl_end,
            [edit.track_id],
            {
                "per_track_source": report["per_track_source"],
                "replace_gap_sec": None,
                "scope": scope,
                "use_inaudible_opt": consumed_inaudible_opt,
                "source_start": actual.start,
                "source_end": actual.end,
                **({"source_id": edit.source_id} if edit.source_timeline_span is not None else {}),
            },
        )
    assert removal is not None
    report = _write_ripple_delete(
        project,
        removal,
        cut_speech=speech,
        record_log=record_log,
        params={"use_inaudible_opt": consumed_inaudible_opt},
        defaults=defaults,
    )
    tl_start, tl_end = report["timeline_start"], report["timeline_end"]
    per_track = report["per_track_source"]
    track_ids = list(per_track.keys()) or dialogue_track_ids(project) or [edit.track_id]
    samples = _apply_replace_gap_pad(
        project,
        actual,
        tl_start,
        exact_seam=pause,
        source_audio_caches=source_audio_caches,
        effects=pads,
        defaults=defaults,
    )
    effects = prepared_pause.effects if prepared_pause is not None else ()
    matches = [
        (edge, clips[0])
        for edge in effects
        if (clips := cut_effects.pause_edge_clips(project, edge))
    ]
    for edge, clip in matches:
        if edge.side == "left":
            clip.fade_out_ms = edge.milliseconds
        else:
            clip.fade_in_ms = edge.milliseconds
            clip.join_in_mode = ClipJoinMode.FADE
    return (
        tl_start,
        tl_end,
        track_ids,
        {
            "per_track_source": per_track,
            "replace_gap_sec": actual.replace_gap_sec,
            "scope": scope,
            "use_inaudible_opt": consumed_inaudible_opt,
            "source_start": actual.start,
            "source_end": actual.end,
            **({"source_id": edit.source_id} if edit.source_timeline_span is not None else {}),
            "crossfade_ms": actual.crossfade_ms,
            "next_burst_sec": actual.next_burst_sec,
            "pad_samples": samples,
            **(
                {
                    "loss_sec": tl_end - tl_start - (actual.replace_gap_sec or 0.0),
                    "edge_fades": [
                        {
                            "track_id": edge.track_id,
                            "source_id": edge.source_id,
                            "source_sec": edge.source_sec,
                            "timeline_sec": edge.timeline_sec,
                            "side": edge.side,
                            "milliseconds": edge.milliseconds,
                            "source_start": edge.source_start,
                            "source_end": edge.source_end,
                            "inherited_ms": edge.inherited_ms,
                        }
                        for edge in effects
                    ],
                }
                if pause
                else {}
            ),
            **cut_speech_params(speech),
        },
    )


def _write_join_fades(
    project: EpisodeProject,
    decisions: list[EditDecision],
    *,
    defaults: EffectiveConfig,
) -> dict:
    pad_origins = cut_effects.native_pad_origins()
    pad_origin_ids: set[str | None] = {*pad_origins}
    by_track: dict[str, list[EditDecision]] = {}
    for d in decisions:
        by_track.setdefault(d.track_id, []).append(d)

    affected: set[str] = set()
    contributors: dict[str, frozenset[str]] = {}
    for tid, decs in by_track.items():
        for left, right in abutting_pairs(clips_for_track(project, tid)):
            if any(
                clip_split_origin(clip.id, pad_origin_ids) in pad_origin_ids
                for clip in (left, right)
            ):
                continue
            join_src = left.source_end
            matching = [
                d for d in decs if abs(d.end - join_src) < 0.08 or abs(d.start - join_src) < 0.08
            ]
            if not matching:
                continue
            fade = max(d.crossfade_ms for d in matching)
            if fade <= 0:
                fade = recommend_cut_fade_ms(
                    project,
                    tid,
                    left.source_end,
                    right.source_start,
                    cut_kind="filler",
                    defaults=defaults,
                )
            fade = cap_fade_ms(project, tid, fade, defaults)
            left.fade_out_ms = max(left.fade_out_ms, fade)
            right.fade_in_ms = max(right.fade_in_ms, fade)
            right.join_in_mode = ClipJoinMode.FADE
            for clip in (left, right):
                contributors[clip.id] = contributors.get(clip.id, frozenset()) | frozenset(
                    d.id for d in matching
                )
            affected.add(tid)

    return {
        "operation": "apply_join_fades",
        "affected_tracks": sorted(affected),
        "clip_count": len(project.clips),
        "timeline_duration_sec": project.timeline.duration_sec,
        "contributors": contributors,
    }


def _apply_mute_edit(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    defaults: EffectiveConfig,
) -> tuple[EpisodeProject, tuple[float, float, list[str], dict]] | CutScopeHold:
    """Mute ``edit``'s source span in place, with the fill and fades a ripple pad gets.

    The region spans the edit plus its fades, so the edit itself is silent: the clip
    fades out into it as a padded cut fades into its pad, and back in after it over
    the post-pad fade-in, which ends before ``edit.next_burst_sec``. Clips do not move.
    """
    published = project
    project = project.model_copy(deep=True)

    room_tone = filler_pad_mode(defaults=defaults) == "room_tone"
    fade_out = pre_pad_fade_out_ms(defaults)
    fade_in = (
        recommend_post_pad_fade_in_ms(
            project,
            edit.track_id,
            edit.end,
            next_burst_sec=edit.next_burst_sec,
            defaults=defaults,
        )
        or MUTE_FADE_MS
    )
    placement = cut_placement.inspect_source_remove_placement(published, edit)
    observed = cut_safety.SourceCutObservations(
        (TimelineSec(edit.start), TimelineSec(edit.end))
        if isinstance(placement, CutScopeHold)
        else placement,
        placement if isinstance(placement, CutScopeHold) else None,
        None,
        cut_safety.PeerObservations(None, None),
        None,
    )
    tl_start, tl_end = map(float, observed.span)
    span = (max(0.0, edit.start - fade_out / 1000), edit.end + fade_in / 1000)
    written = False
    for clip in clips_for_track(project, edit.track_id):
        if clip.source_id not in project.equivalent_source_ids(edit.track_id, edit.source_id):
            continue
        if edit.end <= clip.source_start or edit.start >= clip.source_end:
            continue
        region = ClipMuteRegion(
            start_s=span[0],
            end_s=span[1],
            fill=mute_room_tone_fill(project, clip, edit.start, edit.end) if room_tone else None,
            fade_out_ms=fade_out,
            fade_in_ms=fade_in,
        )
        if add_source_mute(clip, region):
            written = True
    track_ids = [edit.track_id] if written else []
    ids = frozenset({edit.id})
    held = _completed_holds(
        published,
        project,
        ids,
        defaults=defaults,
        manual_ids=ids
        if is_human_intent(application_intent) or is_human_intent(edit.boundary_intent)
        else frozenset(),
        observation=observed,
    )
    if held:
        return held[0]
    return project, (
        tl_start,
        tl_end,
        track_ids,
        {
            "scope": getattr(edit, "scope", "session") or "session",
            "mute": True,
            **({"source_id": edit.source_id} if edit.source_id is not None else {}),
            # What reverting subtracts: the muted region, fades included.
            "per_track_source": {edit.track_id: list(span)} if written else {},
        },
    )


@batch_scope()
def approve_edits(
    project: EpisodeProject,
    ids: list[str],
    *,
    defaults: EffectiveConfig,
    application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    held_out: list[HeldEdit] | None = None,
    asked_out: list[AskedEdits] | None = None,
    override_peer_holds: set[str] | None = None,
    accept_leaned_on: bool = False,
) -> int:
    """Apply selected edits on a private copy, then adopt the completed result.

    Trusted human application intent bypasses acoustic holds. Programmatic confirmation
    does not grant that intent. ``override_peer_holds`` records which trusted-human cuts
    overrode peer evidence, for the suggested-action summary.

    Without ``held_out``, a scope hold discards the whole candidate, including earlier
    mutes and provisional archives. With explicit partial reporting, held edits stay
    pending. ``asked_out`` additionally reports removals that cut unselected speech.
    A partial batch that relied on a held removal is refused unless its caller explicitly
    supplies ``accept_leaned_on``. Services retain persistence and history ownership.
    """

    published = project
    project = project.model_copy(deep=True)
    id_set = set(ids)
    applied_ids: set[str] = set()
    to_apply = [e for e in project.edit_decisions if e.id in id_set]
    unplayed = sorted(unplayed_pending_ids(project, id_set))
    if unplayed and held_out is not None:
        # A partial batch leaves a proposal whose audio was already cut away pending and
        # says so; the rest still apply.
        held_out.extend(
            HeldEdit(
                edit_id,
                cut_label(project, next(e for e in project.edit_decisions if e.id == edit_id)),
                STALE_REASON,
            )
            for edit_id in unplayed
        )
        id_set -= set(unplayed)
        to_apply = [e for e in to_apply if e.id in id_set]
        unplayed = []
    if unplayed:
        raise CodedValueError(
            f"{len(unplayed)} proposal(s) point at audio that was cut away and no longer plays "
            f"({', '.join(unplayed)}); reject them or run propose_edits again",
            code="edit_span_not_played",
        )
    exact = [e for e in to_apply if e.exact_range is not None]
    if exact:
        project = _range_candidate(
            project, exact, application_intent=application_intent, defaults=defaults
        )
        applied_ids.update(edit.id for edit in exact)
    to_apply = [e for e in to_apply if e.exact_range is None]
    # Mutes first (timeline-stable). Later removes first so earlier positions
    # stay valid after ripple+pad. Splits run after removes.
    mutes = [e for e in to_apply if e.type == EditDecisionType.MUTE]
    removes = [e for e in to_apply if e.type == EditDecisionType.REMOVE]
    splits = [e for e in to_apply if e.type == EditDecisionType.SPLIT]
    held: list[CutScopeHold] = []
    # Named before any ripple moves anything, so a held cut reads as the list shows it.
    labels = {e.id: cut_label(project, e) for e in (*mutes, *removes)}
    for edit in sorted(mutes, key=lambda e: e.start, reverse=True):
        previous = project
        muted = _apply_mute_edit(
            project, edit, application_intent=application_intent, defaults=defaults
        )
        if isinstance(muted, CutScopeHold):
            held.append(muted)
            continue
        project, report = muted
        tl_start, tl_end, track_ids, params = report
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
        receipts = cut_effects.complete_effect_receipts(previous, project, [edit])
        if receipts:
            held.extend(receipts)
            project = previous
            continue
        applied_ids.add(edit.id)
    if verdict_cache.verifying():
        # Lab and tests: every check below then finds a cached one and compares against it.
        precompute_verdicts(
            project,
            [e.id for e in removes],
            defaults=defaults,
            application_intent=application_intent,
        )
    batch = _source_extents(removes)
    extents = batch.copy()
    applied_removes: list[str] = []
    partial = held_out is not None
    # Where each cut sits on the timeline before anything ripples: another track's clip can
    # shift its source time, so two cuts that overlap there need not be near in source time.
    on_timeline = {e.id: edit_timeline_range(project, e) for e in removes}
    asked: list[CutSpeechConfirmation] = []
    asked_ids: list[str] = []
    mute_base = _cut_copy(project)
    mute_ids = applied_ids.copy()
    excluded: set[str] = set()
    demoted: list[str] = []

    def _beside(a: str, x: str) -> bool:
        return x in extents and (
            _near(extents[a], extents[x]) or _near_on_timeline(on_timeline[a], on_timeline[x])
        )

    def _beside_any(a: str, others: Iterable[str]) -> bool:
        return any(_beside(a, x) for x in others)

    while True:
        project = _cut_copy(mute_base)
        applied_ids = mute_ids.copy()
        applied_removes = []
        survivors = [edit for edit in removes if edit.id not in excluded]
        batch = _source_extents(survivors)
        newly_held: set[str] = set()
        # Cleared after each apply: the applied candidate is then written in place.
        measured: cut_safety.MeasuredSources = {}
        timeline = CarriedTimelineRms(project)
        for edit in sorted(survivors, key=lambda e: e.start, reverse=True):
            previous = project
            applied = _apply_source_remove(
                project,
                edit,
                defaults=defaults,
                application_intent=application_intent,
                batch=tuple(batch.values()),
                record_log=False,
                override_peer_holds=override_peer_holds,
                measured=measured,
                timeline=timeline,
            )
            if isinstance(applied, CutSpeechConfirmation):
                asked.append(applied)
                asked_ids.append(edit.id)
                newly_held.add(edit.id)
                batch.pop(edit.id)
                continue
            if isinstance(applied, CutScopeHold):
                held.append(applied)
                newly_held.add(edit.id)
                batch.pop(edit.id)
                continue
            project, report = applied
            measured.clear()
            tl_start, tl_end, track_ids, params = report
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
            receipts = cut_effects.complete_effect_receipts(previous, project, [edit])
            if receipts:
                held.extend(receipts)
                newly_held.add(edit.id)
                batch.pop(edit.id)
                project = previous
                continue
            applied_ids.add(edit.id)
            applied_removes.append(edit.id)
            timeline.applied(tl_start)
        # Only a cut applied before the hold was found counted that edit as removed;
        # one further away is unchanged by running the pass again.
        excluded.update(newly_held)
        if any(_beside(a, x) for a in applied_removes for x in newly_held):
            continue
        leaning = (
            [a for a in applied_removes if _beside_any(a, (*asked_ids, *(h.edit_id for h in held)))]
            if partial and not accept_leaned_on
            else []
        )
        if not leaning:
            break
        # A partial batch holds back the cuts that sit beside a held one too, so the rest
        # still apply and nothing is applied on a guess.
        demoted.extend(leaning)
        excluded.update(leaning)
    # An applied cut beside a left-pending one may have cleared speech on the assumption
    # that the other removes it: then nothing applies on a guess, as before.
    left_pending = (*asked_ids, *(h.edit_id for h in held))
    leaned_on = not accept_leaned_on and any(_beside_any(a, left_pending) for a in applied_removes)
    if asked:
        confirmation = confirmation_for(merge_cut_speech([a.speech for a in asked]))
        if asked_out is None or not partial or leaned_on:
            raise UnconfirmedCutSpeech(confirmation)
        asked_out.append(AskedEdits(tuple(asked_ids), confirmation))
    if held_out is not None and demoted and not leaned_on:
        held_out.extend(
            HeldEdit(
                edit_id,
                labels.get(edit_id, ""),
                "it sits right beside a held cut, so it waits with it",
            )
            for edit_id in demoted
        )
    if held:
        error = ScopeChangedAtApproval(
            held,
            {tid: _speaker_name(project, tid) for h in held for tid in h.peers},
            {h.edit_id: labels[h.edit_id] for h in held if h.edit_id in labels},
        )
        if held_out is None or leaned_on:
            raise error
        held_out.extend(
            HeldEdit(h.edit_id, labels.get(h.edit_id, ""), error.reason_for(h)) for h in held
        )
    for edit in sorted(splits, key=lambda e: e.start, reverse=True):
        at_time = float(edit.start)
        tids = list(edit.track_ids) if edit.track_ids else [edit.track_id]
        split_report = split_clips_at(project, at_time, tids, record_log=False, defaults=defaults)
        archive_decision(
            project,
            edit,
            operation="approve_split",
            timeline_start=at_time,
            timeline_end=at_time,
            track_ids=list(split_report.get("affected_tracks") or tids),
            params={
                "at_time": at_time,
                "track_ids": tids,
                "split_source_by_track": split_report.get("split_source_by_track") or {},
            },
        )
        applied_ids.add(edit.id)

    before = len(project.edit_decisions)
    project.edit_decisions = [e for e in project.edit_decisions if e.id not in applied_ids]
    receipts = cut_effects.complete_effect_receipts(
        published, project, [e for e in published.edit_decisions if e.id in applied_ids]
    )
    if receipts:
        raise ScopeChangedAtApproval(receipts, {})
    project_merge.adopt_project_state(published, project)
    return before - len(project.edit_decisions)


def _apply_auto_removes(
    project: EpisodeProject,
    removes: list[EditDecision],
    *,
    config_key: str,
    defaults: dict,
) -> tuple[EpisodeProject, set[str]]:
    """Ripple ``removes`` right to left, each counting the others as chosen.

    Returns the ids of the removes held back because they would cut other speech.
    """
    batch = _source_extents(removes)
    held: set[str] = set()
    timeline = RebuiltTimelineRms(project)
    for edit in sorted(removes, key=lambda e: e.start, reverse=True):
        previous = project
        applied = _apply_source_remove(
            project,
            edit,
            defaults=defaults,
            batch=tuple(batch.values()),
            record_log=False,
            timeline=timeline,
        )
        if isinstance(applied, CutSpeechConfirmation | CutScopeHold):
            held.add(edit.id)
            batch.pop(edit.id)
            continue
        project, report = applied
        tl_start, tl_end, track_ids, params = report
        if not track_ids:
            continue
        edit.start = params["source_start"]
        edit.end = params["source_end"]
        edit.crossfade_ms = params.get("crossfade_ms", edit.crossfade_ms)
        edit.replace_gap_sec = params["replace_gap_sec"]
        archive_decision(
            project,
            edit,
            operation="apply_prefix_edits",
            timeline_start=tl_start,
            timeline_end=tl_end,
            track_ids=track_ids,
            params={**params, "config_key": config_key},
        )
        if cut_effects.complete_effect_receipts(previous, project, [edit]):
            held.add(edit.id)
            batch.pop(edit.id)
            project = previous
    return project, held


@batch_scope()
def apply_prefix_edits(
    project: EpisodeProject,
    reason_prefix: str | tuple[str, ...],
    *,
    config_key: str,
    defaults: EffectiveConfig,
) -> int:
    """Apply auto-approved REMOVE (ripple) or MUTE (in-place) edits for reason prefixes.

    A remove whose ripple would cut other speech stays pending for review, and the
    speech it covers is chosen by none of the removes that apply.
    """
    published = project
    project = project.model_copy(deep=True)
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
        mapped = edit_timeline_range(project, e)
        if mapped is None or mapped[1] <= mapped[0]:
            continue
        applied_decisions.append(e)

    if not applied_decisions:
        return 0

    mutes = [e for e in applied_decisions if e.type == EditDecisionType.MUTE]
    removes = [e for e in applied_decisions if e.type == EditDecisionType.REMOVE]
    held_mutes: set[str] = set()
    for edit in sorted(mutes, key=lambda e: e.start, reverse=True):
        previous = project
        muted = _apply_mute_edit(project, edit, defaults=defaults)
        if isinstance(muted, CutScopeHold):
            held_mutes.add(edit.id)
            continue
        project, report = muted
        tl_start, tl_end, track_ids, params = report
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
        if cut_effects.complete_effect_receipts(previous, project, [edit]):
            held_mutes.add(edit.id)
            project = previous
    remove_ids = {e.id for e in removes}
    held: set[str] = set()
    while True:
        working = project.model_copy(deep=True)
        working, newly = _apply_auto_removes(
            working,
            [e for e in working.edit_decisions if e.id in remove_ids - held],
            config_key=config_key,
            defaults=defaults,
        )
        if newly:
            held |= newly
            continue
        before_fades = working.model_copy(deep=True)
        fades = _write_join_fades(
            working,
            [
                e
                for e in working.edit_decisions
                if e.id in remove_ids - held and not (e.reason or "").startswith("pause:")
            ],
            defaults=defaults,
        )

        effects_held = _completed_holds(
            before_fades,
            working,
            frozenset(remove_ids - held),
            defaults=defaults,
            manual_ids=frozenset(
                e.id for e in applied_decisions if is_human_intent(e.boundary_intent)
            ),
            contributors_by_clip=fades["contributors"],
        )
        if effects_held:
            held.update(h.edit_id for h in effects_held)
            continue

        project = working
        break
    applied_decisions = [e for e in applied_decisions if e.id not in held | held_mutes]

    id_set = {e.id for e in applied_decisions}
    before = len(project.edit_decisions)
    project.edit_decisions = [e for e in project.edit_decisions if e.id not in id_set]
    receipts = cut_effects.complete_effect_receipts(
        published, project, [e for e in published.edit_decisions if e.id in id_set]
    )
    if receipts:
        raise ScopeChangedAtApproval(receipts, {})
    project_merge.adopt_project_state(published, project)
    return before - len(project.edit_decisions)


def apply_auto_edits(project: EpisodeProject, defaults: EffectiveConfig) -> int:
    return apply_prefix_edits(
        project, ("filler:", "pause:"), config_key="tighten", defaults=defaults
    )


def _range_candidate(
    project: EpisodeProject,
    edits: list[EditDecision],
    *,
    application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    mute_ownership: MuteOwnership = MuteOwnership.ORDINARY,
    defaults: EffectiveConfig,
) -> EpisodeProject:
    published = project
    project = project.model_copy(deep=True)
    plans = [(edit, edit.exact_range) for edit in edits if edit.exact_range is not None]
    if len(plans) != len(edits) or any(not target.clips for _, target in plans):
        raise CodedValueError(
            "No audible media in this range. Select a range that contains audio.",
            code="no_audible_media",
        )
    if any(edit.type == EditDecisionType.REMOVE for edit, _target in plans):
        project.timeline.duration_sec = max(
            project.timeline.duration_sec or 0.0,
            timeline_duration_sec(project),
            max(c.timeline_end for _edit, target in plans for c in target.clips),
        )
    operations: dict[str, list[tuple[EditDecisionType, RangeInterval]]] = {}
    track_ids: set[str] = set()
    for edit, target in plans:
        track_ids.update(c.track_id for c in target.clips)
        for clip in target.clips:
            if not any(c.id == clip.id for c in project.clips):
                project.clips.append(clip.model_copy(deep=True))
            operations.setdefault(clip.id, []).extend(
                (edit.type, interval) for interval in target.intervals
            )
    for tid in sorted(track_ids):
        replacements: list[Clip] = []
        for original in project.clips:
            if original.track_id != tid:
                continue
            actions = operations.get(original.id)
            if not actions:
                replacements.append(original)
                continue
            clip = original.model_copy(deep=True)
            cuts: list[tuple[float, float]] = []
            for action, interval in actions:
                a = max(interval.start, clip.timeline_start)
                b = min(interval.end, clip.timeline_end)
                if b <= a:
                    continue
                if action == EditDecisionType.MUTE:
                    source_span = clip_timeline_overlap_to_source(clip, a, b)
                    if source_span is not None and source_span[1] > source_span[0]:
                        start_s, end_s = source_span
                        if mute_ownership is MuteOwnership.OFF_SPEAKER:
                            add_off_speaker_mute(
                                clip, ClipOffSpeakerMuteRegion(start_s=start_s, end_s=end_s)
                            )
                        else:
                            add_source_mute(clip, ClipMuteRegion(start_s=start_s, end_s=end_s))
                else:
                    cuts.append((a, b))
            if not cuts:
                replacements.append(clip)
                continue
            remaining = [clip]
            for start, end in sorted(cuts):
                remaining = punch_timeline_range_from_clips(
                    remaining, start, end, defaults=defaults
                )
            replacements.extend(remaining)
        set_track_clips(project, tid, replacements)
        if not replacements:
            track = project.track_by_id(tid)
            if track is not None:
                track.timeline_empty = True
    rebuild_combined(project, defaults=defaults)
    for edit, target in plans:
        archive_decision(
            project,
            edit,
            operation="edit_selected_range",
            timeline_start=target.intervals[0].start,
            timeline_end=target.intervals[-1].end,
            track_ids=target.track_ids,
            params={
                "exact_range": target.model_dump(mode="json"),
                "action_id": edit.id,
                "action": "mute" if edit.type == EditDecisionType.MUTE else "cut",
            },
        )

    ids = frozenset(edit.id for edit in edits)
    held = _completed_holds(
        published,
        project,
        ids,
        defaults=defaults,
        exact_ranges={edit.id: target for edit, target in plans},
        manual_ids=frozenset(
            edit.id
            for edit in edits
            if is_human_intent(application_intent) or is_human_intent(edit.boundary_intent)
        ),
    )
    if held:
        raise ScopeChangedAtApproval(held, {})
    receipts = cut_effects.complete_effect_receipts(published, project, edits)
    if receipts:
        raise ScopeChangedAtApproval(receipts, {})
    return project


@batch_scope()
def apply_ranges(
    project: EpisodeProject,
    edits: list[EditDecision],
    *,
    application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    mute_ownership: MuteOwnership = MuteOwnership.ORDINARY,
    defaults: EffectiveConfig,
) -> None:
    candidate = _range_candidate(
        project,
        edits,
        application_intent=application_intent,
        mute_ownership=mute_ownership,
        defaults=defaults,
    )
    adopt_project_state(project, candidate)


@batch_scope()
def assess_offer(
    project: EpisodeProject, edit: EditDecision, *, defaults: dict
) -> list[CutScopeHold]:
    if edit.exact_range is not None:
        try:
            _range_candidate(project, [edit], defaults=defaults)
        except ScopeChangedAtApproval as exc:
            return list(exc.held)
        return []
    result = (
        _apply_mute_edit(project, edit, defaults=defaults)
        if edit.type is EditDecisionType.MUTE
        else _apply_source_remove(project, edit, defaults=defaults, batch=())
    )
    if isinstance(result, CutScopeHold):
        return [result]
    if isinstance(result, CutSpeechConfirmation):
        return [CutScopeHold(edit.id, (), "peer_speech")]
    return []


def assess_source_offer(project: EpisodeProject, edit: EditDecision, *, defaults: dict) -> None:
    if edit.boundary_intent is CutIntent.HUMAN_BOUNDARIES or edit.type == EditDecisionType.SPLIT:
        return
    holds = assess_offer(project, edit, defaults=defaults)
    reason = (edit.reason or "").partition(":acoustic_review:")[0]
    edit.reason = reason
    mode: cut_policy.CutMode = "mute" if edit.type is EditDecisionType.MUTE else "ripple"
    labels = [
        cut_safety.safety_observation_label(hold)
        for hold in holds
        if cut_policy.action_for_safety_observation(
            cut_safety.safety_observation_label(hold), mode
        ).action
        == "review"
    ]
    if labels:
        edit.review_required = True
        edit.reason = f"{reason}:acoustic_review:{','.join(dict.fromkeys(labels))}"


@batch_scope()
def apply_lower(
    project: EpisodeProject,
    decision: EditDecision,
    db: float = LOWER_GAIN_DB,
    *,
    application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    defaults: EffectiveConfig,
) -> bool:
    published = project
    project = project.model_copy(deep=True)
    mapped = cut_placement.inspect_source_remove_placement(
        project, decision.model_copy(update={"type": EditDecisionType.MUTE})
    )
    observation = cut_safety.SourceCutObservations(
        (TimelineSec(decision.start), TimelineSec(decision.end))
        if isinstance(mapped, CutScopeHold)
        else mapped,
        mapped if isinstance(mapped, CutScopeHold) else None,
        None,
        cut_safety.PeerObservations(None, None),
        None,
    )
    written = False
    for clip in clips_for_track(project, decision.track_id):
        if clip.source_id not in project.equivalent_source_ids(
            decision.track_id, decision.source_id
        ):
            continue
        if decision.end <= clip.source_start or decision.start >= clip.source_end:
            continue
        # Only the part no mute already silences: a lowered span never reopens, trims or
        # abuts a mute (render would hold the union at the mute's gain).
        hard = [(r.start_s, r.end_s) for r in clip.mute_regions if r.gain_db is None]
        for lo, hi in subtract_intervals([(decision.start, decision.end)], hard):
            if hi - lo < 1e-3:
                continue
            region = ClipMuteRegion(
                start_s=lo,
                end_s=hi,
                fade_out_ms=LOWER_FADE_MS,
                fade_in_ms=LOWER_FADE_MS,
                gain_db=db,
            )
            written = add_source_mute(clip, region) or written
    if not written:
        return False
    archive_decision(
        project,
        decision,
        operation="approve_edits",
        timeline_start=observation.span[0],
        timeline_end=observation.span[1],
        track_ids=[decision.track_id],
        params={
            "scope": "track",
            "mute": True,
            "source_id": decision.source_id,
            "lowered_db": db,
            "per_track_source": {decision.track_id: [decision.start, decision.end]},
        },
    )
    ids = frozenset({decision.id})
    held = _completed_holds(
        published,
        project,
        ids,
        defaults=defaults,
        observation=observation,
        mode="mute",
        manual_ids=ids
        if is_human_intent(application_intent) or is_human_intent(decision.boundary_intent)
        else frozenset(),
    )
    if held:
        return False
    receipts = cut_effects.complete_effect_receipts(published, project, [decision])
    if receipts:
        return False
    adopt_project_state(published, project)
    return True


@batch_scope()
def apply_suggested_to_project(
    project: EpisodeProject,
    actions: dict[str, str],
    result: SuggestedActionsResult,
    *,
    application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    defaults: EffectiveConfig,
) -> None:
    """Apply ``actions`` (decision id -> cut / shorten / lower / leave) to ``project`` in place.

    The caller owns the transaction, so a service call and a pipeline step each get one
    undo step.  Lowers go first (a laugh nobody talks over becomes a leave), then leaves,
    then every cut together so the speech guard sees one batch.
    """

    published = project
    project = project.model_copy(deep=True)
    by_id = {e.id: e for e in project.edit_decisions}
    cut_ids = [i for i, a in actions.items() if a in ("cut", "shorten") and i in by_id]
    done: set[str] = set()
    for edit_id in [i for i, a in actions.items() if a == "lower" and i in by_id]:
        decision = by_id[edit_id]
        peer = suggested_actions.another_speaker_over(project, decision, defaults=defaults)
        if peer is None:
            result.held.append(edit_id)  # unreadable, so neither lowered nor recorded as left
        elif not peer:
            actions[edit_id] = "leave"
            result.left_no_overlap += 1
        elif apply_lower(
            project, decision, application_intent=application_intent, defaults=defaults
        ):
            record_sound_action(project, decision, "lower")
            done.add(edit_id)
            result.applied["lower"] = result.applied.get("lower", 0) + 1
        else:
            result.held.append(edit_id)
    leave_ids = [i for i, a in actions.items() if a == "leave" and i in by_id]
    for edit_id in leave_ids:
        record_sound_action(project, by_id[edit_id], "leave")
    reject_edits(project, leave_ids)
    if leave_ids:
        result.applied["leave"] = len(leave_ids)
    project.edit_decisions = [e for e in project.edit_decisions if e.id not in done]
    if not cut_ids:
        adopt_project_state(published, project)
        return
    before = {e.id for e in project.edit_decisions}
    stale = unplayed_pending_ids(project, set(cut_ids))
    live = [i for i in cut_ids if i not in stale]
    for edit_id in live:
        decision = by_id[edit_id]
        if decision.scope != "track" and decision.exact_range is None:
            record_suggested_cut_speech(project, decision, defaults=defaults)
    over = {i for i in live if by_id[i].cut_speech is not None}
    held: list[HeldEdit] = []
    overridden: set[str] = set()
    approve_edits(
        project,
        live,
        application_intent=application_intent,
        held_out=held,
        override_peer_holds=overridden,
        accept_leaned_on=True,
        defaults=defaults,
    )
    gone = before - {e.id for e in project.edit_decisions}
    applied_cuts = [i for i in cut_ids if i in gone]
    for action in ("cut", "shorten"):
        n = sum(1 for i in applied_cuts if actions[i] == action)
        if n:
            result.applied[action] = n
    result.cut_over_speaker = len((over | overridden) & set(applied_cuts))
    result.held.extend(h.edit_id for h in held)
    result.held.extend(i for i in cut_ids if i not in gone and i not in result.held)

    adopt_project_state(published, project)


@batch_scope()
def apply_edit_plan(
    project: EpisodeProject,
    edits: list[dict[str, Any]],
    *,
    crossfade_ms: int = 10,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
    defaults: EffectiveConfig,
) -> list[EditDecision]:
    from podcast_mcp.edits.transcript_cuts import add_remove_decision

    candidate = project.model_copy(deep=True)
    created: list[EditDecision] = []
    requested: set[str] = set()
    for raw in edits:
        apply_now = bool(raw.get("applied", False))
        prior_ids = {row.id for row in candidate.edit_decisions}
        merge_ids = {
            row.id for row in candidate.edit_decisions if (row.id in requested) == apply_now
        }
        decision = add_remove_decision(
            candidate,
            str(raw["track_id"]),
            float(raw["start"]),
            float(raw["end"]),
            reason=str(raw.get("reason", "agent:plan")),
            review_required=bool(raw.get("review_required", review_required)),
            crossfade_ms=int(raw.get("crossfade_ms", crossfade_ms)),
            use_inaudible_opt=raw.get("use_inaudible_opt", use_inaudible_opt),
            merge_ids=merge_ids,
            defaults=defaults,
        )
        merged = prior_ids - {row.id for row in candidate.edit_decisions}
        created = [decision if row.id in merged else row for row in created]
        created.append(decision)
        requested -= merged
        if apply_now:
            requested.add(decision.id)
    if requested:
        approve_edits(candidate, sorted(requested), defaults=defaults)
    adopt_project_state(project, candidate)
    return [row.model_copy(update={"applied": row.id in requested}) for row in created]
