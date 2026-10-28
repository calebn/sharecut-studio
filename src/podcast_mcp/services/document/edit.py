"""Cuts, approval decisions, tighten proposals and their previews."""

from __future__ import annotations

import logging
from dataclasses import asdict, replace
from typing import Any, TypeVar

from podcast_mcp.config.defaults import unsure_word_confidence
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
    verdict_cache,
)
from podcast_mcp.edits.cut_application import apply_suggested_to_project
from podcast_mcp.edits.cut_policy import review_fields
from podcast_mcp.edits.cut_speech import (
    CutSpeechConfirmation,
    UnconfirmedCutSpeech,
)
from podcast_mcp.edits.decisions import (
    AskedEdits,
    HeldEdit,
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
    GUEST_SUGGEST_REASON,
    NL_RANGE_REASON,
)
from podcast_mcp.edits.join_continuity import (
    assess_existing_join,
)
from podcast_mcp.edits.range_edits import RangeAction, RangeEditResult
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.timeline_ops import (
    plan_ripple_delete,
    plan_ripple_delete_text,
)
from podcast_mcp.edits.transcript_cuts import append_remove_decision
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.edits.transcript_search import TranscriptMatch
from podcast_mcp.edits.unsure_words import hold_unsure_cuts
from podcast_mcp.engines.render_status import render_status_report
from podcast_mcp.models import CutIntent, EditDecision, EditMode
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.project.history.manager import (
    apply_snapshot_to_project,
    snapshot_from_project,
)
from podcast_mcp.project.history.rollback import RollbackOutcome
from podcast_mcp.services.document.service_base import CutMutatingService
from podcast_mcp.services.document.suggested_actions import revise_suggested_actions
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.coded_error import CodedPermissionError, CodedValueError
from podcast_mcp.util.tracks import dialogue_track_ids

from .boundary import (
    BoundaryContext,
    ClipGeometry,
    RollBoundaryTarget,
    TrimBoundaryTarget,
    boundary_context,
)

log = logging.getLogger(__name__)
T = TypeVar("T")


class EditService(CutMutatingService):
    def _require_refine_clear(self) -> None:
        REFINE_GATE.assert_clear(self.ws.project, defaults=self.ws.effective_config())

    def build_context(self, max_utterances: int = 200) -> str:
        return build_edit_context_json(
            self.ws.project, max_utterances=max_utterances, defaults=self.ws.effective_config()
        )

    def boundary_context(
        self,
        target: TrimBoundaryTarget | RollBoundaryTarget,
        *,
        expected_geometry: list[ClipGeometry] | None = None,
    ) -> BoundaryContext:
        return boundary_context(
            self.ws.project,
            target,
            defaults=self.ws.effective_config(),
            expected_geometry=expected_geometry,
        )

    def search(
        self,
        query: str,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> list[TranscriptMatch]:
        return search_transcript(
            self.ws.project,
            query,
            track_id=track_id,
            speaker=speaker,
            defaults=self.ws.effective_config(),
        )

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
                defaults=self.ws.effective_config(),
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
                defaults=self.ws.effective_config(),
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
                defaults=self.ws.effective_config(),
            ),
        )

    def cut_words(
        self,
        track_id: str,
        start_word_index: int,
        end_word_index: int,
        *,
        source_id: str | None = None,
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
                source_id=source_id,
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
                defaults=self.ws.effective_config(),
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
                defaults=self.ws.effective_config(),
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

    def list_decision_rows(self, **filters: Any) -> list[dict[str, Any]]:
        return [e.model_dump() | review_fields(e.reason) for e in self.list_decisions(**filters)]

    def edit_selected_range(
        self,
        target: ExactRangeTarget,
        action: RangeAction,
        *,
        propose: bool,
        reason: str,
        action_id: str,
        author: str | None = None,
        boundary_intent: CutIntent = CutIntent.PROGRAMMATIC,
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
                boundary_intent=boundary_intent,
                defaults=self.ws.effective_config(),
            ),
            operation="edit_selected_range",
            params={"action_id": action_id, "action": action},
        )

    def selected_range_target(
        self, start: float, end: float, track_ids: list[str]
    ) -> ExactRangeTarget:
        """Seal one timeline interval's current clips on ``track_ids`` for a range edit."""
        from podcast_mcp.edits.range_target import build_range_target
        from podcast_mcp.models.episode import RangeInterval

        return build_range_target(self.ws.project, [RangeInterval(start=start, end=end)], track_ids)

    def held_by_checks(
        self, ids: list[str] | None = None
    ) -> tuple[list[HeldEdit], list[AskedEdits]]:
        """Which pending proposals the audio checks would hold, found on a private copy.

        Nothing is saved: this is Approve all run on a scratch copy, so each held edit comes
        with the reason the real approval would give.
        """
        from podcast_mcp.edits.cut_application import approve_edits as apply_on_copy

        scratch = self.ws.project.model_copy(deep=True)
        wanted = (
            ids
            if ids is not None
            else [e.id for e in list_edit_decisions(scratch, applied=False, review_required=True)]
        )
        held: list[HeldEdit] = []
        asked: list[AskedEdits] = []
        try:
            apply_on_copy(
                scratch, wanted, held_out=held, asked_out=asked, defaults=self.ws.effective_config()
            )
        except ScopeChangedAtApproval as refused:
            # A batch that is not partial still refuses whole on a hold;
            # for a listing, name each hold instead of failing.
            listed = {item.edit_id for item in held}
            held.extend(
                HeldEdit(
                    hold.edit_id,
                    refused.cuts.get(hold.edit_id) or self._edit_label(hold.edit_id),
                    refused.reason_for(hold),
                )
                for hold in refused.held
                if hold.edit_id not in listed
            )
        return held, asked

    def warm_approval_checks(self) -> int:
        """Check the pending cuts now, as the host's Approve all will, so that approval reuses them.

        Nothing is saved. Uses the interactive intent the host approves with, which is part of
        the check; returns how many cuts were checked, 0 while the verdict cache is off (#1958).
        """
        from podcast_mcp.edits.cut_application import precompute_verdicts

        ids = [
            e.id for e in list_edit_decisions(self.ws.project, applied=False, review_required=True)
        ]
        return precompute_verdicts(
            self.ws.project,
            ids,
            defaults=self.ws.effective_config(),
            application_intent=CutIntent.HUMAN_BOUNDARIES,
            yield_to_approval=True,
        )

    def _all_unplayed(self, ids: list[str], held_out: list[HeldEdit]) -> bool:
        """True (after listing them as held) when every selected proposal's audio is cut away."""
        from podcast_mcp.edits.decisions import unplayed_pending_ids
        from podcast_mcp.edits.source_removals import STALE_REASON

        project = self.ws.project
        selected = {e.id for e in project.edit_decisions if e.id in set(ids)}
        stale = set(unplayed_pending_ids(project, selected))
        if not selected or stale != selected:
            return False
        held_out.extend(HeldEdit(i, self._edit_label(i), STALE_REASON) for i in sorted(stale))
        return True

    def _edit_label(self, edit_id: str) -> str:
        from podcast_mcp.edits.source_removals import cut_label

        edit = next((e for e in self.ws.project.edit_decisions if e.id == edit_id), None)
        return cut_label(self.ws.project, edit) if edit is not None else edit_id

    def approve(
        self,
        ids: list[str],
        *,
        allow_exact: bool = False,
        application_intent: CutIntent = CutIntent.PROGRAMMATIC,
        held_out: list[HeldEdit] | None = None,
        asked_out: list[AskedEdits] | None = None,
        override_peer_holds: set[str] | None = None,
        unsure_out: list[HeldEdit] | None = None,
    ) -> int | CutSpeechConfirmation:
        """Apply pending edits with fresh complete-effect assessment.

        Trusted interactive intent overrides acoustic holds only. With ``held_out``,
        independent accepted edits may apply while held edits stay pending. ``asked_out``
        additionally carries removed-speech evidence for later interactive review.
        ``unsure_out`` is the bulk guard (``skip_unsure``): a pending cut that covers an
        unsure transcript word is not applied, stays pending and is listed there with
        reason ``unsure_word``; the rest apply as one history step.
        """
        line = unsure_word_confidence(self.ws.effective_config())
        if unsure_out is not None:
            with self.ws.transaction():  # the saved words decide, not the caller's view
                ids = hold_unsure_cuts(self.ws.project, ids, line, unsure_out)
            if not ids:
                return 0  # nothing left to apply: nothing to save or undo

        def mutate(p) -> int:
            nonlocal ids
            if unsure_out is not None:  # a save since the check above can add an unsure word
                ids = hold_unsure_cuts(p, ids, line, unsure_out)
            selected = [e for e in p.edit_decisions if e.id in ids]
            if not selected or any(e.exact_range is None for e in selected):
                self._require_refine_clear()
            if not allow_exact and any(
                e.id in ids and e.exact_range is not None for e in p.edit_decisions
            ):
                raise CodedPermissionError(
                    "Only the interactive host or an Editor can approve exact range proposals",
                    code="exact_range_needs_editor",
                )
            return approve_edits(
                p,
                ids,
                application_intent=application_intent,
                held_out=held_out,
                asked_out=asked_out,
                override_peer_holds=override_peer_holds,
                defaults=self.ws.effective_config(),
            )

        restored = False

        def on_failure(outcome: RollbackOutcome) -> None:
            nonlocal restored
            restored = outcome is RollbackOutcome.RESTORED

        if held_out is not None and self._all_unplayed(ids, held_out):
            # Nothing in the selection can apply, so there is nothing to save or undo.
            return 0

        try:
            with verdict_cache.approving(), batch_scope():
                return self.ws.mutate(
                    "before approve edits",
                    "after approve edits",
                    mutate,
                    operation="approve_edits",
                    params={"ids": ids},
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

    def apply_suggested_actions(
        self,
        ids: list[str] | None = None,
        *,
        overrides: dict[str, str] | None = None,
        revise: bool = False,
        application_intent: CutIntent = CutIntent.PROGRAMMATIC,
    ) -> dict[str, Any]:
        """Apply every pending sound's own suggested action in one undoable step.

        Cut and shorten cut (a cut the speech guard would hold for another speaker applies
        as the session ripple across every dialogue track, and the result counts it), lower
        turns a laugh down under the speaker talking over it, leave dismisses the proposal.
        ``ids`` narrows the batch like Studio's filtered list; ``overrides`` maps a decision
        id to another action (``cut`` / ``shorten`` / ``lower`` / ``leave``) for that sound.
        ``revise`` changes sounds of the batch you just applied: it steps back to before
        that batch, which must be the latest edit, and applies it again with ``overrides``
        on top of the actions it used, so every other sound keeps its action and the result
        is again one undo step. A sound the new action cannot apply (a held cut) comes back
        pending and is named in ``held``; when none can apply the call refuses and keeps the batch.
        """
        from podcast_mcp.edits.cut_policy import SUGGESTED_ACTIONS, decision_policy
        from podcast_mcp.edits.suggested_actions import (
            SuggestedActionsResult,
            describe_sounds,
        )

        wanted = None if ids is None else set(ids)
        overrides = dict(overrides or {})
        bad = sorted(a for a in overrides.values() if a not in SUGGESTED_ACTIONS)
        if bad:
            raise CodedValueError(
                f"unknown action {bad[0]!r}; use one of {', '.join(SUGGESTED_ACTIONS)}",
                code="unknown_sound_action",
            )
        if revise:
            if ids is not None:
                raise CodedValueError(
                    "revise re-applies the whole latest batch; give overrides, not ids",
                    code="revise_takes_no_ids",
                )
            return self._revise_suggested_actions(overrides, application_intent)

        def pending(e: EditDecision) -> bool:
            return (
                (wanted is None or e.id in wanted)
                and not e.applied
                and (decision_policy(e) is not None)
            )

        result = SuggestedActionsResult()
        with self.ws.transaction() as project:
            listed = [e for e in project.edit_decisions if pending(e)]
            actions: dict[str, str] = {
                e.id: overrides.get(e.id) or policy.action
                for e in listed
                if (policy := decision_policy(e)) is not None
            }
            cut_ids = [e.id for e in listed if actions[e.id] in ("cut", "shorten")]
            if cut_ids:
                self._require_refine_clear()
            with batch_scope():
                self.ws.mutate(
                    "before apply suggested actions",
                    "after apply suggested actions",
                    lambda p: apply_suggested_to_project(
                        p,
                        actions,
                        result,
                        application_intent=application_intent,
                        defaults=self.ws.effective_config(),
                    ),
                    operation="apply_suggested_actions",
                    params={
                        "ids": sorted(actions),
                        "requested": dict(actions),
                        "sounds": describe_sounds(
                            project, listed, actions, defaults=self.ws.effective_config()
                        ),
                    },
                )
        return {"operation": "apply_suggested_actions", **result.to_payload()}

    def _revise_suggested_actions(
        self, overrides: dict[str, str], application_intent: CutIntent
    ) -> dict[str, Any]:
        return revise_suggested_actions(
            self.ws, self.apply_suggested_actions, overrides, application_intent
        )

    def reject(self, ids: list[str], *, allow_exact: bool = False) -> int:
        def mutate(p) -> int:
            if not allow_exact and any(
                e.id in ids and e.exact_range is not None for e in p.edit_decisions
            ):
                raise CodedPermissionError(
                    "Only the interactive host or an Editor can reject exact range proposals",
                    code="exact_range_needs_editor",
                )
            return reject_edits(p, ids)

        return self.ws.mutate("before reject edits", "after reject edits", mutate)

    def preview_pending_cut(self, edit_id: str) -> PendingCutSuggestion:
        return preview_pending_cut_range(
            self.ws.project, edit_id, defaults=self.ws.effective_config()
        )

    def update_pending(
        self,
        edit_id: str,
        *,
        start: float,
        end: float,
        snap: bool = True,
        track_ids: list[str] | None = None,
        expected: PendingEditBaseline | None = None,
        boundary_intent: CutIntent = CutIntent.PROGRAMMATIC,
    ) -> EditDecision:
        def mutate(p) -> EditDecision:
            return update_pending_edit(
                p,
                edit_id,
                start=start,
                end=end,
                snap=snap,
                track_ids=track_ids,
                boundary_intent=boundary_intent,
                defaults=self.ws.effective_config(),
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
                lambda p: revert_applied_edit(p, record_id, defaults=self.ws.effective_config()),
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
                p, self.ws.effective_config(), edit_mode=edit_mode, intensity=intensity
            )

        proposal = self.ws.mutate("before propose edits", "after propose edits", mutate)
        return self._with_audio_check(proposal)

    def _with_audio_check(self, proposal: TightenProposal) -> TightenProposal:
        """Run Approve all on a scratch copy and record which proposals it would hold.

        A proposal the approval then refuses is not offered as ready: each carries its reason.
        Nothing is saved. When the audio cannot be read the proposal is returned unchecked.
        """
        ids = [d.id for d in proposal.decisions]
        if not ids:
            return proposal
        reasons: dict[str, str] = {}
        try:
            remaining = ids
            # A hold leaves its neighbours out of the listing (they wait with it), so the rest
            # are checked again without it until a pass finds nothing more.
            while remaining:
                held, asked = self.held_by_checks(remaining)
                found = {h.edit_id: h.reason for h in held}
                for group in asked:
                    for edit_id in group.edit_ids:
                        found.setdefault(edit_id, group.confirmation.message)
                if not found:
                    break
                reasons.update(found)
                remaining = [i for i in remaining if i not in reasons]
        except Exception:  # advisory: the proposals are saved, the check must not fail the call
            log.warning("propose_edits: could not run the approval check", exc_info=True)
            return proposal
        return replace(proposal, held=reasons, checked=True)

    def apply_auto(self) -> int:
        with self.ws.transaction() as project:
            self._require_refine_clear()
            staged = project.model_copy(deep=True)
            applied = apply_auto_edits(staged, defaults=self.ws.effective_config())
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
        return format_transcript_timestamps(self.ws.project, defaults=self.ws.effective_config())

    def cut_range(
        self,
        start: float,
        end: float,
        *,
        mode: EditMode,
        track_ids: list[str] | None = None,
        use_inaudible_opt: bool | None = None,
        application_intent: CutIntent = CutIntent.PROGRAMMATIC,
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
            with self.ws.transaction() as project:
                selected = tids or dialogue_track_ids(project)
                return self._apply_cut(
                    "cut range",
                    plan_ripple_delete(
                        project,
                        start,
                        end,
                        edited_track_ids=selected,
                        use_inaudible_opt=False,
                        defaults=self.ws.effective_config(),
                    ),
                    operation="punch_delete",
                    application_intent=application_intent,
                    ripple=False,
                    params={"timeline_start": start, "timeline_end": end, "track_ids": selected},
                )
        with self.ws.transaction() as project:
            removal = plan_ripple_delete(
                project,
                start,
                end,
                edited_track_ids=tids,
                use_inaudible_opt=use_inaudible_opt,
                defaults=self.ws.effective_config(),
            )
            out = self._apply_cut(
                "ripple delete",
                removal,
                operation="ripple_delete",
                application_intent=application_intent,
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
                    self.ws.project,
                    tid,
                    float(start),
                    timebase="timeline",
                    defaults=self.ws.effective_config(),
                ).to_dict()
        except Exception as exc:
            log.debug("join quality advisory skipped: %s", exc)
        return out

    def ripple_delete_text(
        self,
        query: str,
        *,
        use_inaudible_opt: bool | None = None,
    ) -> dict:
        self._require_refine_clear()
        with self.ws.transaction() as project:
            removal = plan_ripple_delete_text(
                project,
                query,
                use_inaudible_opt=use_inaudible_opt,
                defaults=self.ws.effective_config(),
            )
            out = self._apply_cut(
                "ripple delete text",
                removal,
                operation="ripple_delete_text",
                params={"query": query, "use_inaudible_opt": use_inaudible_opt},
            )
        return {**out, "query": query}

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
        return render_status_report(self.ws.project, defaults=self.ws.effective_config())

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
            raise CodedValueError("edit_type must be remove or mute", code="edit_type_invalid")
        decision_type = EditDecisionType.MUTE if raw == "mute" else EditDecisionType.REMOVE

        def mutate(p) -> dict:
            decision = append_remove_decision(
                p,
                track_id,
                float(start),
                float(end),
                reason=reason or GUEST_SUGGEST_REASON,
                review_required=True,
                decision_type=decision_type,
                author=author,
                defaults=self.ws.effective_config(),
            )
            return decision.model_dump()

        return self.ws.mutate(
            "before suggest pending edit",
            "after suggest pending edit",
            mutate,
        )
