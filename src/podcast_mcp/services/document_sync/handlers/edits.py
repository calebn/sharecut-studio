"""Document-plane edit-decision command handlers."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.bleed_restore_targets import BleedRestoreTarget
from podcast_mcp.edits.clip_fades import ClipFadeBaseline
from podcast_mcp.edits.cut_speech import CutSpeechConfirmation
from podcast_mcp.edits.decisions import AskedEdits, HeldEdit, PendingEditBaseline
from podcast_mcp.models import CutIntent, EditMode
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService, EditService, TimelineService
from podcast_mcp.util.coded_error import CodedValueError


def approve_edits(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    ids = list(p["ids"])
    hold_blocked = p.get("hold_blocked") is True
    held: list[HeldEdit] = []
    asked: list[AskedEdits] = []
    before = {e.id for e in ws.project.edit_decisions}
    outcome = EditService(ws).approve(
        ids,
        allow_exact=p.get("_allow_exact") is True,
        application_intent=CutIntent(p.get("_boundary_intent", CutIntent.PROGRAMMATIC)),
        held_out=held if hold_blocked else None,
        asked_out=asked if hold_blocked else None,
    )
    if isinstance(outcome, CutSpeechConfirmation):
        return outcome.result("approve_edits")
    if not hold_blocked:
        return {"count": outcome}
    result: dict[str, Any] = {
        "count": outcome,
        "held": [{"id": h.edit_id, "label": h.label, "reason": h.reason} for h in held],
    }
    if asked:
        result["needs_confirmation"] = asked[0].confirmation.model_dump(mode="json")
        result["confirm_ids"] = list(asked[0].edit_ids)
    # The history commit retires unplayed pending cuts, so a held stale cut can vanish unapplied.
    held_or_asked = {h.edit_id for h in held} | {i for a in asked for i in a.edit_ids}
    after = {e.id for e in ws.project.edit_decisions}
    # dict.fromkeys dedupes the requested ids and keeps their order.
    result["approved_ids"] = [
        i for i in dict.fromkeys(ids) if i in before and i not in after and i not in held_or_asked
    ]
    return result


def apply_suggested_actions(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    ids = p.get("ids")
    return EditService(ws).apply_suggested_actions(
        list(ids) if ids is not None else None,
        overrides=dict(p.get("overrides") or {}),
        revise=p.get("revise") is True,
        application_intent=p["_boundary_intent"],
    )


def reject_edits(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    ids = list(p["ids"])
    count = EditService(ws).reject(ids, allow_exact=p.get("_allow_exact") is True)
    return {"count": count}


def update_pending_edit(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_ids = p.get("track_ids")
    expected = p.get("expected")
    edit = EditService(ws).update_pending(
        p["id"],
        start=float(p["start"]),
        end=float(p["end"]),
        snap=bool(p.get("snap", True)),
        track_ids=[str(t) for t in track_ids] if track_ids is not None else None,
        expected=PendingEditBaseline(**expected) if expected is not None else None,
        boundary_intent=CutIntent(p.get("_boundary_intent", CutIntent.PROGRAMMATIC)),
    )
    return {"edit": edit.model_dump()}


def restore_applied_edit(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).revert_applied(p["id"])


def restore_clip_bleed(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return dict(
        TimelineService(ws).restore_clip_bleed(BleedRestoreTarget.model_validate(p["target"]))
    )


def set_clip_fade(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).set_clip_fade(
        p["clip_id"],
        int(p["fade_in_ms"]),
        int(p["fade_out_ms"]),
        expected=ClipFadeBaseline(**p["expected"]),
    )


def trim_clip_edge(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).trim_clip_edge(
        p["clip_id"],
        p["edge"],
        float(p["source_sec"]),
        mode=EditMode(p["mode"]),
        expected_token=str(p["expected_token"]),
        application_intent=CutIntent(p.get("_boundary_intent", CutIntent.PROGRAMMATIC)),
    )


def roll_clip_join(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).roll_clip_join(
        str(p["left_clip_id"]),
        str(p["right_clip_id"]),
        float(p["delta_sec"]),
        expected_token=str(p["expected_token"]),
    )


def set_join_mode(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).set_join_mode(p["clip_id"], str(p["join_in_mode"]))


def set_clip_join(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    length = p.get("length_ms")
    return TimelineService(ws).set_clip_join(
        str(p["left_clip_id"]),
        str(p["right_clip_id"]),
        str(p["mode"]),
        int(length) if length is not None else None,
    )


def apply_fade_recommendations(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_id = p.get("track_id")
    return AnalysisService(ws).apply_fade_recommendations_for_track(
        track_id=str(track_id) if track_id else None,
    )


def apply_fade_recommendation_list(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return AnalysisService(ws).apply_fade_recommendations(p["recommendations"])


def stage_time_range_cut(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    kwargs = {"reason": p["reason"]} if p.get("reason") is not None else {}
    EditService(ws).cut_time_range(
        str(p["track_id"]),
        float(p["start"]),
        float(p["end"]),
        review_required=p.get("review_required") is not False,
        use_inaudible_opt=p.get("use_inaudible_opt"),
        **kwargs,
    )
    return {}


def stage_text_match_cut(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    EditService(ws).cut_text_match(
        str(p["query"]),
        track_id=p.get("track_id"),
        speaker=p.get("speaker"),
        match_all=p.get("match_all") is True,
        review_required=p.get("review_required") is not False,
        use_inaudible_opt=p.get("use_inaudible_opt"),
    )
    return {"edits": [e.model_dump() for e in ws.project.edit_decisions[-5:]]}


def stage_utterance_cut(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    EditService(ws).cut_utterance(
        int(p["utterance_index"]),
        review_required=p.get("review_required") is not False,
        use_inaudible_opt=p.get("use_inaudible_opt"),
    )
    return {}


def stage_words_cut(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    EditService(ws).cut_words(
        str(p["track_id"]),
        int(p["start_word_index"]),
        int(p["end_word_index"]),
        source_id=p.get("source_id"),
        review_required=p.get("review_required") is not False,
        use_inaudible_opt=p.get("use_inaudible_opt"),
    )
    return {}


def add_effect(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return AnalysisService(ws).add_effect(
        track_id=str(p["track_id"]),
        preset=p.get("preset"),
        effect=p.get("effect"),
        params=p.get("params"),
    )


def reconcile_transcript(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return AnalysisService(ws).reconcile_transcript(
        track_id=p.get("track_id"),
        speaker=p.get("speaker"),
        dry_run=p.get("dry_run"),
        start_sec=p.get("start_sec"),
        end_sec=p.get("end_sec"),
    )


def suppress_bleed(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return AnalysisService(ws).suppress_bleed(
        track_id=p.get("track_id"),
        speaker=p.get("speaker"),
        word_keys=p.get("words"),
        exclude_word_keys=p.get("exclude_words"),
        start_sec=p.get("start_sec"),
        end_sec=p.get("end_sec"),
        apply=True,
    )


def suppress_low_audibility(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return AnalysisService(ws).suppress_low_audibility(
        track_id=p.get("track_id"), speaker=p.get("speaker"), word_keys=p.get("words")
    )


def set_bleed_alignment_mode(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return AnalysisService(ws).set_bleed_alignment_mode(
        str(p["decision_id"]),
        p["mode"],
        track_id=p.get("track_id"),
        start_sec=p.get("start_sec"),
        end_sec=p.get("end_sec"),
        override_placement_lock=p.get("override_placement_lock") is True,
    )


def remove_effect(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return AnalysisService(ws).remove_effect(track_id=str(p["track_id"]), effect=p.get("effect"))


def set_effect_bypass(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return AnalysisService(ws).set_effect_bypass(
        track_id=str(p["track_id"]),
        effect_index=int(p["effect_index"]),
        bypass=bool(p["bypass"]),
    )


def split_at_time(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    from podcast_mcp.services.document_sync.policy import (
        StructuralMutationMode,
        structural_mode_from_payload,
    )

    mode = structural_mode_from_payload(p)
    track_ids = p.get("track_ids")
    tids = [str(t) for t in track_ids] if track_ids is not None else None
    reason = str(p["reason"]) if p.get("reason") is not None else None
    return TimelineService(ws).split_at_time(
        float(p["at_time"]),
        tids,
        propose=mode is StructuralMutationMode.PROPOSE,
        reason=reason,
        author=p.get("_author"),
    )


def delete_clip(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    from podcast_mcp.services.document_sync.policy import (
        StructuralMutationMode,
        structural_mode_from_payload,
    )

    structural = structural_mode_from_payload(p)
    clip_ids = p.get("clip_ids")
    if clip_ids is None and p.get("clip_id") is not None:
        clip_ids = [p["clip_id"]]
    if not clip_ids:
        raise CodedValueError("clip_id or clip_ids required", code="clip_ids_required")
    reason = str(p["reason"]) if p.get("reason") is not None else None
    return TimelineService(ws).delete_clips(
        [str(c) for c in clip_ids],
        mode=EditMode(p["mode"]),
        propose=structural is StructuralMutationMode.PROPOSE,
        reason=reason,
        author=p.get("_author"),
        application_intent=CutIntent(p.get("_boundary_intent", CutIntent.PROGRAMMATIC)),
    )


def duplicate_segment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).duplicate_segment(
        float(p["source_start"]),
        float(p["source_end"]),
        float(p["insert_at"]),
    )


def move_segment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).move_segment(
        float(p["source_start"]),
        float(p["source_end"]),
        float(p["insert_at"]),
    )


def insert_gap(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).insert_gap(float(p["at_time"]), float(p.get("duration_sec", 1.0)))


def fill_room_tone(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).fill_room_tone(
        track_id=str(p["track_id"]), within=(float(p["start_sec"]), float(p["end_sec"]))
    )


def fade_joins(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).fade_joins(
        track_id=p.get("track_id"), speaker=p.get("speaker"), fade_ms=p.get("fade_ms")
    )


def crossfade_joins(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).crossfade_joins(
        track_id=p.get("track_id"), speaker=p.get("speaker"), fade_ms=p.get("fade_ms")
    )


def move_by_text(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).move_by_text(
        str(p["source_query"]), str(p["destination_query"]), str(p.get("position", "after"))
    )


def move_clips(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    raw = p.get("clips") or []
    if not isinstance(raw, list):
        raise CodedValueError("clips must be a list", code="clips_not_list")
    clips = [dict(x) if not isinstance(x, dict) else x for x in raw]
    return TimelineService(ws).move_clips(clips)


def paste_segment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    extracts = p.get("extracts") or []
    if not isinstance(extracts, list):
        raise CodedValueError("extracts must be a list", code="extracts_not_list")
    return TimelineService(ws).paste_segment(
        float(p["insert_at"]),
        float(p["duration"]),
        [dict(x) for x in extracts],
        mode=EditMode(p["mode"]),
    )


def cut_range(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    """Cut a timeline range (clipboard cut) in the payload's edit mode. Apply-only."""
    return EditService(ws).cut_range(
        float(p["start"]),
        float(p["end"]),
        mode=EditMode(p["mode"]),
        track_ids=[str(t) for t in p.get("track_ids") or []],
        use_inaudible_opt=p.get("use_inaudible_opt"),
        application_intent=CutIntent(p.get("_boundary_intent", CutIntent.PROGRAMMATIC)),
    )


def ripple_delete_text(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).ripple_delete_text(
        p["query"], use_inaudible_opt=p.get("use_inaudible_opt")
    )


def edit_selected_range(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    from podcast_mcp.models.episode import ExactRangeTarget

    return dict(
        EditService(ws).edit_selected_range(
            ExactRangeTarget.model_validate(p["target"]),
            p["action"],
            propose=p.get("_range_policy") != "apply",
            reason=p.get("_range_reason", "agent:range"),
            action_id=p["_action_id"],
            author=p.get("_author"),
            boundary_intent=CutIntent(p.get("_boundary_intent", CutIntent.PROGRAMMATIC)),
        )
    )
