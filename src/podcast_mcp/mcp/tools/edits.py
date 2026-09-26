from __future__ import annotations

import json

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.mcp.tools.agent_notify import agent_mutated
from podcast_mcp.services import EditService, ProjectWorkspace


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
    reason: str = "nl:range",
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
) -> str:
    """Stage a pending cut of a time range on a track; applies after approve_edits."""
    ws = ProjectWorkspace.open(project_path)
    EditService(ws).cut_time_range(
        track_id,
        start,
        end,
        reason=reason,
        review_required=review_required,
        use_inaudible_opt=use_inaudible_opt,
    )
    agent_mutated(ws)
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
    ws = ProjectWorkspace.open(project_path)
    EditService(ws).cut_text_match(
        query,
        track_id=track_id,
        speaker=speaker,
        match_all=match_all,
        review_required=review_required,
        use_inaudible_opt=use_inaudible_opt,
    )
    agent_mutated(ws)
    ws.reload()
    return to_json([e.model_dump() for e in ws.project.edit_decisions[-5:]])


def cut_utterance_tool(
    project_path: str,
    utterance_index: int,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
) -> str:
    """Stage a pending cut of one utterance by its index."""
    ws = ProjectWorkspace.open(project_path)
    EditService(ws).cut_utterance(
        utterance_index,
        review_required=review_required,
        use_inaudible_opt=use_inaudible_opt,
    )
    agent_mutated(ws)
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
) -> str:
    """Stage a pending cut of a word-index range on a track."""
    ws = ProjectWorkspace.open(project_path)
    EditService(ws).cut_words(
        track_id,
        start_word_index,
        end_word_index,
        review_required=review_required,
        use_inaudible_opt=use_inaudible_opt,
    )
    agent_mutated(ws)
    return to_json(
        {
            "operation": "cut_words",
            "track_id": track_id,
            "start_word_index": start_word_index,
            "end_word_index": end_word_index,
            "review_required": review_required,
            "use_inaudible_opt": use_inaudible_opt,
        }
    )


def apply_edit_plan_tool(
    project_path: str,
    edits_json: str,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
) -> str:
    """Stage a batch of pending cuts from a JSON edit-plan array."""
    ws = ProjectWorkspace.open(project_path)
    raw = json.loads(edits_json)
    n = EditService(ws).apply_plan(
        raw,
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
    out = EditService(ws).preview_inaudible_cut(
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
    quiet_db: float = -48.0,
    min_island_sec: float = 0.12,
    hop_ms: int = 20,
    retain_sec: float = 1.0,
) -> str:
    """Propose retain-then-snap ripple bounds for a narrative handoff.

    Use when cleaning up a transition, leaving a beat, or punchline-to-pivot —
    not word timestamps and not ``preview_inaudible_cut_tool`` (local snap +
    ~0.4s absorb). Times are **timeline** seconds. Keeps about ``retain_sec``
    of existing air on each keep, snaps onto RMS silence islands (not
    transcript gaps), and returns ``use_inaudible_opt: false`` — lock those
    bounds on ``ripple_delete_tool``.
    """
    ws = ProjectWorkspace.open(project_path)
    out = EditService(ws).suggest_handoff_cut(
        track_id=track_id,
        speaker=speaker,
        keep_left_end=keep_left_end,
        keep_right_start=keep_right_start,
        quiet_db=quiet_db,
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
    out = EditService(ws).join_quality(
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
    out = EditService(ws).join_qa_sweep(track_id=track_id)
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
    out = EditService(ws).join_label(
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


def approve_edits_tool(project_path: str, ids_json: str) -> str:
    """Approve pending edits by id, applying them to the timeline."""
    ws = ProjectWorkspace.open(project_path)
    ids = json.loads(ids_json)
    n = EditService(ws).approve(ids)
    agent_mutated(ws)
    return to_json({"operation": "approve_edits", "approved_count": n, "ids": ids})


def reject_edits_tool(project_path: str, ids_json: str) -> str:
    """Reject pending edits by id, discarding them without applying."""
    ws = ProjectWorkspace.open(project_path)
    ids = json.loads(ids_json)
    n = EditService(ws).reject(ids)
    agent_mutated(ws)
    return to_json({"operation": "reject_edits", "rejected_count": n, "ids": ids})


def update_pending_edit_tool(
    project_path: str,
    edit_id: str,
    start: float,
    end: float,
    snap: bool = True,
) -> str:
    """Adjust the start/end bounds of a pending edit before approval."""
    ws = ProjectWorkspace.open(project_path)
    edit = EditService(ws).update_pending(edit_id, start=start, end=end, snap=snap)
    agent_mutated(ws)
    return to_json({"operation": "update_pending_edit", "edit": edit.model_dump()})


def revert_applied_edit_tool(project_path: str, record_id: str) -> str:
    """Revert an applied edit by its history record id."""
    ws = ProjectWorkspace.open(project_path)
    result = EditService(ws).revert_applied(record_id)
    agent_mutated(ws)
    return to_json(result)


def edit_impact_report_tool(project_path: str, markdown: bool = False) -> str:
    """Report pending-review and applied edits, with applied removal duration by track."""
    ws = ProjectWorkspace.open(project_path)
    report = EditService(ws).impact_report(markdown=markdown)
    return report if isinstance(report, str) else to_json(report)


def propose_edits(
    project_path: str, edit_mode: str | None = None, intensity: str | None = None
) -> str:
    """Propose filler/pause tighten edits for review (does not apply them).

    Returns a JSON object ``{operation, edits, skip_counts, summary}`` (not a
    bare array — breaking vs older list-of-decisions clients). ``operation`` is
    ``propose_edits``. ``skip_counts`` maps ``discourse:{token}`` to kept uses.
    ``edit_mode`` is ``ripple`` (default, from ``tighten.edit_mode``) or ``mute``.
    Mute proposes ``EditDecisionType.MUTE`` filler hits and skips pause
    candidates (muting a pause is a no-op). ``intensity`` is ``light`` /
    ``medium`` / ``aggressive`` (default from ``tighten.intensity``, else medium):
    a deterministic preset over existing tighten keys (light = clear um/uh only
    and >=0.5 s pause air; aggressive = isolated fillers, borderline discourse
    markers, 0.3 s solo pauses). Unknown values raise. Suggest a tier from the
    episode (interview -> light, solo monologue -> aggressive); the pipeline
    itself never chooses. Pipeline auto-tighten stays off;
    listen-first review before apply_edits / approve_edits. Not NL cut-by-text
    (cut_* tools) or narrative focus (focus tools).
    """
    ws = ProjectWorkspace.open(project_path)
    proposal = EditService(ws).propose_tighten(edit_mode=edit_mode, intensity=intensity)
    agent_mutated(ws)
    return to_json(
        {
            "operation": "propose_edits",
            "edits": [e.model_dump() for e in proposal.decisions],
            "skip_counts": proposal.skip_counts,
            "summary": proposal.summary(),
        }
    )


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
        reject_edits_tool,
        update_pending_edit_tool,
        revert_applied_edit_tool,
        edit_impact_report_tool,
        propose_edits,
        apply_edits,
    ):
        mcp.tool()(fn)
