from __future__ import annotations

from typing import Any

from mcp.server import MCPServer

from podcast_mcp.edits.cut_speech import APPLY_ANYWAY
from podcast_mcp.edits.edit_reasons import NL_RANGE_REASON
from podcast_mcp.mcp.args import JsonObjectList
from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.mcp.tools.agent_notify import agent_mutated
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService, EditService, TimelineService
from podcast_mcp.services.document_sync import (
    host_command_result,
    submit_host_command_result,
    submit_host_document_command,
)
from podcast_mcp.util.coded_error import CodedValueError


def propose_range_mute_tool(project_path: str, target: dict[str, Any], command_id: str) -> str:
    """Propose an exact range mute for host review, with replay-safe command identity.

    Pass a serialized ExactRangeTarget from bleed preview or the range editor.
    This never applies audio or approves the proposal. Reuse command_id only
    when retrying the same target. The host auditions and approves or rejects it.
    """
    return to_json(
        submit_host_document_command(
            project_path,
            "EditSelectedRange",
            {"target": target, "action": "mute"},
            command_id=command_id,
        )
    )


def propose_range_cut_tool(
    project_path: str,
    start: float,
    end: float,
    command_id: str,
    track_ids: list[str] | None = None,
) -> str:
    """Propose an exact range cut for host review (Studio range Cut), replay-safe.

    ``start`` / ``end`` are timeline seconds; ``track_ids`` lists the lanes
    (default every dialogue lane). The cut leaves a hole: later clips keep their places.
    This never applies audio: it creates a pending exact cut that the host auditions and
    approves (``podcast edit approve`` also can). Reuse command_id only when retrying the
    same range. For a ripple cut across lanes use ``ripple_delete_tool``.
    """
    from podcast_mcp.util.tracks import dialogue_track_ids

    ws = ProjectWorkspace.open(project_path)
    lanes = track_ids if track_ids is not None else dialogue_track_ids(ws.project)
    target = EditService(ws).selected_range_target(start, end, lanes)
    reply = submit_host_document_command(
        project_path,
        "EditSelectedRange",
        {"target": target.model_dump(mode="json"), "action": "cut"},
        command_id=command_id,
    )
    return to_json(host_command_result(reply))


def build_edit_context(project_path: str, max_utterances: int = 200) -> str:
    """Build the JSON edit-planning context: utterances with word indexes for cut_* tools."""
    ws = ProjectWorkspace.open(project_path)
    return EditService(ws).build_context(max_utterances=max_utterances)


def search_transcript_tool(
    project_path: str,
    query: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """Search the transcript for text, optionally scoped to a track or speaker."""
    ws = ProjectWorkspace.open(project_path)
    matches = EditService(ws).search(query, track_id=track_id, speaker=speaker)
    return to_json([m.__dict__ for m in matches])


def cut_time_range_tool(
    project_path: str,
    track_id: str,
    start: float,
    end: float,
    reason: str = NL_RANGE_REASON,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
) -> str:
    """Stage a pending cut of a time range on a track; applies after approve_edits."""
    submit_host_command_result(
        project_path,
        "StageTimeRangeCut",
        {
            "track_id": track_id,
            "start": start,
            "end": end,
            "reason": reason,
            "review_required": review_required,
            "use_inaudible_opt": use_inaudible_opt,
        },
    )
    return to_json({"track_id": track_id, "start": start, "end": end})


def cut_text_match_tool(
    project_path: str,
    query: str,
    track_id: str | None = None,
    speaker: str | None = None,
    match_all: bool = False,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
) -> str:
    """Stage a pending cut for the first text match, or every match with match_all=True."""
    submit_host_command_result(
        project_path,
        "StageTextMatchCut",
        {
            "query": query,
            "track_id": track_id,
            "speaker": speaker,
            "match_all": match_all,
            "review_required": review_required,
            "use_inaudible_opt": use_inaudible_opt,
        },
    )
    ws = ProjectWorkspace.open(project_path)
    return to_json([e.model_dump() for e in ws.project.edit_decisions[-5:]])


def cut_utterance_tool(
    project_path: str,
    utterance_index: int,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
) -> str:
    """Stage a pending cut of one utterance by its index."""
    submit_host_command_result(
        project_path,
        "StageUtteranceCut",
        {
            "utterance_index": utterance_index,
            "review_required": review_required,
            "use_inaudible_opt": use_inaudible_opt,
        },
    )
    return to_json(
        {
            "operation": "cut_utterance",
            "utterance_index": utterance_index,
            "review_required": review_required,
            "use_inaudible_opt": use_inaudible_opt,
        }
    )


def cut_words_tool(
    project_path: str,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
    source_id: str | None = None,
) -> str:
    """Stage a pending cut of a word-index range on a track."""
    submit_host_command_result(
        project_path,
        "StageWordsCut",
        {
            "track_id": track_id,
            "start_word_index": start_word_index,
            "end_word_index": end_word_index,
            "source_id": source_id,
            "review_required": review_required,
            "use_inaudible_opt": use_inaudible_opt,
        },
    )
    return to_json(
        {
            "operation": "cut_words",
            "track_id": track_id,
            "source_id": source_id,
            "start_word_index": start_word_index,
            "end_word_index": end_word_index,
            "review_required": review_required,
            "use_inaudible_opt": use_inaudible_opt,
        }
    )


def apply_edit_plan_tool(
    project_path: str,
    edits: JsonObjectList,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
) -> str:
    """Stage cuts from an edit-plan list; applied entries undergo fresh cut assessment."""
    ws = ProjectWorkspace.open(project_path)
    n = EditService(ws).apply_plan(
        edits,
        review_required=review_required,
        use_inaudible_opt=use_inaudible_opt,
    )
    agent_mutated(ws)
    return to_json(
        {
            "operation": "apply_edit_plan",
            "entries_added": n,
            "review_required": review_required,
            "use_inaudible_opt": use_inaudible_opt,
        }
    )


def preview_inaudible_cut_tool(
    project_path: str,
    start: float,
    end: float,
    track_id: str | None = None,
    speaker: str | None = None,
    timeline: bool = False,
) -> str:
    """Dry-run local inaudible-cut snap (~±80ms) for a proposed range.

    Not a multi-second narrative handoff planner. For leave-a-beat / clean-up-the-
    transition / punchline-to-pivot bounds use ``suggest_handoff_cut_tool``.
    """
    ws = ProjectWorkspace.open(project_path)
    out = AnalysisService(ws).preview_inaudible_cut(
        track_id=track_id,
        speaker=speaker,
        start=start,
        end=end,
        timeline=timeline,
    )
    return to_json(out)


def suggest_handoff_cut_tool(
    project_path: str,
    keep_left_end: float,
    keep_right_start: float,
    track_id: str | None = None,
    speaker: str | None = None,
    min_island_sec: float = 0.12,
    hop_ms: int = 20,
    retain_sec: float = 1.0,
) -> str:
    """Propose retain-then-snap ripple bounds for a narrative handoff.

    Omit track_id and speaker to require quiet across every dialogue lane,
    including muted lanes. Either selector limits analysis to one lane.

    Use when cleaning up a transition, leaving a beat, or punchline-to-pivot —
    not word timestamps and not ``preview_inaudible_cut_tool`` (local snap +
    ~0.4s absorb). Times are **timeline** seconds. Keeps about ``retain_sec``
    of existing air on each keep, snaps onto RMS silence islands (not
    transcript gaps), and returns ``use_inaudible_opt: false`` — lock those
    bounds on ``ripple_delete_tool``.
    """
    ws = ProjectWorkspace.open(project_path)
    out = AnalysisService(ws).suggest_handoff_cut(
        track_id=track_id,
        speaker=speaker,
        keep_left_end=keep_left_end,
        keep_right_start=keep_right_start,
        min_island_sec=min_island_sec,
        hop_ms=hop_ms,
        retain_sec=retain_sec,
    )
    return to_json(out)


def join_quality_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    join_sec: float | None = None,
    cut_start: float | None = None,
    cut_end: float | None = None,
    timebase: str = "timeline",
) -> str:
    """Score an existing or proposed cut join for audibility artifacts (clicks, glitches)."""
    ws = ProjectWorkspace.open(project_path)
    out = TimelineService(ws).join_quality(
        track_id=track_id,
        speaker=speaker,
        join_sec=join_sec,
        cut_start=cut_start,
        cut_end=cut_end,
        timebase=timebase,
    )
    return to_json(out)


def join_qa_sweep_tool(
    project_path: str,
    track_id: str | None = None,
) -> str:
    """Score all joins on a track (or the whole project) for QA review."""
    ws = ProjectWorkspace.open(project_path)
    out = TimelineService(ws).join_qa_sweep(track_id=track_id)
    return to_json(out)


def join_label_tool(
    project_path: str,
    join_sec: float,
    verdict: str,
    track_id: str | None = None,
    speaker: str | None = None,
    timebase: str = "source",
    note: str = "",
    play: bool = False,
    cut_start: float | None = None,
    cut_end: float | None = None,
) -> str:
    """Record a pass/fail label for a join to train the join-quality ranker."""
    ws = ProjectWorkspace.open(project_path)
    out = TimelineService(ws).join_label(
        track_id=track_id,
        speaker=speaker,
        join_sec=join_sec,
        verdict=verdict,
        timebase=timebase,
        note=note,
        play=play,
        cut_start=cut_start,
        cut_end=cut_end,
    )
    return to_json(out)


def list_edit_decisions_tool(
    project_path: str,
    applied: bool | None = None,
    review_required: bool | None = None,
    reason_prefix: str | None = None,
) -> str:
    """List pending decisions; use list_applied_edits_tool for archived approved edits."""
    ws = ProjectWorkspace.open(project_path)
    edits = EditService(ws).list_decisions(
        applied=applied,
        review_required=review_required,
        reason_prefix=reason_prefix,
    )
    return to_json([e.model_dump() for e in edits])


def approve_edits_tool(
    project_path: str,
    ids: list[str] | None = None,
    all_pending: bool = False,
    override_audio_checks: bool = False,
) -> str:
    """Approve pending edits by id (or every pending proposal), applying them to the timeline.

    To give every pending sound its own suggested action at once, use
    ``apply_suggested_actions_tool``.

    ``all_pending=true`` approves every pending proposal; ``ids`` approves those. Either way
    the edits that pass the automatic audio-quality and cut-position checks apply, and
    ``held`` lists the ones stopped (each with its finding) and left pending. When the user says to approve a held cut anyway, repeat with
    ``override_audio_checks=true``: it skips those checks for this call and records the
    override (actor and surface) in History and the edit log.
    """
    if all_pending == bool(ids):
        raise CodedValueError("pass ids or all_pending=true", code="approve_needs_target")
    edit_ids = (
        [
            e.id
            for e in EditService(ProjectWorkspace.open(project_path)).list_decisions(
                applied=False, review_required=True
            )
        ]
        if all_pending
        else list(ids or [])
    )
    outcome = submit_host_command_result(
        project_path,
        "ApproveEdits",
        {
            "ids": edit_ids,
            "hold_blocked": True,
            "override_audio_checks": override_audio_checks,
        },
        client_id="mcp:host",
    )
    if outcome.get("unchanged"):
        return to_json(outcome)
    result: dict[str, Any] = {
        "operation": "approve_edits",
        "approved_count": outcome["count"],
        "ids": edit_ids,
        "held": outcome.get("held", []),
    }
    if "needs_confirmation" in outcome:
        result["needs_confirmation"] = outcome["needs_confirmation"]
        result["confirm_ids"] = outcome["confirm_ids"]
    if result["held"] or "needs_confirmation" in outcome:
        result["apply_anyway"] = APPLY_ANYWAY
    return to_json(result)


def apply_suggested_actions_tool(
    project_path: str,
    ids: list[str] | None = None,
    overrides: dict[str, str] | None = None,
    revise: bool = False,
    override_audio_checks: bool = False,
) -> str:
    """Apply every pending sound's own suggested action in one undo step.

    Each tighten proposal carries a ``label`` and a ``suggested_action`` (``propose_edits``
    shows them). This applies all of them, or only ``ids``: ``cut`` and ``shorten`` cut
    (a cut held by the automatic audio checks stays pending and is named in ``held``),
    ``lower`` turns a laugh down while another speaker talks over it (otherwise it is left),
    ``leave`` dismisses the proposal and keeps the audio. ``overrides`` maps a decision id to
    another action for that sound. Returns ``applied`` by action, ``cut_over_speaker``,
    ``held`` (ids still pending) and a ``summary`` sentence.
    When the user says to apply the held ones anyway, repeat with
    ``override_audio_checks=true`` (recorded in History and the edit log).

    To change one sound after the batch (say a cut to leave) without undoing the rest, call
    again with ``revise=true`` and ``overrides={id: action}`` and no ``ids``: it steps back
    to before the latest batch (which must still be the latest edit) and applies it again
    with that change, as one undo step. Otherwise it refuses with
    ``no_suggested_batch_to_revise``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "ApplySuggestedActions",
            {
                "ids": ids,
                "overrides": overrides or {},
                "revise": revise,
                "override_audio_checks": override_audio_checks,
            },
            client_id="mcp:host",
        )
    )


def reject_edits_tool(project_path: str, ids: list[str]) -> str:
    """Reject pending edits by id, discarding them without applying."""
    result = submit_host_command_result(project_path, "RejectEdits", {"ids": ids})
    return to_json({"operation": "reject_edits", "rejected_count": result["count"], "ids": ids})


def update_pending_edit_tool(
    project_path: str,
    edit_id: str,
    start: float,
    end: float,
    snap: bool = True,
    override_audio_checks: bool = False,
) -> str:
    """Adjust the start/end bounds of a pending edit before approval.

    ``override_audio_checks=true`` keeps the exact bounds given (no snapping or holds from the
    automatic cut-position checks) and records the override.
    """
    result = submit_host_command_result(
        project_path,
        "UpdatePendingEdit",
        {
            "id": edit_id,
            "start": start,
            "end": end,
            "snap": snap,
            "override_audio_checks": override_audio_checks,
        },
        client_id="mcp:host",
    )
    return to_json({"operation": "update_pending_edit", "edit": result["edit"]})


def revert_applied_edit_tool(project_path: str, record_id: str) -> str:
    """Restore an ordinary source mute; clip removals require whole-action History Undo."""
    return to_json(
        submit_host_command_result(project_path, "RestoreAppliedEdit", {"id": record_id})
    )


def edit_impact_report_tool(project_path: str, markdown: bool = False) -> str:
    """Report pending-review and applied edits, with seconds cut in total and by track."""
    ws = ProjectWorkspace.open(project_path)
    report = EditService(ws).impact_report(markdown=markdown)
    return report if isinstance(report, str) else to_json(report)


def propose_edits(
    project_path: str, edit_mode: str | None = None, intensity: str | None = None
) -> str:
    """Propose filler/pause tighten edits for review (does not apply them).

    Returns a JSON object ``{operation, edits, skip_counts, summary}`` (not a
    bare array — breaking vs older list-of-decisions clients). ``operation`` is
    ``propose_edits``. Each edit also carries ``label`` (plain words, e.g. "Laugh")
    and ``suggested_action`` (``cut`` / ``shorten`` / ``lower`` / ``leave``) from
    one table (``edits/cut_safety.py``) and ``audio_check`` (``clean``, or ``held`` with the reason
    Approve all would give, found on a scratch copy; absent when the audio could not be read).
    ``skip_counts`` maps ``discourse:{token}`` to kept uses
    and ``backchannel:{phrase}`` to kept acknowledgments (``uh huh``).
    ``word_probe:unavailable`` is a missing Whisper model; ``word_probe:failed``
    is a span whose decode raised. The ``summary`` names both.
    ``edit_mode`` is ``ripple`` (default, from ``tighten.edit_mode``) or ``mute``.
    Mute proposes ``EditDecisionType.MUTE`` filler hits and skips pause
    candidates (muting a pause is a no-op). A ``pause:`` trim is shrunk to the air inside
    the pause, labelled ``:air_edges`` when it differs from the span pacing proposed, and
    proposed only when it removes at least a tenth of its pause (``imperceptible`` skips
    the rest). It is reviewed or applied by the checks a filler gets. ``intensity`` is ``light`` /
    ``medium`` / ``aggressive`` (default from ``tighten.intensity``, else medium):
    a deterministic preset over existing tighten keys (light = clustered um/uh
    only and >=0.5 s pause air; medium also proposes a lone um/uh; aggressive =
    isolated and borderline discourse markers, 0.3 s solo pauses). Unknown
    values raise. Suggest a tier from the episode (interview -> light, solo
    monologue -> aggressive); the pipeline itself never chooses. Pipeline
    auto-tighten stays off; listen-first review before apply_edits /
    approve_edits. Not NL cut-by-text (cut_* tools) or narrative focus (focus
    tools).
    """
    ws = ProjectWorkspace.open(project_path)
    proposal = EditService(ws).propose_tighten(edit_mode=edit_mode, intensity=intensity)
    agent_mutated(ws)
    return to_json(proposal.to_payload())


def apply_edits(project_path: str) -> str:
    """Auto-apply non-review REMOVE/MUTE decisions whose reason starts filler: or pause:."""
    ws = ProjectWorkspace.open(project_path)
    n = EditService(ws).apply_auto()
    agent_mutated(ws)
    return to_json({"operation": "apply_auto_edits", "applied_count": n})


def register(mcp: MCPServer) -> None:
    """Register edit tools on the MCP server."""
    for fn in (
        build_edit_context,
        search_transcript_tool,
        propose_range_mute_tool,
        propose_range_cut_tool,
        cut_time_range_tool,
        cut_text_match_tool,
        cut_utterance_tool,
        cut_words_tool,
        apply_edit_plan_tool,
        preview_inaudible_cut_tool,
        suggest_handoff_cut_tool,
        join_quality_tool,
        join_qa_sweep_tool,
        join_label_tool,
        list_edit_decisions_tool,
        approve_edits_tool,
        apply_suggested_actions_tool,
        reject_edits_tool,
        update_pending_edit_tool,
        revert_applied_edit_tool,
        edit_impact_report_tool,
        propose_edits,
        apply_edits,
    ):
        mcp.tool()(fn)
