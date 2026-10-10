from __future__ import annotations

import logging
import math
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal, TypeVar

from podcast_mcp.config import load_defaults
from podcast_mcp.edits import (
    TightenProposal,
    apply_auto_edits,
    apply_edit_plan,
    approve_edits,
    build_edit_context_json,
    cut_text_match,
    cut_time_range,
    cut_utterance,
    cut_words,
    edit_impact_report,
    format_edit_impact_markdown,
    format_transcript_timestamps,
    list_edit_decisions,
    propose_tighten_edits,
    reject_edits,
    search_transcript,
)
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.audio_quality import (
    apply_fade_recommendations,
    audio_diagnostics_report,
    bleed_words,
    cleanup_analysis_report,
    fade_recommendations,
    gate_overreach_report,
    suppress_bleed_words,
    suppress_low_audibility_words,
)
from podcast_mcp.edits.audio_quality import (
    low_audibility_words as audit_low_audibility_words,
)
from podcast_mcp.edits.chapters import (
    add_chapter,
    delete_chapter,
    list_chapters,
    remove_chapter,
    update_chapter,
)
from podcast_mcp.edits.clip_fades import ClipFadeBaseline, require_clip_fade_baseline
from podcast_mcp.edits.cut_speech import (
    CutSpeechConfirmation,
    SpeechClearance,
    UnconfirmedCutSpeech,
    assess_cut_speech,
    clear_ripple,
)
from podcast_mcp.edits.decisions import (
    PendingCutSuggestion,
    PendingEditBaseline,
    preview_pending_cut_range,
    require_pending_edit_baseline,
    update_pending_edit,
)
from podcast_mcp.edits.edit_log import (
    list_applied_edits,
    require_applied_edit_restore,
    revert_applied_edit,
)
from podcast_mcp.edits.edit_reasons import (
    GUEST_SUGGEST_DELETE_REASON,
    GUEST_SUGGEST_REASON,
    GUEST_SUGGEST_RIPPLE_DELETE_REASON,
    GUEST_SUGGEST_SPLIT_REASON,
    NL_RANGE_REASON,
)
from podcast_mcp.edits.inaudible_cuts import (
    optimize_source_cut_range,
    optimize_timeline_cut_range,
)
from podcast_mcp.edits.join_continuity import (
    assess_existing_join,
    assess_project_joins,
    assess_proposed_cut,
)
from podcast_mcp.edits.join_labels import record_label
from podcast_mcp.edits.join_modes import (
    crossfade_joins,
    fade_joins,
    set_clip_join,
    set_clip_join_mode,
)
from podcast_mcp.edits.loudness import check_loudness
from podcast_mcp.edits.range_edits import RangeAction, RangeEditResult
from podcast_mcp.edits.retained_bleed_alignment import (
    AlignmentPlan,
    apply_retained_bleed_alignment,
    plan_retained_bleed_alignment,
    set_retained_bleed_alignment_mode,
)
from podcast_mcp.edits.ripple import RippleRemoval, TrimEdge, plan_trim
from podcast_mcp.edits.share_registry import get_share_registry
from podcast_mcp.edits.silence_islands import (
    SilenceIsland,
    silence_islands_from_hops,
    timeline_rms_hops,
)
from podcast_mcp.edits.silence_islands import (
    suggest_handoff_cut as suggest_handoff_cut_bounds,
)
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.strip_silence import strip_silence
from podcast_mcp.edits.timeline_ops import (
    copy_segment,
    duplicate_segment,
    fill_with_room_tone,
    insert_gap,
    list_clips,
    move_by_text,
    move_clips,
    move_segment,
    paste_segment,
    plan_delete_clips,
    plan_ripple_delete,
    plan_ripple_delete_text,
    plan_shorten_word_gaps,
    punch_delete_clips,
    punch_delete_range,
    ripple_delete,
    ripple_delete_clips,
    roll_clip_join,
    set_clip_fade,
    split_clips_at,
    trim_clip_edge,
)
from podcast_mcp.edits.transcript_bleed_mute import apply_transcript_bleed_mute
from podcast_mcp.edits.transcript_correct import (
    DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    TranscriptTextChangedError,
    apply_transcript_corrections,
    correct_phrase,
    correct_word,
    list_low_confidence,
    require_word_text,
    run_user_transcript_edit,
    set_word_automatic,
    set_word_suppressed,
    set_words_ignored,
    verify_words,
)
from podcast_mcp.edits.transcript_cuts import (
    TranscriptMatch,
    append_remove_decision,
    append_split_decision,
)
from podcast_mcp.edits.transcript_reconcile import (
    audibility_map as build_audibility_map,
)
from podcast_mcp.edits.transcript_reconcile import (
    flagged_words as list_flagged_transcript_words,
)
from podcast_mcp.edits.transcript_reconcile import (
    overlap_duplicate_report,
    reconciliation_status_report,
    run_reconciliation,
)
from podcast_mcp.edits.transcript_refine_status import assert_refine_clear
from podcast_mcp.edits.transcript_replace import (
    apply_transcript_replacement,
    plan_transcript_replacement,
)
from podcast_mcp.edits.transcript_timing import (
    TranscriptTimingChangedError,
    WordTimingTarget,
    apply_word_timing,
    timing_transcript,
    validate_word_timing,
    word_timing_context,
)
from podcast_mcp.effects.presets import (
    add_effect,
    apply_preset_to_chain,
    list_presets,
    list_track_effects,
    remove_effect,
    set_effect_bypass,
)
from podcast_mcp.engines.render_status import render_status_report
from podcast_mcp.history.manager import apply_snapshot_to_project, snapshot_from_project
from podcast_mcp.history.rollback import RollbackOutcome
from podcast_mcp.models import EditDecision, EditMode, EpisodeProject
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.render import rerender_preview
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.change_summary import change_summary
from podcast_mcp.util.progress import ProgressReporter
from podcast_mcp.util.project_state import RENDER_LOCK_TIMEOUT_SEC, render_lock
from podcast_mcp.util.timeline_zoom import snap_tick_decimals
from podcast_mcp.util.tracks import dialogue_track_ids, resolve_track

from .boundary import (
    BoundaryContext,
    ClipGeometry,
    RollBoundaryTarget,
    TrimBoundaryTarget,
    assert_boundary_token,
    boundary_context,
)
from .transcript_timing import word_timing_media

log = logging.getLogger(__name__)
T = TypeVar("T")


def _user_transcript_edit(
    track_id: str, fn: Callable[[EpisodeProject], T]
) -> Callable[[EpisodeProject], T]:
    """``ws.mutate`` callback: run ``fn`` as a user edit of ``track_id``'s transcript."""

    def run(p: EpisodeProject) -> T:
        return run_user_transcript_edit(p, track_id, fn)

    return run


def _alignment_preview(plan: AlignmentPlan) -> dict[str, Any]:
    return {
        "proposed_count": len(plan.proposals),
        "proposals": [asdict(proposal) for proposal in plan.proposals],
        "skipped": list(plan.skipped),
    }


class EditService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    def _cleared_ripple(
        self,
        label: str,
        removal: RippleRemoval | None,
        apply: Callable[[EpisodeProject, SpeechClearance], dict],
        *,
        operation: str,
        confirm_cut_speech: bool,
        params: dict[str, Any] | None = None,
    ) -> dict:
        """Run the speech guard on ``removal``, then ``apply`` as one undoable mutation.

        Call inside ``self.ws.transaction()`` with ``removal`` planned on that project.
        Unconfirmed speech returns the confirmation result and changes nothing.
        """
        clearance = clear_ripple(self.ws.project, removal, confirm_cut_speech=confirm_cut_speech)
        if isinstance(clearance, CutSpeechConfirmation):
            return clearance.result(operation)
        return self.ws.mutate(
            f"before {label}",
            f"after {label}",
            lambda p: apply(p, clearance),
            operation=operation,
            params={**(params or {}), "confirm_cut_speech": confirm_cut_speech},
        )

    def _resolve(self, track_id: str | None, speaker: str | None) -> str:
        return resolve_track(self.ws.project, track_id=track_id, speaker=speaker)

    def _require_refine_clear(self) -> None:
        assert_refine_clear(self.ws.project, defaults=load_defaults())

    def build_context(self, max_utterances: int = 200) -> str:
        return build_edit_context_json(self.ws.project, max_utterances=max_utterances)

    def boundary_context(
        self,
        target: TrimBoundaryTarget | RollBoundaryTarget,
        *,
        expected_geometry: list[ClipGeometry] | None = None,
    ) -> BoundaryContext:
        return boundary_context(self.ws.project, target, expected_geometry=expected_geometry)

    def search(
        self,
        query: str,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> list[TranscriptMatch]:
        return search_transcript(self.ws.project, query, track_id=track_id, speaker=speaker)

    def cut_time_range(
        self,
        track_id: str,
        start: float,
        end: float,
        *,
        reason: str = NL_RANGE_REASON,
        review_required: bool = True,
        use_inaudible_opt: bool | None = None,
    ) -> None:
        self._require_refine_clear()
        self.ws.mutate(
            "before cut time range",
            "after cut time range",
            lambda p: cut_time_range(
                p,
                track_id,
                start,
                end,
                reason=reason,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            ),
        )

    def cut_text_match(
        self,
        query: str,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        match_all: bool = False,
        review_required: bool = True,
        use_inaudible_opt: bool | None = None,
    ) -> list[EditDecision]:
        self._require_refine_clear()

        def mutate(p) -> list[EditDecision]:
            return cut_text_match(
                p,
                query,
                track_id=track_id,
                speaker=speaker,
                match_all=match_all,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            )

        return self.ws.mutate("before cut text match", "after cut text match", mutate)

    def cut_utterance(
        self,
        utterance_index: int,
        *,
        review_required: bool = True,
        use_inaudible_opt: bool | None = None,
    ) -> None:
        self._require_refine_clear()
        self.ws.mutate(
            "before cut utterance",
            "after cut utterance",
            lambda p: cut_utterance(
                p,
                utterance_index,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            ),
        )

    def cut_words(
        self,
        track_id: str,
        start_word_index: int,
        end_word_index: int,
        *,
        review_required: bool = True,
        use_inaudible_opt: bool | None = None,
    ) -> None:
        self._require_refine_clear()
        self.ws.mutate(
            "before cut words",
            "after cut words",
            lambda p: cut_words(
                p,
                track_id,
                start_word_index,
                end_word_index,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            ),
        )

    def apply_plan(
        self,
        edits: list[dict[str, Any]],
        *,
        review_required: bool = True,
        use_inaudible_opt: bool | None = None,
    ) -> int:
        self._require_refine_clear()

        def mutate(p) -> int:
            created = apply_edit_plan(
                p,
                edits,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            )
            return len(created)

        return self.ws.mutate("before apply edit plan", "after apply edit plan", mutate)

    def list_decisions(
        self,
        *,
        applied: bool | None = None,
        review_required: bool | None = None,
        reason_prefix: str | None = None,
    ) -> list[EditDecision]:
        return list_edit_decisions(
            self.ws.project,
            applied=applied,
            review_required=review_required,
            reason_prefix=reason_prefix,
        )

    def edit_selected_range(
        self,
        target: ExactRangeTarget,
        action: RangeAction,
        *,
        propose: bool,
        reason: str,
        action_id: str,
        author: str | None = None,
    ) -> RangeEditResult:
        from podcast_mcp.edits.range_edits import edit_selected_range

        return self.ws.mutate(
            "before selected range",
            "after selected range",
            lambda p: edit_selected_range(
                p,
                target,
                action,
                propose=propose,
                reason=reason,
                action_id=action_id,
                author=author,
            ),
            operation="edit_selected_range",
            params={"action_id": action_id, "action": action},
        )

    def selected_range_target(
        self, start: float, end: float, track_ids: list[str]
    ) -> ExactRangeTarget:
        """Seal one timeline interval's current clips on ``track_ids`` for a range edit."""
        from podcast_mcp.edits.range_edits import build_range_target
        from podcast_mcp.models.episode import RangeInterval

        return build_range_target(self.ws.project, [RangeInterval(start=start, end=end)], track_ids)

    def approve(
        self,
        ids: list[str],
        *,
        allow_exact: bool = False,
        confirm_cut_speech: bool = False,
        allow_review: bool = True,
    ) -> int | CutSpeechConfirmation:
        """Apply pending edits; a suggested ripple over other speech asks to confirm first."""

        def mutate(p) -> int:
            selected = [e for e in p.edit_decisions if e.id in ids]
            if not selected or any(e.exact_range is None for e in selected):
                self._require_refine_clear()
            if not allow_exact and any(
                e.id in ids and e.exact_range is not None for e in p.edit_decisions
            ):
                raise PermissionError(
                    "Only the interactive host or an Editor can approve exact range proposals"
                )
            return approve_edits(
                p, ids, confirm_cut_speech=confirm_cut_speech, allow_review=allow_review
            )

        restored = False

        def on_failure(outcome: RollbackOutcome) -> None:
            nonlocal restored
            restored = outcome is RollbackOutcome.RESTORED

        try:
            return self.ws.mutate(
                "before approve edits",
                "after approve edits",
                mutate,
                operation="approve_edits",
                params={"ids": ids, "confirm_cut_speech": confirm_cut_speech},
                on_failure=on_failure,
            )
        except UnconfirmedCutSpeech as asked:
            if restored:
                return asked.confirmation
            raise
        except ScopeChangedAtApproval as held:
            if restored:
                raise held.for_delivery("saved") from held
            raise

    def approve_eligible_tighten(
        self, ids: list[str] | None = None, *, confirm_cut_speech: bool = False
    ) -> dict[str, Any]:
        """Studio Apply eligible with Avoid harsh cuts: approve the non-harsh tighten hits.

        ``ids`` narrows the candidates the way Studio's filtered list does; ``None`` means
        every pending decision. One undo step, like the GUI's single ``ApproveEdits`` batch.
        A batch whose ripples cut another speaker's speech applies nothing and returns
        ``needs_confirmation`` until ``confirm_cut_speech``.
        """
        from podcast_mcp.edits.tighten_hits import eligible_tighten_ids, is_tighten_reason

        with self.ws.transaction() as project:
            wanted = None if ids is None else set(ids)
            listed = [
                d
                for d in project.edit_decisions
                if (wanted is None or d.id in wanted)
                and not d.applied
                and is_tighten_reason(d.reason)
            ]
            eligible = eligible_tighten_ids(listed)
            approved = (
                self.approve(eligible, confirm_cut_speech=confirm_cut_speech, allow_review=False)
                if eligible
                else 0
            )
        skipped = [d.id for d in listed if d.id not in eligible]
        batch = {"ids": eligible, "skipped_harsh": skipped}
        if isinstance(approved, CutSpeechConfirmation):
            return {**approved.result("approve_edits"), **batch}
        return {"operation": "approve_edits", "approved_count": approved, **batch}

    def reject(self, ids: list[str], *, allow_exact: bool = False) -> int:
        def mutate(p) -> int:
            if not allow_exact and any(
                e.id in ids and e.exact_range is not None for e in p.edit_decisions
            ):
                raise PermissionError(
                    "Only the interactive host or an Editor can reject exact range proposals"
                )
            return reject_edits(p, ids)

        return self.ws.mutate("before reject edits", "after reject edits", mutate)

    def preview_pending_cut(self, edit_id: str) -> PendingCutSuggestion:
        return preview_pending_cut_range(self.ws.project, edit_id)

    def update_pending(
        self,
        edit_id: str,
        *,
        start: float,
        end: float,
        snap: bool = True,
        track_ids: list[str] | None = None,
        expected: PendingEditBaseline | None = None,
    ) -> EditDecision:
        def mutate(p) -> EditDecision:
            return update_pending_edit(
                p,
                edit_id,
                start=start,
                end=end,
                snap=snap,
                track_ids=track_ids,
            )

        with self.ws.transaction() as project:
            if expected is not None:
                require_pending_edit_baseline(project, edit_id, expected)
            return self.ws.mutate(
                "before update pending edit",
                "after update pending edit",
                mutate,
                operation="update_pending_edit",
                params={
                    "id": edit_id,
                    "start": start,
                    "end": end,
                    "snap": snap,
                    "track_ids": track_ids,
                    **({"expected": asdict(expected)} if expected is not None else {}),
                },
            )

    def revert_applied(self, record_id: str) -> dict:
        with self.ws.transaction() as project:
            require_applied_edit_restore(project, record_id)
            return self.ws.mutate(
                "before revert applied edit",
                "after revert applied edit",
                lambda p: revert_applied_edit(p, record_id),
                operation="revert_applied_edit",
                params={"id": record_id},
            )

    def impact_report(self, *, markdown: bool = False) -> str | dict:
        report = edit_impact_report(self.ws.project)
        if markdown:
            return format_edit_impact_markdown(report)
        return report

    def propose_tighten(
        self, edit_mode: str | None = None, intensity: str | None = None
    ) -> TightenProposal:
        self._require_refine_clear()

        def mutate(p) -> TightenProposal:
            return propose_tighten_edits(
                p, load_defaults(), edit_mode=edit_mode, intensity=intensity
            )

        return self.ws.mutate("before propose edits", "after propose edits", mutate)

    def apply_auto(self) -> int:
        with self.ws.transaction() as project:
            self._require_refine_clear()
            staged = project.model_copy(deep=True)
            applied = apply_auto_edits(staged)
            if applied == 0:
                return 0
            snapshot = snapshot_from_project(staged)

            def mutate(p) -> int:
                apply_snapshot_to_project(p, snapshot)
                return applied

            return self.ws.mutate(
                "before apply auto edits",
                "after apply auto edits",
                mutate,
                operation="apply_auto_edits",
            )

    def transcript_timestamps(self) -> str:
        return format_transcript_timestamps(self.ws.project)

    def strip_silence(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        threshold_db: float = -40.0,
        min_duration_sec: float = 0.5,
        use_inaudible_opt: bool | None = None,
    ) -> dict:
        """Strip silence islands; ``use_inaudible_opt`` is ignored (API compat)."""
        tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            return strip_silence(
                p,
                tid,
                threshold_db=threshold_db,
                min_duration_sec=min_duration_sec,
                use_inaudible_opt=use_inaudible_opt,
            )

        return self.ws.mutate(
            "before strip silence",
            "after strip silence",
            mutate,
            operation="strip_silence",
            params={
                "track_id": tid,
                "threshold_db": threshold_db,
                "min_duration_sec": min_duration_sec,
                "use_inaudible_opt": use_inaudible_opt,
            },
        )

    def cut_range(
        self,
        start: float,
        end: float,
        *,
        mode: EditMode,
        track_ids: list[str] | None = None,
        use_inaudible_opt: bool | None = None,
        confirm_cut_speech: bool = False,
    ) -> dict:
        """Cut a timeline range: ripple closes it on every track; gap leaves silence.

        ``track_ids`` name whose material the cut means to remove. A ripple asks to
        confirm before it cuts speech on any other track, so with none named it asks
        before cutting anyone's. A gap cut punches only ``track_ids`` (every dialogue
        track when none are named).
        """
        self._require_refine_clear()
        tids = list(track_ids or [])
        if mode is EditMode.GAP:
            return self.ws.mutate(
                "before cut range",
                "after cut range",
                lambda p: punch_delete_range(p, start, end, tids or dialogue_track_ids(p)),
                operation="punch_delete",
                params={"timeline_start": start, "timeline_end": end, "track_ids": tids},
            )
        with self.ws.transaction() as project:
            removal = plan_ripple_delete(
                project,
                start,
                end,
                edited_track_ids=tids,
                use_inaudible_opt=use_inaudible_opt,
            )
            out = self._cleared_ripple(
                "ripple delete",
                removal,
                lambda p, clearance: ripple_delete(
                    p, clearance, params={"use_inaudible_opt": use_inaudible_opt}
                ),
                operation="ripple_delete",
                confirm_cut_speech=confirm_cut_speech,
                params={
                    "timeline_start": start,
                    "timeline_end": end,
                    "track_ids": tids,
                    "use_inaudible_opt": use_inaudible_opt,
                },
            )
        if out.get("needs_confirmation") is not None:
            return out
        # Advisory only - does not block the edit
        try:
            dialogue_ids = dialogue_track_ids(self.ws.project)
            tid = dialogue_ids[0] if dialogue_ids else None
            if tid:
                out = dict(out)
                out["join_quality"] = assess_existing_join(
                    self.ws.project, tid, float(start), timebase="timeline"
                ).to_dict()
        except Exception as exc:
            log.debug("join quality advisory skipped: %s", exc)
        return out

    def preview_inaudible_cut(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start: float,
        end: float,
        timeline: bool = False,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        if timeline:
            opt = optimize_timeline_cut_range(self.ws.project, tid, start, end)
        else:
            opt = optimize_source_cut_range(self.ws.project, tid, start, end)
        return {
            "track_id": tid,
            "timeline_mode": timeline,
            "start": opt.start,
            "end": opt.end,
            "mode": opt.mode,
            "shifted_start_ms": opt.shifted_start_ms,
            "shifted_end_ms": opt.shifted_end_ms,
            "confidence": opt.confidence,
            "details": opt.details,
        }

    def waveform_snap_window(
        self,
        *,
        track_id: str,
        start: float,
        end: float,
        timeline: bool = False,
        focus: float | None = None,
    ) -> dict[str, Any]:
        """Windowed snap ticks for the DAW overlay (non-blocking, capped)."""
        lo = float(start)
        hi = float(end)
        if hi < lo:
            lo, hi = hi, lo
        if hi - lo > 2.0:
            center = float(focus) if focus is not None else (lo + hi) / 2.0
            lo = center - 1.0
            hi = center + 1.0
        if hi - lo < 0.05:
            hi = lo + 0.05
        tid = self._resolve(track_id, None)
        preview: dict[str, Any] | None = None
        try:
            preview = self.preview_inaudible_cut(
                track_id=tid,
                start=lo,
                end=hi,
                timeline=timeline,
            )
        except Exception as exc:
            log.debug("waveform snap preview skipped: %s", exc)
        found: list[SilenceIsland] = []
        if timeline:
            try:
                hops = timeline_rms_hops(self.ws.project, [tid], lo, hi)
                found = silence_islands_from_hops(hops)
            except Exception as exc:
                log.debug("waveform snap islands skipped: %s", exc)
        islands = [i.to_dict() for i in found]
        ticks: list[float] = []
        if preview is not None:
            ticks.extend([float(preview["start"]), float(preview["end"])])
        # Unrounded midpoints: to_dict() rounds to 0.1 ms, too coarse at deep zoom.
        ticks.extend(float(island.midpoint) for island in found)
        # 1 µs (contract `snap_tick_decimals`): ticks stay distinct at near-sample zoom.
        uniq = sorted({round(t, snap_tick_decimals()) for t in ticks})
        return {
            "track_id": tid,
            "start": lo,
            "end": hi,
            "timeline_mode": timeline,
            "preview": preview,
            "islands": islands,
            "ticks": uniq,
        }

    def suggest_handoff_cut(
        self,
        *,
        keep_left_end: float,
        keep_right_start: float,
        track_id: str | None = None,
        speaker: str | None = None,
        quiet_db: float = -48.0,
        min_island_sec: float = 0.12,
        hop_ms: int = 20,
        retain_sec: float = 1.0,
    ) -> dict:
        tids = (
            [self._resolve(track_id, speaker)]
            if track_id is not None or speaker is not None
            else dialogue_track_ids(self.ws.project)
        )
        return suggest_handoff_cut_bounds(
            self.ws.project,
            tids,
            keep_left_end,
            keep_right_start,
            quiet_db=quiet_db,
            min_island_sec=min_island_sec,
            hop_ms=hop_ms,
            retain_sec=retain_sec,
        )

    def join_quality(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        join_sec: float | None = None,
        cut_start: float | None = None,
        cut_end: float | None = None,
        timebase: str = "timeline",
        audio_caches: dict[str, TrackAudioCache] | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        tb: Literal["timeline", "source"] = "timeline" if timebase == "timeline" else "source"
        if cut_start is not None and cut_end is not None:
            return assess_proposed_cut(
                self.ws.project,
                tid,
                float(cut_start),
                float(cut_end),
                timebase=tb,
                audio_caches=audio_caches,
            ).to_dict()
        if join_sec is None:
            raise ValueError("provide join_sec, or cut_start and cut_end")
        return assess_existing_join(
            self.ws.project,
            tid,
            float(join_sec),
            timebase=tb,
        ).to_dict()

    def join_qa_sweep(self, *, track_id: str | None = None) -> dict:
        return assess_project_joins(self.ws.project, track_id=track_id)

    def join_label(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        join_sec: float,
        verdict: str,
        timebase: str = "source",
        note: str = "",
        play: bool = False,
        cut_start: float | None = None,
        cut_end: float | None = None,
    ) -> dict:
        from .play import PlayService

        tid = self._resolve(track_id, speaker)
        if verdict not in ("pass", "fail"):
            raise ValueError("verdict must be pass or fail")
        label_verdict: Literal["pass", "fail"] = "pass" if verdict == "pass" else "fail"
        features = self.join_quality(
            track_id=tid,
            join_sec=join_sec,
            cut_start=cut_start,
            cut_end=cut_end,
            timebase=timebase,
        )
        det_map = {d["name"]: d.get("score", 0.0) for d in features.get("detectors") or []}
        label = record_label(
            self.ws.project,
            track_id=tid,
            join_sec=float(join_sec),
            verdict=label_verdict,
            timebase=timebase,
            cut_start=cut_start,
            cut_end=cut_end,
            note=note,
            features={
                "risk": features.get("risk"),
                "detectors": det_map,
                "neural": features.get("neural"),
            },
            source="human",
        )
        played = False
        if play:
            from .play import PlayRequest

            PlayService(self.ws).play(
                PlayRequest(
                    source=f"processed:{tid}",
                    start_sec=max(0.0, float(join_sec) - 2.0),
                    end_sec=float(join_sec) + 2.0,
                )
            )
            played = True
        return {"label": label.to_dict(), "played": played, "features": features}

    def join_train(
        self,
        *,
        labels_path: Path | None = None,
        out_path: Path | None = None,
    ) -> dict:
        from podcast_mcp.edits.join_labels import load_labels
        from podcast_mcp.edits.join_ranker import save_ranker, train_join_ranker

        labels = load_labels(
            self.ws.project,
            path=labels_path,
        )
        model = train_join_ranker(labels)
        dest = out_path or (self.ws.project.artifacts_dir() / "join_ranker.json")
        save_ranker(model, dest)
        return {"model": model.to_dict(), "path": str(dest), "n_labels": len(labels)}

    def ripple_delete_text(
        self,
        query: str,
        *,
        use_inaudible_opt: bool | None = None,
        confirm_cut_speech: bool = False,
    ) -> dict:
        self._require_refine_clear()
        with self.ws.transaction() as project:
            removal = plan_ripple_delete_text(project, query, use_inaudible_opt=use_inaudible_opt)
            out = self._cleared_ripple(
                "ripple delete text",
                removal,
                lambda p, clearance: ripple_delete(
                    p, clearance, params={"use_inaudible_opt": use_inaudible_opt}
                ),
                operation="ripple_delete_text",
                confirm_cut_speech=confirm_cut_speech,
                params={"query": query, "use_inaudible_opt": use_inaudible_opt},
            )
        return {**out, "query": query}

    def move_segment(self, source_start: float, source_end: float, insert_at: float) -> dict:
        return self.ws.mutate(
            "before move segment",
            "after move segment",
            lambda p: move_segment(p, source_start, source_end, insert_at),
            operation="move_segment",
            params={
                "source_start": source_start,
                "source_end": source_end,
                "insert_at": insert_at,
            },
        )

    def move_by_text(
        self,
        source_query: str,
        destination_query: str,
        position: str = "after",
    ) -> dict:
        return self.ws.mutate(
            "before move by text",
            "after move by text",
            lambda p: move_by_text(p, source_query, destination_query, position),
            operation="move_by_text",
            params={
                "source_query": source_query,
                "destination_query": destination_query,
                "position": position,
            },
        )

    def insert_gap(self, at_time: float, duration_sec: float = 1.0) -> dict:
        return self.ws.mutate(
            "before insert gap",
            "after insert gap",
            lambda p: insert_gap(p, at_time, duration_sec),
            operation="insert_gap",
            params={"at_time": at_time, "duration_sec": duration_sec},
        )

    def fade_joins(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        fade_ms: int | None = None,
        dry_run: bool = False,
    ) -> dict:
        if dry_run:
            return fade_joins(
                self.ws.project,
                track_id=track_id,
                speaker=speaker,
                fade_ms=fade_ms,
                dry_run=True,
            )
        return self.ws.mutate(
            "before fade joins",
            "after fade joins",
            lambda p: fade_joins(
                p,
                track_id=track_id,
                speaker=speaker,
                fade_ms=fade_ms,
            ),
            operation="fade_joins",
            params={
                "track_id": track_id,
                "speaker": speaker,
                "fade_ms": fade_ms,
            },
        )

    def crossfade_joins(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        fade_ms: int | None = None,
        dry_run: bool = False,
    ) -> dict:
        if dry_run:
            return crossfade_joins(
                self.ws.project,
                track_id=track_id,
                speaker=speaker,
                fade_ms=fade_ms,
                dry_run=True,
            )
        return self.ws.mutate(
            "before crossfade joins",
            "after crossfade joins",
            lambda p: crossfade_joins(
                p,
                track_id=track_id,
                speaker=speaker,
                fade_ms=fade_ms,
            ),
            operation="crossfade_joins",
            params={
                "track_id": track_id,
                "speaker": speaker,
                "fade_ms": fade_ms,
            },
        )

    def set_clip_fade(
        self,
        clip_id: str,
        fade_in_ms: int,
        fade_out_ms: int,
        *,
        expected: ClipFadeBaseline | None = None,
    ) -> dict:
        with self.ws.transaction() as project:
            if expected is not None:
                require_clip_fade_baseline(project, clip_id, expected)
            return self.ws.mutate(
                "before set clip fade",
                "after set clip fade",
                lambda p: set_clip_fade(p, clip_id, fade_in_ms, fade_out_ms),
                operation="set_clip_fade",
                params={
                    "clip_id": clip_id,
                    "fade_in_ms": fade_in_ms,
                    "fade_out_ms": fade_out_ms,
                    **({"expected": asdict(expected)} if expected is not None else {}),
                },
            )

    def move_clips(self, clips: list[dict]) -> dict:
        return self.ws.mutate(
            "before move clips",
            "after move clips",
            lambda p: move_clips(p, clips),
            operation="move_clips",
            params={
                "clip_ids": [
                    str(c.get("clip_id"))
                    for c in clips
                    if isinstance(c, dict) and c.get("clip_id") is not None
                ]
            },
        )

    def trim_clip_edge(
        self,
        clip_id: str,
        edge: TrimEdge,
        source_sec: float,
        *,
        mode: EditMode,
        expected_token: str,
        confirm_cut_speech: bool = False,
    ) -> dict:
        """Move one clip edge; a ripple keeps every track in sync and guards their speech."""
        if not math.isfinite(source_sec):
            raise ValueError("source_sec must be finite")
        target = TrimBoundaryTarget.model_validate({"clip_id": clip_id, "edge": edge, "mode": mode})
        with self.ws.transaction() as project:
            assert_boundary_token(project, target, expected_token)
            plan = plan_trim(project, clip_id, edge, source_sec, mode)
            if plan.unchanged:
                return {"operation": "trim_clip_edge", "unchanged": True}
            return self._cleared_ripple(
                "trim clip edge",
                plan.removal,
                lambda p, clearance: trim_clip_edge(p, plan, clearance),
                operation="trim_clip_edge",
                confirm_cut_speech=confirm_cut_speech,
                params={
                    "clip_id": clip_id,
                    "edge": edge,
                    "source_sec": source_sec,
                    "mode": mode.value,
                },
            )

    def roll_clip_join(
        self,
        left_clip_id: str,
        right_clip_id: str,
        delta_sec: float,
        *,
        expected_token: str,
    ) -> dict:
        if not math.isfinite(delta_sec):
            raise ValueError("delta_sec must be finite")
        target = RollBoundaryTarget(left_clip_id=left_clip_id, right_clip_id=right_clip_id)

        def apply(p: EpisodeProject) -> dict:
            assert_boundary_token(p, target, expected_token)
            return roll_clip_join(p, left_clip_id, right_clip_id, delta_sec)

        with self.ws.transaction() as project:
            current = assert_boundary_token(project, target, expected_token)
            bounded = min(max(delta_sec, current.limits.min), current.limits.max)
            if abs(bounded) < 1e-12:
                return {"operation": "roll_clip_join", "unchanged": True}
            return self.ws.mutate(
                "before roll clip join",
                "after roll clip join",
                apply,
                operation="roll_clip_join",
                params={
                    "left_clip_id": left_clip_id,
                    "right_clip_id": right_clip_id,
                    "delta_sec": delta_sec,
                },
            )

    def set_join_mode(self, clip_id: str, join_in_mode: str) -> dict:
        return self.ws.mutate(
            "before set join mode",
            "after set join mode",
            lambda p: set_clip_join_mode(p, clip_id, join_in_mode),
            operation="set_clip_join_mode",
            params={"clip_id": clip_id, "join_in_mode": join_in_mode},
        )

    def set_clip_join(
        self,
        left_clip_id: str,
        right_clip_id: str,
        mode: str,
        length_ms: int | None = None,
    ) -> dict:
        """Set one join's mode and fades in a single undoable step."""
        return self.ws.mutate(
            "before set clip join",
            "after set clip join",
            lambda p: set_clip_join(p, left_clip_id, right_clip_id, mode, length_ms=length_ms),
            operation="set_clip_join",
            params={
                "left_clip_id": left_clip_id,
                "right_clip_id": right_clip_id,
                "mode": mode,
                "length_ms": length_ms,
            },
        )

    def shorten_word_gaps(
        self,
        max_gap_sec: float = 0.35,
        *,
        use_inaudible_opt: bool | None = None,
        confirm_cut_speech: bool = False,
    ) -> dict:
        """Ripple out long pauses; another speaker talking in a pause asks to confirm first."""
        with self.ws.transaction() as project:
            removal = plan_shorten_word_gaps(
                project, max_gap_sec, use_inaudible_opt=use_inaudible_opt
            )
            if removal is None:
                return change_summary(
                    project, operation="shorten_word_gaps", affected_tracks=[], unchanged=True
                )

            def apply(p: EpisodeProject, clearance: SpeechClearance) -> dict:
                report = ripple_delete(
                    p, clearance, params={"use_inaudible_opt": use_inaudible_opt}
                )
                return {**report, "operation": "shorten_word_gaps"}

            return self._cleared_ripple(
                "shorten gaps",
                removal,
                apply,
                operation="shorten_word_gaps",
                confirm_cut_speech=confirm_cut_speech,
                params={"max_gap_sec": max_gap_sec, "use_inaudible_opt": use_inaudible_opt},
            )

    def split_clip(
        self,
        at_time: float,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        track_ids: list[str] | None = None,
    ) -> dict:
        """Split at timeline *at_time* on one or more tracks."""
        if track_ids is not None:
            tids: list[str] | None = list(track_ids)
        elif track_id is not None or speaker is not None:
            tids = [self._resolve(track_id, speaker)]
        else:
            tids = None
        return self.ws.mutate(
            "before split clip",
            "after split clip",
            lambda p: split_clips_at(p, at_time, tids),
        )

    def split_at_time(
        self,
        at_time: float,
        track_ids: list[str] | None = None,
        *,
        propose: bool = False,
        reason: str | None = None,
        author: str | None = None,
    ) -> dict:
        """Blade cut: apply split or append pending ``type=split`` proposal."""

        def mutate(p) -> dict:
            tids = list(track_ids) if track_ids else dialogue_track_ids(p)
            if not tids:
                raise ValueError("no tracks to split")
            if propose:
                decision = append_split_decision(
                    p,
                    float(at_time),
                    tids,
                    reason=reason or GUEST_SUGGEST_SPLIT_REASON,
                    author=author,
                )
                return {"operation": "propose_split", "edit": decision.model_dump()}
            return split_clips_at(p, float(at_time), tids)

        return self.ws.mutate(
            "before split at time",
            "after split at time",
            mutate,
        )

    def delete_clips(
        self,
        clip_ids: list[str],
        *,
        mode: EditMode,
        propose: bool = False,
        reason: str | None = None,
        author: str | None = None,
        confirm_cut_speech: bool = False,
    ) -> dict:
        """Delete clips: ripple closes their spans on every track; gap leaves silence.

        A proposal appends one pending remove per clip. A suggested ripple that would
        cut other speakers' speech records it, so approving it asks to confirm.
        """
        ripple = mode is EditMode.RIPPLE
        if propose:

            def suggest(p: EpisodeProject) -> dict:
                plan_delete_clips(p, clip_ids)
                by_id = {c.id: c for c in p.clips}
                edits = []
                for cid in clip_ids:
                    clip = by_id[cid]
                    decision = append_remove_decision(
                        p,
                        clip.track_id,
                        float(clip.source_start),
                        float(clip.source_end),
                        reason=reason
                        or (
                            GUEST_SUGGEST_RIPPLE_DELETE_REASON
                            if ripple
                            else GUEST_SUGGEST_DELETE_REASON
                        ),
                        review_required=True,
                        applied=False,
                        scope="session" if ripple else "track",
                        author=author,
                    )
                    if ripple:
                        decision.cut_speech = assess_cut_speech(p, plan_delete_clips(p, [cid]))
                    edits.append(decision.model_dump(mode="json"))
                return {"operation": "propose_delete_clips", "mode": mode.value, "edits": edits}

            label = "ripple delete clips" if ripple else "delete clips"
            return self.ws.mutate(f"before {label}", f"after {label}", suggest)
        if not ripple:
            return self.ws.mutate(
                "before delete clips",
                "after delete clips",
                lambda p: punch_delete_clips(p, list(clip_ids)),
                operation="delete_clips",
                params={"clip_ids": list(clip_ids), "mode": mode.value},
            )
        with self.ws.transaction() as project:
            return self._cleared_ripple(
                "ripple delete clips",
                plan_delete_clips(project, clip_ids),
                lambda p, clearance: ripple_delete_clips(p, list(clip_ids), clearance),
                operation="ripple_delete_clips",
                confirm_cut_speech=confirm_cut_speech,
                params={"clip_ids": list(clip_ids), "mode": mode.value},
            )

    def duplicate_segment(self, source_start: float, source_end: float, insert_at: float) -> dict:
        return self.ws.mutate(
            "before duplicate segment",
            "after duplicate segment",
            lambda p: duplicate_segment(p, source_start, source_end, insert_at),
        )

    def copy_segment(self, start: float, end: float, track_ids: list[str] | None = None) -> dict:
        """Studio's clipboard for ``[start, end)``; read-only. ``PasteSegment`` takes it back."""
        return copy_segment(self.ws.project, start, end, track_ids)

    def paste_segment(
        self,
        insert_at: float,
        duration: float,
        extracts: list[dict],
        *,
        mode: EditMode,
    ) -> dict:
        """Paste clips: ripple opens time on every track; gap pastes over in place."""
        return self.ws.mutate(
            "before paste segment",
            "after paste segment",
            lambda p: paste_segment(p, insert_at, duration, extracts, mode=mode),
            operation="paste_segment",
            params={"insert_at": insert_at, "duration": duration, "mode": mode.value},
        )

    def list_clips(self, track_id: str | None = None) -> dict:
        secret = get_share_registry().recording_key_secret()
        return list_clips(self.ws.project, track_id, secret=secret)

    def list_applied_edits(
        self,
        *,
        track_id: str | None = None,
        timeline_start: float | None = None,
        timeline_end: float | None = None,
    ) -> dict:
        records = list_applied_edits(
            self.ws.project,
            track_id=track_id,
            timeline_start=timeline_start,
            timeline_end=timeline_end,
        )
        return {
            "count": len(records),
            "records": [r.model_dump() for r in records],
        }

    def render_status(self) -> dict:
        return render_status_report(self.ws.project)

    def fill_room_tone(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return self.ws.mutate(
            "before fill room tone",
            "after fill room tone",
            lambda p: fill_with_room_tone(p, tid),
        )

    def _guarded_transcript_edit(
        self,
        label: str,
        track_id: str,
        start_word_index: int,
        end_word_index: int,
        expected_text: str | None,
        edit: Callable[[EpisodeProject], T],
    ) -> T:
        """Check ``expected_text`` (#650) and apply ``edit`` in one transaction.

        ``transaction()`` is reentrant, so ``require_word_text`` and the nested ``mutate``
        share one critical section; a stale text raises before mutation or history. Returns
        ``edit``'s result.
        """
        with self.ws.transaction() as project:
            require_word_text(project, track_id, start_word_index, end_word_index, expected_text)
            return self.ws.mutate(
                f"before {label}", f"after {label}", _user_transcript_edit(track_id, edit)
            )

    def word_timing_context(
        self,
        target: WordTimingTarget,
        *,
        expected_text: str | None = None,
        expected_start: float | None = None,
        expected_end: float | None = None,
    ) -> dict[str, Any]:
        """Timing context and token for one word; each given expected value must still hold."""
        with self.ws.transaction() as project:
            transcript = timing_transcript(project, target)
            word = transcript.words[target.word_index]
            expected = (expected_text, expected_start, expected_end)
            actual = (word.text, word.start, word.end)
            if any(e is not None and e != a for e, a in zip(expected, actual, strict=True)):
                raise TranscriptTimingChangedError(
                    "This word changed. Select it again before adjusting timing."
                )
            return word_timing_context(project, target, word_timing_media(project, target))

    def set_word_timing(
        self, target: WordTimingTarget, expected_token: str, start: float, end: float
    ) -> dict[str, Any]:
        with self.ws.transaction() as project:
            timing_transcript(project, target)
            try:
                media = word_timing_media(project, target)
            except (OSError, KeyError) as exc:
                raise TranscriptTimingChangedError(
                    "This recording is unavailable. Reopen Adjust timing."
                ) from exc
            changed = validate_word_timing(project, target, media, expected_token, start, end)
            if changed:
                self.ws.mutate(
                    "before adjust word timing",
                    "after adjust word timing",
                    lambda p: apply_word_timing(p, target, start, end),
                )
            return {"changed": changed, "context": word_timing_context(project, target, media)}

    def preview_transcript_replacement(
        self, search: str, replacement: str, *, match_case: bool = False
    ) -> dict[str, Any]:
        with self.ws.transaction() as project:
            return plan_transcript_replacement(
                project, search, replacement, match_case=match_case
            ).preview()

    def replace_transcript_matches(
        self, search: str, replacement: str, preview_token: str, *, match_case: bool = False
    ) -> int:
        with self.ws.transaction() as project:
            plan = plan_transcript_replacement(project, search, replacement, match_case=match_case)
            if plan.token != preview_token:
                raise TranscriptTextChangedError(
                    "Transcript changed since the preview. Preview again before replacing."
                )
            if not plan.matches:
                return 0
            return self.ws.mutate(
                "before replace transcript matches",
                "after replace transcript matches",
                lambda p: apply_transcript_replacement(p, plan),
            )

    def correct_word(
        self,
        track_id: str,
        word_index: int,
        new_text: str,
        *,
        expected_text: str | None = None,
    ) -> None:
        """Fix one word's text. ``expected_text`` guards against a stale index (#650)."""
        self._guarded_transcript_edit(
            "correct word",
            track_id,
            word_index,
            word_index,
            expected_text,
            lambda p: correct_word(p, track_id, word_index, new_text),
        )

    def correct_phrase(
        self,
        track_id: str,
        start_word_index: int,
        end_word_index: int,
        new_text: str,
        *,
        expected_text: str | None = None,
    ) -> None:
        """Replace a word range's text. ``expected_text`` guards against stale indices (#650)."""
        self._guarded_transcript_edit(
            "correct phrase",
            track_id,
            start_word_index,
            end_word_index,
            expected_text,
            lambda p: correct_phrase(p, track_id, start_word_index, end_word_index, new_text),
        )

    def set_word_suppressed(
        self,
        track_id: str,
        word_index: int,
        suppressed: bool,
        *,
        expected_text: str | None = None,
    ) -> dict:
        """Toggle suppressed on one word. ``expected_text`` guards against a stale index (#744)."""
        return self._guarded_transcript_edit(
            "set word suppressed",
            track_id,
            word_index,
            word_index,
            expected_text,
            lambda p: set_word_suppressed(p, track_id, word_index, suppressed),
        )

    def set_word_automatic(
        self,
        track_id: str,
        word_index: int,
        *,
        expected_text: str | None = None,
    ) -> dict:
        """Clear a word's suppression lock; ``suppressed`` waits for the next reconcile (#824).

        ``expected_text`` guards against a stale index the same as ``set_word_suppressed``.
        """
        return self._guarded_transcript_edit(
            "return word to automatic",
            track_id,
            word_index,
            word_index,
            expected_text,
            lambda p: set_word_automatic(p, track_id, word_index),
        )

    def set_words_ignored(
        self,
        track_id: str,
        start_word_index: int,
        end_word_index: int,
        ignored: bool,
        *,
        expected_text: str | None = None,
    ) -> dict:
        """Text-and-audio hide for a word range, muted at render without a cut (#633).

        ``expected_text`` guards against a stale index range (#744).
        """
        return self._guarded_transcript_edit(
            "set words ignored",
            track_id,
            start_word_index,
            end_word_index,
            expected_text,
            lambda p: set_words_ignored(p, track_id, start_word_index, end_word_index, ignored),
        )

    def low_confidence_words(
        self, threshold: float = DEFAULT_LOW_CONFIDENCE_THRESHOLD
    ) -> list[dict]:
        return list_low_confidence(self.ws.project, threshold)

    def verify_transcript(
        self,
        track_id: str,
        corrections: list[dict[str, Any]],
    ) -> int:
        def mutate(p) -> int:
            return verify_words(p, track_id, corrections)

        return self.ws.mutate(
            "before verify transcript",
            "after verify transcript",
            _user_transcript_edit(track_id, mutate),
        )

    def apply_transcript_cleanup(
        self,
        track_id: str,
        *,
        words: list[dict[str, Any]] | None = None,
        phrases: list[dict[str, Any]] | None = None,
    ) -> int:
        """History-safe batch: word + phrase corrections in one undo step."""

        def mutate(p) -> int:
            return apply_transcript_corrections(p, track_id, words=words, phrases=phrases)

        return self.ws.mutate(
            "before transcript cleanup",
            "after transcript cleanup",
            _user_transcript_edit(track_id, mutate),
        )

    def add_chapter(self, at_time: float, title: str) -> dict:
        def mutate(p) -> dict:
            ch = add_chapter(p, at_time, title)
            return ch.model_dump()

        return self.ws.mutate("before add chapter", "after add chapter", mutate)

    def remove_chapter(self, title: str) -> dict:
        def mutate(p) -> dict:
            ok = remove_chapter(p, title)
            return {"removed": ok, "title": title}

        return self.ws.mutate("before remove chapter", "after remove chapter", mutate)

    def update_chapter(
        self,
        old_time: float,
        old_title: str,
        *,
        time: float,
        title: str,
    ) -> dict:
        def mutate(p) -> dict:
            ch = update_chapter(p, old_time, old_title, time=time, title=title)
            return ch.model_dump()

        return self.ws.mutate("before update chapter", "after update chapter", mutate)

    def delete_chapter(self, time: float, title: str) -> dict:
        def mutate(p) -> dict:
            ok = delete_chapter(p, time, title)
            return {"deleted": ok, "time": time, "title": title}

        return self.ws.mutate("before delete chapter", "after delete chapter", mutate)

    def suggest_pending_edit(
        self,
        track_id: str,
        start: float,
        end: float,
        *,
        reason: str | None = None,
        edit_type: str | None = None,
        author: str | None = None,
    ) -> dict:
        """Guest/host suggest: pending remove or mute decision (review_required)."""
        from podcast_mcp.models import EditDecisionType

        raw = str(edit_type or "remove").strip().lower()
        if raw not in ("remove", "mute"):
            raise ValueError("edit_type must be remove or mute")
        decision_type = EditDecisionType.MUTE if raw == "mute" else EditDecisionType.REMOVE

        def mutate(p) -> dict:
            decision = append_remove_decision(
                p,
                track_id,
                float(start),
                float(end),
                reason=reason or GUEST_SUGGEST_REASON,
                review_required=True,
                applied=False,
                decision_type=decision_type,
                author=author,
            )
            return decision.model_dump()

        return self.ws.mutate(
            "before suggest pending edit",
            "after suggest pending edit",
            mutate,
        )

    def list_chapters(self) -> list[dict]:
        return [c.model_dump() for c in list_chapters(self.ws.project)]

    def check_loudness(self, audio_path: str | None = None) -> dict:
        """Measure audio and report known project freshness without rendering.

        An explicit unrelated file has no project freshness claim (``stale=None``).
        Tracked project audio also reports each dialogue track's balance status. The
        loudness ``pass`` remains the measured level verdict, independent of age.
        """
        from podcast_mcp.engines.balance import balance_status
        from podcast_mcp.engines.mastering import MasterTarget
        from podcast_mcp.engines.play_audit import (
            mastered_is_fresh,
            mastered_path,
            premix_is_stale,
            premix_path,
            read_premix_hash,
        )
        from podcast_mcp.export.names import sanitize_export_stem
        from podcast_mcp.services.pipeline import run_defaults_for

        project = self.ws.project
        target = MasterTarget.from_defaults(run_defaults_for(self.ws.path))
        export_wav = project.export_dir() / f"{sanitize_export_stem(project.name)}.wav"
        premix = premix_path(project)
        path = Path(audio_path) if audio_path else export_wav if export_wav.is_file() else premix
        if not path.is_file():
            raise FileNotFoundError(f"no audio to measure: {path}")
        report = check_loudness(path)
        if path.resolve() == premix.resolve():
            if read_premix_hash(project) is None:
                reason = "premix_unverified"
            elif premix_is_stale(project):
                reason = "premix_stale"
            else:
                reason = None
        elif path.resolve() == export_wav.resolve():
            master = mastered_path(project)
            if not premix.is_file():
                reason = "premix_missing"
            elif read_premix_hash(project) is None:
                reason = "premix_unverified"
            elif premix_is_stale(project):
                reason = "premix_stale"
            elif not master.is_file():
                reason = "master_missing"
            elif not mastered_is_fresh(project, target):
                reason = "master_stale"
            elif path.stat().st_mtime_ns < master.stat().st_mtime_ns:
                reason = "export_older_than_master"
            else:
                reason = None
        else:
            report.update(stale=None, stale_reason="untracked_audio")
            return report
        report.update(stale=reason is not None, stale_reason=reason)
        report["balance"] = {
            track.id: balance_status(project, track)
            for track in project.tracks
            if track.role.value == "dialogue" and track.media is not None
        }
        return report

    def add_effect(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        preset: str | None = None,
        effect: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            if preset:
                chain = apply_preset_to_chain(p, tid, preset)
            elif effect:
                chain = add_effect(p, tid, effect, params)
            else:
                raise ValueError("preset or effect is required")
            return {"track_id": tid, "effects": [e.model_dump() for e in chain.effects]}

        return self.ws.mutate("before add effect", "after add effect", mutate)

    def remove_effect(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        effect: str | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            removed = remove_effect(p, tid, effect)
            return {"track_id": tid, "removed": removed}

        return self.ws.mutate("before remove effect", "after remove effect", mutate)

    def set_effect_bypass(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        effect_index: int,
        bypass: bool,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return self.ws.mutate(
            "before set effect bypass",
            "after set effect bypass",
            lambda p: set_effect_bypass(p, tid, effect_index, bypass),
            operation="set_effect_bypass",
            params={
                "track_id": tid,
                "effect_index": effect_index,
                "bypass": bypass,
            },
        )

    def list_effects(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker) if (track_id or speaker) else None
        if tid:
            return {"track_id": tid, "effects": list_track_effects(self.ws.project, tid)}
        return {"presets": list_presets()}

    def analyze_cleanup(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> dict:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return cleanup_analysis_report(self.ws.project, track_id=tid, progress=progress)

    def audio_diagnostics(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return audio_diagnostics_report(self.ws.project, tid, start_sec=start_sec, end_sec=end_sec)

    def recommend_fades(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return fade_recommendations(self.ws.project, track_id=tid)

    def apply_fade_recommendations(self, recommendations: list[dict]) -> dict:
        return self.ws.mutate(
            "before apply fade recommendations",
            "after apply fade recommendations",
            lambda p: apply_fade_recommendations(p, recommendations),
        )

    def apply_fade_recommendations_for_track(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> dict:
        """Recommend boundary fades for a track (or all), then apply them."""
        recs = self.recommend_fades(track_id=track_id, speaker=speaker)
        if not recs:
            return {"applied_fade_updates": 0, "recommendation_count": 0}
        result = self.apply_fade_recommendations(recs)
        return {**result, "recommendation_count": len(recs)}

    def low_audibility_words(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return audit_low_audibility_words(self.ws.project, track_id=tid, progress=progress)

    def suppress_low_audibility(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        word_keys: list[dict] | None = None,
    ) -> dict:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            return suppress_low_audibility_words(p, track_id=tid, word_keys=word_keys)

        return self.ws.mutate(
            "before suppress low audibility",
            "after suppress low audibility",
            mutate,
        )

    def list_bleed_words(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return bleed_words(
            self.ws.project,
            track_id=tid,
            start_sec=start_sec,
            end_sec=end_sec,
            progress=progress,
        )

    def suppress_bleed(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        word_keys: list[dict] | None = None,
        exclude_word_keys: list[dict] | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        apply: bool = True,
        progress: ProgressReporter | None = None,
    ) -> dict:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)

        if not apply:
            return suppress_bleed_words(
                self.ws.project,
                track_id=tid,
                word_keys=word_keys,
                exclude_word_keys=exclude_word_keys,
                start_sec=start_sec,
                end_sec=end_sec,
                dry_run=True,
                progress=progress,
            )

        def mutate(p) -> dict:
            return suppress_bleed_words(
                p,
                track_id=tid,
                word_keys=word_keys,
                exclude_word_keys=exclude_word_keys,
                start_sec=start_sec,
                end_sec=end_sec,
                dry_run=False,
                progress=progress,
            )

        return self.ws.mutate(
            "before suppress bleed",
            "after suppress bleed",
            mutate,
        )

    def overlap_duplicates(
        self,
        *,
        start_sec: float | None = None,
        end_sec: float | None = None,
        progress: ProgressReporter | None = None,
    ) -> dict:
        return overlap_duplicate_report(
            self.ws.project,
            start_sec=start_sec,
            end_sec=end_sec,
            progress=progress,
        )

    def align_retained_bleed(
        self,
        *,
        track_id: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        apply: bool = True,
        override_placement_lock: bool = False,
        lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC,
    ) -> dict[str, Any]:
        def plan(p: EpisodeProject) -> AlignmentPlan:
            return plan_retained_bleed_alignment(
                p,
                track_id=track_id,
                start_sec=start_sec,
                end_sec=end_sec,
                override_placement_lock=override_placement_lock,
            )

        if not apply:
            return _alignment_preview(plan(self.ws.project))

        def mutate(p: EpisodeProject) -> dict[str, Any]:
            result = apply_retained_bleed_alignment(p, plan(p))
            if result["applied_count"]:
                rerender_preview(p, reconcile=False)
            return result

        with render_lock(self.ws.project, timeout=lock_timeout):
            return self.ws.mutate(
                "before retained bleed alignment", "after retained bleed alignment", mutate
            )

    def set_bleed_alignment_mode(
        self,
        decision_id: str,
        mode: Literal["auto", "manual", "declined"],
        *,
        track_id: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        override_placement_lock: bool = False,
    ) -> dict[str, Any]:
        def mutate(p: EpisodeProject) -> dict[str, Any]:
            proposal = None
            if not any(d.id == decision_id for d in p.editorial.retained_bleed_alignments):
                plan = plan_retained_bleed_alignment(
                    p,
                    track_id=track_id,
                    start_sec=start_sec,
                    end_sec=end_sec,
                    override_placement_lock=override_placement_lock,
                )
                proposal = next(
                    (item for item in plan.proposals if item.decision_id == decision_id), None
                )
            return set_retained_bleed_alignment_mode(p, decision_id, mode, proposal=proposal)

        return self.ws.mutate(
            "before bleed alignment choice", "after bleed alignment choice", mutate
        )

    def apply_bleed_mute(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        apply: bool = True,
        align_retained_bleed: bool = True,
        override_placement_lock: bool = False,
        progress: ProgressReporter | None = None,
        lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC,
        cancel_check: Callable[[], bool] | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker) if track_id or speaker else None

        def run(p: EpisodeProject, *, dry_run: bool) -> dict:
            alignment = None
            if align_retained_bleed:
                plan = plan_retained_bleed_alignment(
                    p,
                    track_id=tid,
                    start_sec=start_sec,
                    end_sec=end_sec,
                    override_placement_lock=override_placement_lock,
                )
                if plan.proposals or plan.skipped:
                    alignment = (
                        _alignment_preview(plan)
                        if dry_run
                        else apply_retained_bleed_alignment(p, plan)
                    )
                    if not dry_run and alignment["applied_count"]:
                        rerender_preview(p, reconcile=False, progress=progress)
            result = apply_transcript_bleed_mute(
                p,
                track_id=tid,
                start_sec=start_sec,
                end_sec=end_sec,
                dry_run=dry_run,
                progress=progress,
            )
            if alignment is not None:
                result["alignment"] = alignment
            return result

        if not apply:
            return run(self.ws.project, dry_run=True)

        with render_lock(self.ws.project, timeout=lock_timeout, cancel_check=cancel_check):
            return self.ws.mutate(
                "before apply bleed mute",
                "after apply bleed mute",
                lambda p: run(p, dry_run=False),
            )

    def gate_overreach(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return gate_overreach_report(self.ws.project, tid, progress=progress)

    def audibility_map(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return build_audibility_map(self.ws.project, track_id=tid, progress=progress)

    def flagged_words(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return list_flagged_transcript_words(self.ws.project, track_id=tid, progress=progress)

    def reconciliation_status(self) -> dict:
        return reconciliation_status_report(self.ws.project)

    def reconcile_transcript(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        dry_run: bool | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        progress: ProgressReporter | None = None,
    ) -> dict:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            return run_reconciliation(
                p,
                dry_run=dry_run,
                track_id=tid,
                start_sec=start_sec,
                end_sec=end_sec,
                progress=progress,
            )

        return self.ws.mutate(
            "before reconcile transcript",
            "after reconcile transcript",
            mutate,
        )
