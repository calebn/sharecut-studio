"""Guest MCP tool implementations - wrap ShareService / document commands."""

from __future__ import annotations

import functools
import inspect
import json
import typing
from collections.abc import Callable
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError, create_model

from podcast_mcp.edits.pending_preview import DEFAULT_PAD_SEC
from podcast_mcp.edits.review_gate import ShareSource
from podcast_mcp.services.collaboration import (
    CAP_PLAY,
    CAP_VIEW,
    guest_cancel_job,
    guest_edit_impact_view,
    guest_export_transcript,
    guest_exports,
    guest_job_status_view,
    guest_move_lane_span,
    guest_projected_job,
    guest_refine_done,
    guest_refine_status,
    guest_refine_waive,
    guest_replacement_preview,
    guest_save_vocabulary,
    guest_social_clip_view,
    guest_start_export,
    guest_start_pipeline_run,
    guest_start_speaker_split,
    guest_vocabulary,
    guest_word_timing_context,
    has_capability,
    lookup_guest_job,
    share_add_comment,
    share_add_reply,
    share_audition_context_info,
    share_daw_project_view,
    share_pending_preview_info,
    share_project_view,
    share_set_action_done,
    share_upload_media,
)
from podcast_mcp.services.document_sync import (
    COMMENT_BODY_MAX,
    DocumentSyncService,
    document_command_json_schema,
    parse_document_command,
)
from podcast_mcp.services.remote_mcp.allowlist import tool_allowed
from podcast_mcp.services.remote_mcp.context import get_remote_mcp_context
from podcast_mcp.util.coded_error import (
    CodedError,
    CodedKeyError,
    CodedPermissionError,
)
from podcast_mcp.util.guest_render import require_guest_render
from podcast_mcp.util.progress import install_guest_tool_progress
from podcast_mcp.util.tool_refusal import guest_failure_detail

if typing.TYPE_CHECKING:
    from podcast_mcp.gui.schemas import (
        GuestEditImpactRequest,
        GuestExportRequest,
        GuestJobRequest,
        GuestPipelineRunRequest,
        GuestRefineDoneRequest,
        GuestRefineWaiveRequest,
        GuestReplacementPreviewRequest,
        GuestSocialClipsRequest,
        GuestSpeakerMoveLaneSpanRequest,
        GuestSpeakerSplitRequest,
        GuestTranscriptExportRequest,
        GuestVocabularyPutRequest,
        GuestWordTimingContextRequest,
    )
    from podcast_mcp.services.jobs import JobManager


class UnknownToolError(LookupError):
    """``tools/call`` named no guest tool (JSON-RPC ``-32602``, as the MCP spec has it)."""


class InvalidToolArgumentsError(CodedError, ValueError):
    """The guest's arguments do not fit the tool (JSON-RPC ``-32602``); the message says why."""

    code = "invalid_arguments"


def _argument_problems(exc: ValidationError) -> str:
    """Which arguments do not fit and why: the field path and rule, never the submitted value."""
    return "; ".join(
        f"{'.'.join(str(part) for part in err['loc']) or 'arguments'}: {err['msg']}"
        for err in exc.errors(include_input=False, include_url=False, include_context=False)
    )


def _require_tool(name: str) -> None:
    ctx = get_remote_mcp_context()
    if not tool_allowed(ctx.capabilities, name):
        raise CodedPermissionError(
            f"share capabilities do not allow tool: {name}", code="share_capability_required"
        )


def guest_get_review_summary() -> dict[str, Any]:
    """Project summary (no host paths)."""
    _require_tool("guest_get_review_summary")
    ctx = get_remote_mcp_context()
    return share_project_view(ctx.token)


def guest_get_project() -> dict[str, Any]:
    """Sanitized ShareCut Studio project view (requires ``view``)."""
    _require_tool("guest_get_project")
    ctx = get_remote_mcp_context()
    return share_daw_project_view(ctx.token)


def guest_get_session_presence() -> dict[str, Any]:
    """Live roster for this share (requires ``view``). Paths stripped."""
    _require_tool("guest_get_session_presence")
    ctx = get_remote_mcp_context()
    if not has_capability(ctx.capabilities, CAP_VIEW):
        raise CodedPermissionError("share does not allow view", code="share_capability_required")
    from podcast_mcp.services.collaboration import (
        SessionControlService,
        sanitize_guest_session_event,
    )

    roster = SessionControlService(ctx.workspace).presence()
    return sanitize_guest_session_event({"clients": roster})


def guest_list_clips() -> Any:
    _require_tool("guest_list_clips")
    view = guest_get_project()
    return view.get("clips") or {}


def guest_list_pending_edits() -> list[dict[str, Any]]:
    _require_tool("guest_list_pending_edits")
    view = guest_get_project()
    return list(view.get("pending_edits") or [])


def guest_list_applied_edits() -> Any:
    _require_tool("guest_list_applied_edits")
    view = guest_get_project()
    applied = view.get("applied_edits")
    if isinstance(applied, dict):
        return applied
    if isinstance(applied, list):
        return applied
    return {}


def guest_search_transcript(query: str, limit: int = 20) -> list[dict[str, Any]]:
    """Search combined transcript text (guest-safe; no project_path)."""
    _require_tool("guest_search_transcript")
    ctx = get_remote_mcp_context()
    if not has_capability(ctx.capabilities, CAP_VIEW):
        raise CodedPermissionError("share does not allow view", code="share_capability_required")
    from podcast_mcp.edits.transcript_search import search_transcript

    hits = search_transcript(
        ctx.workspace.project, query=query, defaults=ctx.workspace.effective_config()
    )
    out: list[dict[str, Any]] = []
    for h in hits[: max(1, limit)]:
        if hasattr(h, "model_dump"):
            row = h.model_dump()
        elif isinstance(h, dict):
            row = dict(h)
        else:
            row = {"text": str(h)}
        row.pop("project_path", None)
        out.append(row)
    return out


def guest_render_status() -> dict[str, Any]:
    _require_tool("guest_render_status")
    view = guest_get_project()
    rs = view.get("render_status")
    return rs if isinstance(rs, dict) else {}


def guest_list_comments() -> list[dict[str, Any]]:
    _require_tool("guest_list_comments")
    ctx = get_remote_mcp_context()
    summary = share_project_view(ctx.token)
    return list(summary.get("comments") or [])


def guest_audio_info() -> dict[str, Any]:
    """Where guests can stream audio - relative share URLs, not host speakers."""
    _require_tool("guest_audio_info")
    ctx = get_remote_mcp_context()
    return {
        "review_audio_path": f"/api/review/{ctx.token}/audio",
        "daw_premix_path": f"/api/review/{ctx.token}/daw/audio?kind=premix",
        "note": (
            "Stream via the share HTTP URLs (or relay public origin). "
            "Remote MCP does not play audio on the host machine."
        ),
    }


def guest_pending_preview(
    edit_id: str,
    mode: str = "suggested",
    visual: bool = False,
    pad_sec: float = DEFAULT_PAD_SEC,
) -> dict[str, Any]:
    """Listen-first Current / Suggested / A/B URLs, ``pad_sec`` either side (``play`` + ``view``)."""
    _require_tool("guest_pending_preview")
    ctx = get_remote_mcp_context()
    if not has_capability(ctx.capabilities, CAP_PLAY) or not has_capability(
        ctx.capabilities, CAP_VIEW
    ):
        raise CodedPermissionError(
            "share does not allow play and view", code="share_capability_required"
        )
    return share_pending_preview_info(
        ctx.token,
        edit_id=edit_id,
        mode=mode,
        visual=visual,
        pad_sec=pad_sec,
    )


def guest_audition_context(
    start: float,
    end: float,
    visual: bool = True,
) -> dict[str, Any]:
    """Windowed captions + wave/spec PNG URLs (``play`` + ``view``)."""
    _require_tool("guest_audition_context")
    ctx = get_remote_mcp_context()
    if not has_capability(ctx.capabilities, CAP_PLAY) or not has_capability(
        ctx.capabilities, CAP_VIEW
    ):
        raise CodedPermissionError(
            "share does not allow play and view", code="share_capability_required"
        )
    return share_audition_context_info(
        ctx.token,
        start=start,
        end=end,
        visual=visual,
    )


def guest_upload_media(
    filename: str,
    data_base64: str,
    upload_id: str | None = None,
    chunk_index: int = 0,
    total_chunks: int = 1,
) -> dict[str, Any]:
    """Chunked media upload (``edit``). Same as ``POST …/daw/media/upload``."""
    import base64

    _require_tool("guest_upload_media")
    ctx = get_remote_mcp_context()
    try:
        data = base64.b64decode(data_base64, validate=True)
    except Exception as exc:
        raise InvalidToolArgumentsError("data_base64 must be valid base64") from exc
    return share_upload_media(
        ctx.token,
        filename=filename,
        data=data,
        upload_id=upload_id,
        chunk_index=chunk_index,
        total_chunks=total_chunks,
    )


def guest_add_comment(
    body: str,
    author: str,
    timeline_start: float,
    timeline_end: float | None = None,
    edit_decision_id: str | None = None,
) -> dict[str, Any]:
    _require_tool("guest_add_comment")
    ctx = get_remote_mcp_context()
    return {
        "comment": share_add_comment(
            ctx.token,
            body=body,
            author=author,
            timeline_start=timeline_start,
            timeline_end=timeline_end,
            edit_decision_id=edit_decision_id,
        )
    }


def guest_add_reply(comment_id: str, body: str, author: str) -> dict[str, Any]:
    _require_tool("guest_add_reply")
    ctx = get_remote_mcp_context()
    return share_add_reply(ctx.token, comment_id, body=body, author=author)


def guest_set_action_done(
    comment_id: str,
    action_id: str,
    done: bool = True,
    completed_by: str = "guest",
) -> dict[str, Any]:
    _require_tool("guest_set_action_done")
    ctx = get_remote_mcp_context()
    return share_set_action_done(
        ctx.token,
        comment_id,
        action_id,
        done=done,
        by=completed_by,
    )


def guest_submit_document_command(**kwargs: Any) -> dict[str, Any]:
    """Submit a document command the share's review role allows (Commenter or Editor).

    Arguments match ``DocumentCommandBody`` (type + payload + client envelope).
    """
    _require_tool("guest_submit_document_command")
    ctx = get_remote_mcp_context()
    from podcast_mcp.services.collaboration import sanitize_guest_document_event

    data = dict(kwargs)
    data.setdefault("client_id", "remote-mcp")
    data.setdefault("role", "guest")
    if "payload" not in data:
        data["payload"] = {}
    try:
        cmd = parse_document_command(data)
    except ValidationError as exc:
        raise InvalidToolArgumentsError(_argument_problems(exc)) from exc
    cmd.role = "guest"
    svc = DocumentSyncService(ctx.workspace)
    result = svc.submit(
        cmd,
        capabilities=list(ctx.capabilities),
        structural_mode=data.get("structural_mode"),
        author=ctx.author,
    )
    if isinstance(result, dict):
        return sanitize_guest_document_event(result)
    return result


def guest_render_preview() -> dict[str, Any]:
    """Rebuild stems/premix (requires ``edit`` + ``PODCAST_GUEST_RENDER=1``)."""
    _require_tool("guest_render_preview")
    from podcast_mcp.services.jobs import GUEST_RENDER_KINDS, guest_job_view
    from podcast_mcp.util.guest_render import require_guest_render

    require_guest_render()
    ctx = get_remote_mcp_context()
    jobs = _shared_jobs()
    # A busy job slot (``JobSlotBusyError``) is a refusal the guest sees, not a caps deny (-32003).
    job = jobs.start_render_preview(ctx.workspace.path)
    projected = guest_job_view(job, ctx.workspace.path, GUEST_RENDER_KINDS)
    if projected is None:
        raise RuntimeError("Render preview job unavailable")
    return {"job": projected}


def guest_render_preview_job(job_id: str) -> dict[str, Any]:
    """Read a guest render job scoped to the current edit share."""
    _require_tool("guest_render_preview_job")
    from podcast_mcp.services.jobs import GUEST_RENDER_KINDS, guest_job_view

    ctx = get_remote_mcp_context()
    job = guest_job_view(_shared_jobs().get_job(job_id), ctx.workspace.path, GUEST_RENDER_KINDS)
    if job is None:
        raise CodedKeyError("Render preview job not found", code="job_not_found")
    return {"job": job}


def _shared_jobs() -> JobManager:
    from podcast_mcp.services.jobs import shared_job_manager

    return shared_job_manager()


def _jobs_and_kinds(family: str) -> tuple[JobManager, frozenset[str]]:
    from podcast_mcp.services.jobs import (
        GUEST_EXPORT_KINDS,
        GUEST_PIPELINE_KINDS,
        GUEST_SPEAKER_KINDS,
    )

    kinds = {
        "pipeline": GUEST_PIPELINE_KINDS,
        "export": GUEST_EXPORT_KINDS,
        "speaker": GUEST_SPEAKER_KINDS,
    }[family]
    return _shared_jobs(), kinds


def guest_pipeline_run(req: GuestPipelineRunRequest) -> dict[str, Any]:
    """Start a pipeline run on the host's working-set config (requires ``edit`` + the opt-in)."""
    _require_tool("guest_pipeline_run")
    require_guest_render()
    return guest_start_pipeline_run(
        _shared_jobs(), get_remote_mcp_context().workspace, **req.model_dump()
    )


def guest_export_start(req: GuestExportRequest) -> dict[str, Any]:
    """Start the deliverables export into the project's export folder (``edit`` + the opt-in)."""
    _require_tool("guest_export_start")
    require_guest_render()
    ctx = get_remote_mcp_context()
    return guest_start_export(_shared_jobs(), ctx.workspace, ctx.author, req.formats)


def guest_speaker_split(req: GuestSpeakerSplitRequest) -> dict[str, Any]:
    """Start a speaker split of one track (requires ``edit`` + the opt-in)."""
    _require_tool("guest_speaker_split")
    require_guest_render()
    ctx = get_remote_mcp_context()
    return guest_start_speaker_split(_shared_jobs(), ctx.workspace, ctx.author, **req.model_dump())


def guest_speaker_move_lane_span(req: GuestSpeakerMoveLaneSpanRequest) -> dict[str, Any]:
    """Move a timeline range between two lanes of one speaker split (requires ``edit``)."""
    _require_tool("guest_speaker_move_lane_span")
    ctx = get_remote_mcp_context()
    return guest_move_lane_span(ctx.workspace, ctx.author, **req.model_dump())


def guest_edit_impact(req: GuestEditImpactRequest) -> dict[str, Any]:
    """Seconds cut, edits applied and pending, and the segments behind them (requires ``edit``)."""
    _require_tool("guest_edit_impact")
    return guest_edit_impact_view(get_remote_mcp_context().workspace, markdown=req.markdown)


def guest_social_clips(req: GuestSocialClipsRequest) -> dict[str, Any]:
    """The project's social clip candidates, optionally by state (requires ``edit``)."""
    _require_tool("guest_social_clips")
    return guest_social_clip_view(
        get_remote_mcp_context().workspace,
        approved=req.approved,
        review_required=req.review_required,
    )


def _job_tools(
    family: str,
) -> tuple[
    Callable[[], dict[str, Any]],
    Callable[[GuestJobRequest], dict[str, Any]],
    Callable[[GuestJobRequest], dict[str, Any]],
]:
    """The status, job and cancel handlers of one job family, each the twin of its HTTP row.

    Cancel runs with ``PODCAST_GUEST_RENDER`` off, like the HTTP rows, so the host can stop a
    job after turning the opt-in off.
    """
    status_name, job_name, cancel_name = (
        f"guest_{family}_status",
        f"guest_{family}_job",
        f"guest_{family}_job_cancel",
    )

    def status() -> dict[str, Any]:
        _require_tool(status_name)
        jobs, kinds = _jobs_and_kinds(family)
        return guest_job_status_view(jobs, get_remote_mcp_context().workspace, kinds)

    def job(req: GuestJobRequest) -> dict[str, Any]:
        _require_tool(job_name)
        jobs, kinds = _jobs_and_kinds(family)
        ws = get_remote_mcp_context().workspace
        return guest_projected_job(lookup_guest_job(jobs, ws, req.job_id, kinds), ws, kinds)

    def cancel(req: GuestJobRequest) -> dict[str, Any]:
        _require_tool(cancel_name)
        jobs, kinds = _jobs_and_kinds(family)
        ws = get_remote_mcp_context().workspace
        return guest_cancel_job(jobs, ws, lookup_guest_job(jobs, ws, req.job_id, kinds), kinds)

    return status, job, cancel


(
    guest_pipeline_status,
    guest_pipeline_job,
    guest_pipeline_job_cancel,
) = _job_tools("pipeline")
guest_export_status, guest_export_job, guest_export_job_cancel = _job_tools("export")
guest_speaker_status, guest_speaker_job, guest_speaker_job_cancel = _job_tools("speaker")


def guest_transcript_vocabulary_get() -> dict[str, Any]:
    """The project's transcript vocabulary: terms, guest names and revision."""
    _require_tool("guest_transcript_vocabulary_get")
    return guest_vocabulary(get_remote_mcp_context().workspace)


def guest_transcript_vocabulary_put(req: GuestVocabularyPutRequest) -> dict[str, Any]:
    """Save the vocabulary against the revision last read (requires ``edit``)."""
    _require_tool("guest_transcript_vocabulary_put")
    ctx = get_remote_mcp_context()
    return guest_save_vocabulary(
        ctx.workspace,
        ctx.author,
        terms=req.terms,
        guest_names=req.guest_names,
        base_revision=req.base_revision,
    )


def guest_transcript_refine_status() -> dict[str, Any]:
    """The transcript check: pending, done or waived (the host's notes are not shown)."""
    _require_tool("guest_transcript_refine_status")
    return guest_refine_status(get_remote_mcp_context().workspace)


def guest_transcript_refine_done(req: GuestRefineDoneRequest) -> dict[str, Any]:
    """Mark the transcript checked as this share (requires ``edit``)."""
    _require_tool("guest_transcript_refine_done")
    ctx = get_remote_mcp_context()
    return guest_refine_done(
        ctx.workspace,
        ShareSource(ctx.author),
        notes=req.notes,
        expected_fingerprint=req.expected_fingerprint,
    )


def guest_transcript_refine_waive(req: GuestRefineWaiveRequest) -> dict[str, Any]:
    """Waive the transcript check as this share, with a short reason (requires ``edit``)."""
    _require_tool("guest_transcript_refine_waive")
    ctx = get_remote_mcp_context()
    return guest_refine_waive(ctx.workspace, ShareSource(ctx.author), reason=req.reason)


def guest_transcript_replacement_preview(req: GuestReplacementPreviewRequest) -> dict[str, Any]:
    """Preview a find-and-replace on the transcript; writes nothing."""
    _require_tool("guest_transcript_replacement_preview")
    return guest_replacement_preview(
        get_remote_mcp_context().workspace,
        search=req.search,
        replacement=req.replacement,
        match_case=req.match_case,
    )


def guest_transcript_word_timing_context(req: GuestWordTimingContextRequest) -> dict[str, Any]:
    """The audio context of one word, checked against the word the guest last saw."""
    _require_tool("guest_transcript_word_timing_context")
    return guest_word_timing_context(
        get_remote_mcp_context().workspace,
        target=req.target.model_dump(),
        expected_text=req.expected_word.text,
        expected_start=req.expected_word.start,
        expected_end=req.expected_word.end,
    )


def guest_transcript_export(req: GuestTranscriptExportRequest) -> dict[str, Any]:
    """Write or preview the transcript as txt, md, srt or vtt in the project's export folder."""
    _require_tool("guest_transcript_export")
    ctx = get_remote_mcp_context()
    return guest_export_transcript(
        ctx.workspace,
        ctx.author,
        formats=req.formats,
        dry_run=req.dry_run,
        with_text=req.with_text,
    )


def guest_transcript_exports() -> list[dict[str, Any]]:
    """The transcript files already exported (names and whether current; no paths)."""
    _require_tool("guest_transcript_exports")
    return guest_exports(get_remote_mcp_context().workspace)


TOOL_HANDLERS: dict[str, Any] = {
    "guest_get_review_summary": guest_get_review_summary,
    "guest_get_project": guest_get_project,
    "guest_get_session_presence": guest_get_session_presence,
    "guest_list_clips": guest_list_clips,
    "guest_list_pending_edits": guest_list_pending_edits,
    "guest_list_applied_edits": guest_list_applied_edits,
    "guest_search_transcript": guest_search_transcript,
    "guest_render_status": guest_render_status,
    "guest_list_comments": guest_list_comments,
    "guest_audio_info": guest_audio_info,
    "guest_pending_preview": guest_pending_preview,
    "guest_audition_context": guest_audition_context,
    "guest_add_comment": guest_add_comment,
    "guest_add_reply": guest_add_reply,
    "guest_set_action_done": guest_set_action_done,
    "guest_submit_document_command": guest_submit_document_command,
    "guest_render_preview": guest_render_preview,
    "guest_render_preview_job": guest_render_preview_job,
    "guest_upload_media": guest_upload_media,
    "guest_pipeline_run": guest_pipeline_run,
    "guest_pipeline_status": guest_pipeline_status,
    "guest_pipeline_job": guest_pipeline_job,
    "guest_pipeline_job_cancel": guest_pipeline_job_cancel,
    "guest_export_start": guest_export_start,
    "guest_export_status": guest_export_status,
    "guest_export_job": guest_export_job,
    "guest_export_job_cancel": guest_export_job_cancel,
    "guest_speaker_split": guest_speaker_split,
    "guest_speaker_status": guest_speaker_status,
    "guest_speaker_job": guest_speaker_job,
    "guest_speaker_job_cancel": guest_speaker_job_cancel,
    "guest_speaker_move_lane_span": guest_speaker_move_lane_span,
    "guest_transcript_vocabulary_get": guest_transcript_vocabulary_get,
    "guest_transcript_vocabulary_put": guest_transcript_vocabulary_put,
    "guest_transcript_refine_status": guest_transcript_refine_status,
    "guest_transcript_refine_done": guest_transcript_refine_done,
    "guest_transcript_refine_waive": guest_transcript_refine_waive,
    "guest_transcript_replacement_preview": guest_transcript_replacement_preview,
    "guest_transcript_word_timing_context": guest_transcript_word_timing_context,
    "guest_transcript_export": guest_transcript_export,
    "guest_transcript_exports": guest_transcript_exports,
    "guest_edit_impact": guest_edit_impact,
    "guest_social_clips": guest_social_clips,
}

# Tools whose one argument, ``req``, is a guest request model shared with their HTTP twin.


TOOL_DESCRIPTIONS: dict[str, str] = {
    "guest_get_review_summary": "Review-mode project summary for this share (no host paths).",
    "guest_get_project": "Sanitized ShareCut Studio project view (requires view capability).",
    "guest_get_session_presence": (
        "Who is in the ShareCut Studio session: display names, cursor, selection, "
        "viewport, transport, follow relationships (requires view)."
    ),
    "guest_list_clips": "List timeline clips from the guest project view.",
    "guest_list_pending_edits": "List pending edit decisions.",
    "guest_list_applied_edits": "List applied edit provenance when present in the view.",
    "guest_search_transcript": "Search the episode transcript by text query.",
    "guest_render_status": "Stem/premix freshness flags (paths stripped).",
    "guest_list_comments": "List timeline review comments.",
    "guest_audio_info": "Relative URLs to stream review/premix audio (not host speakers).",
    "guest_pending_preview": (
        "Listen-first Current/Suggested/A/B URLs for a pending session remove "
        "(requires play+view; not host speakers)."
    ),
    "guest_audition_context": (
        "Windowed hear context: per-track captions and waveform/spectrogram PNG URLs "
        "(requires play+view; not host speakers). Additive contract."
    ),
    "guest_add_comment": "Add a timeline comment (requires comment).",
    "guest_add_reply": "Reply to a comment (requires comment/reply).",
    "guest_set_action_done": "Toggle a comment action item (requires action).",
    "guest_submit_document_command": (
        "Submit a suggest/edit document command (ApproveEdits, SuggestPendingEdit, …)."
    ),
    "guest_render_preview": ("Start a render job and return its ID immediately (requires edit)."),
    "guest_render_preview_job": "Get status of a render job for this edit share's project.",
    "guest_upload_media": (
        "Chunked audio upload into host raw/ (requires edit). Same as POST …/daw/media/upload."
    ),
    "guest_pipeline_run": (
        "Start a pipeline run with the host's saved settings and return its job "
        "(requires edit; host opt-in PODCAST_GUEST_RENDER)."
    ),
    "guest_pipeline_status": "Pipeline jobs for this project: the running one and recent ones.",
    "guest_pipeline_job": "Status of one pipeline job of this project, by job_id.",
    "guest_pipeline_job_cancel": "Cancel one pipeline job of this project, by job_id.",
    "guest_export_start": (
        "Export mastered deliverables (mp3, flac, m4a) into the project's export folder "
        "(requires edit; host opt-in PODCAST_GUEST_RENDER)."
    ),
    "guest_export_status": "Export jobs for this project: the running one and recent ones.",
    "guest_export_job": "Status of one export job of this project, by job_id.",
    "guest_export_job_cancel": "Cancel one export job of this project, by job_id.",
    "guest_speaker_split": (
        "Split one track into a lane per speaker (requires edit; host opt-in "
        "PODCAST_GUEST_RENDER; the host must already have the speaker model)."
    ),
    "guest_speaker_status": "Speaker-split jobs for this project: the running one and recent ones.",
    "guest_speaker_job": "Status of one speaker-split job of this project, by job_id.",
    "guest_speaker_job_cancel": "Cancel one speaker-split job of this project, by job_id.",
    "guest_speaker_move_lane_span": (
        "Move a timeline range between two lanes of one speaker split (requires edit)."
    ),
    "guest_transcript_vocabulary_get": (
        "The project's transcript vocabulary: terms, guest names and revision."
    ),
    "guest_transcript_vocabulary_put": (
        "Save the transcript vocabulary against the revision last read (requires edit)."
    ),
    "guest_transcript_refine_status": (
        "The transcript check (pending, done or waived); the host's notes are not shown."
    ),
    "guest_transcript_refine_done": (
        "Mark the transcript checked as this link; refused if it changed since the fingerprint (requires edit)."
    ),
    "guest_transcript_refine_waive": (
        "Waive the transcript check as this link, with a short reason (requires edit)."
    ),
    "guest_transcript_replacement_preview": (
        "Preview a find-and-replace on the transcript; writes nothing."
    ),
    "guest_transcript_word_timing_context": (
        "The audio context of one transcript word, checked against the word last seen."
    ),
    "guest_transcript_export": (
        "Write or preview the transcript as txt, md, srt or vtt in the project's export folder; no file paths returned (requires edit)."
    ),
    "guest_transcript_exports": (
        "The transcript files already exported (names and whether current; no paths)."
    ),
    "guest_edit_impact": (
        "Seconds cut and edits applied or pending, per track, with the segments behind them "
        "(requires edit; markdown=true for the host's report)."
    ),
    "guest_social_clips": (
        "The project's social clip candidates with score, title and review state "
        "(requires edit; filter by approved or review_required)."
    ),
}


def tool_input_schema(name: str) -> dict[str, Any]:
    schemas: dict[str, dict[str, Any]] = {
        "guest_search_transcript": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 20},
            },
            "required": ["query"],
        },
        "guest_pending_preview": {
            "type": "object",
            "properties": {
                "edit_id": {"type": "string"},
                "mode": {
                    "type": "string",
                    "enum": ["current", "suggested", "ab"],
                    "default": "suggested",
                },
                "visual": {
                    "type": "boolean",
                    "default": False,
                    "description": "Also return waveform and spectrogram PNG URLs.",
                },
            },
            "required": ["edit_id"],
        },
        "guest_audition_context": {
            "type": "object",
            "properties": {
                "start": {"type": "number", "description": "Timeline start seconds"},
                "end": {"type": "number", "description": "Timeline end seconds"},
                "visual": {
                    "type": "boolean",
                    "default": True,
                    "description": "Include waveform/spectrogram PNG URLs.",
                },
            },
            "required": ["start", "end"],
        },
        "guest_add_comment": {
            "type": "object",
            "properties": {
                "body": {"type": "string", "maxLength": COMMENT_BODY_MAX},
                "author": {"type": "string"},
                "timeline_start": {"type": "number"},
                "timeline_end": {"type": ["number", "null"]},
                "edit_decision_id": {"type": ["string", "null"]},
            },
            "required": ["body", "author", "timeline_start"],
        },
        "guest_add_reply": {
            "type": "object",
            "properties": {
                "comment_id": {"type": "string"},
                "body": {"type": "string", "maxLength": COMMENT_BODY_MAX},
                "author": {"type": "string"},
            },
            "required": ["comment_id", "body", "author"],
        },
        "guest_set_action_done": {
            "type": "object",
            "properties": {
                "comment_id": {"type": "string"},
                "action_id": {"type": "string"},
                "done": {"type": "boolean", "default": True},
                "completed_by": {"type": "string", "default": "guest"},
            },
            "required": ["comment_id", "action_id"],
        },
        "guest_submit_document_command": document_command_json_schema(),
        "guest_render_preview_job": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
        "guest_upload_media": {
            "type": "object",
            "properties": {
                "filename": {"type": "string"},
                "data_base64": {"type": "string"},
                "upload_id": {"type": ["string", "null"]},
                "chunk_index": {"type": "integer", "default": 0},
                "total_chunks": {"type": "integer", "default": 1},
            },
            "required": ["filename", "data_base64"],
        },
    }
    model = _request_model(name)
    if model is not None:
        return model.model_json_schema()
    return schemas.get(name, {"type": "object", "properties": {}})


def list_tool_defs(caps: list[str] | None) -> list[dict[str, Any]]:
    from podcast_mcp.services.remote_mcp.allowlist import tools_for_capabilities

    allowed = tools_for_capabilities(caps)
    return [
        {
            "name": name,
            "description": TOOL_DESCRIPTIONS.get(name, ""),
            "inputSchema": tool_input_schema(name),
        }
        for name in sorted(allowed)
        if name in TOOL_HANDLERS
    ]


@functools.cache
def _request_models() -> dict[str, type[BaseModel]]:
    """The HTTP twins' request model of each tool whose one argument, ``req``, is that model."""
    from podcast_mcp.gui.schemas import (
        GuestEditImpactRequest,
        GuestExportRequest,
        GuestJobRequest,
        GuestPipelineRunRequest,
        GuestRefineDoneRequest,
        GuestRefineWaiveRequest,
        GuestReplacementPreviewRequest,
        GuestSocialClipsRequest,
        GuestSpeakerMoveLaneSpanRequest,
        GuestSpeakerSplitRequest,
        GuestTranscriptExportRequest,
        GuestVocabularyPutRequest,
        GuestWordTimingContextRequest,
    )

    return {
        "guest_edit_impact": GuestEditImpactRequest,
        "guest_social_clips": GuestSocialClipsRequest,
        "guest_pipeline_run": GuestPipelineRunRequest,
        "guest_export_start": GuestExportRequest,
        "guest_speaker_split": GuestSpeakerSplitRequest,
        "guest_speaker_move_lane_span": GuestSpeakerMoveLaneSpanRequest,
        "guest_transcript_vocabulary_put": GuestVocabularyPutRequest,
        "guest_transcript_refine_done": GuestRefineDoneRequest,
        "guest_transcript_refine_waive": GuestRefineWaiveRequest,
        "guest_transcript_replacement_preview": GuestReplacementPreviewRequest,
        "guest_transcript_word_timing_context": GuestWordTimingContextRequest,
        "guest_transcript_export": GuestTranscriptExportRequest,
        **{
            f"guest_{family}_{op}": GuestJobRequest
            for family in ("pipeline", "export", "speaker")
            for op in ("job", "job_cancel")
        },
    }


def _request_model(name: str) -> type[BaseModel] | None:
    """The request model of a tool shared with an HTTP twin, else ``None``."""
    return _request_models().get(name)


@functools.cache
def _arguments_model(handler: Callable[..., Any]) -> type[BaseModel] | None:
    """A model of ``handler``'s keyword arguments, or ``None`` when it validates its own."""
    params = inspect.signature(handler).parameters.values()
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params):
        return None
    models = {model.__name__: model for model in _request_models().values()}
    hints = typing.get_type_hints(handler, localns=models)
    fields: dict[str, Any] = {
        p.name: (hints.get(p.name, Any), ... if p.default is inspect.Parameter.empty else p.default)
        for p in params
    }
    return create_model(
        f"{getattr(handler, '__name__', 'tool')} arguments",
        __config__=ConfigDict(extra="forbid"),
        **fields,
    )


def _validated_arguments(
    name: str, handler: Callable[..., Any], arguments: dict[str, Any]
) -> dict[str, Any]:
    """Check the guest's arguments against ``handler`` before it runs.

    A bad argument is the guest's mistake, reported as ``InvalidToolArgumentsError``; a
    ``TypeError`` or ``ValidationError`` raised later, inside the tool, is a crash.
    """
    request_model = _request_model(name)
    if request_model is not None:
        try:
            return {"req": request_model.model_validate(arguments)}
        except ValidationError as exc:
            raise InvalidToolArgumentsError(_argument_problems(exc)) from exc
    model = _arguments_model(handler)
    if model is None:
        return arguments
    try:
        parsed = model.model_validate(arguments)
    except ValidationError as exc:
        raise InvalidToolArgumentsError(_argument_problems(exc)) from exc
    return {name: getattr(parsed, name) for name in type(parsed).model_fields}


def _call_tool_impl(name: str, arguments: dict[str, Any] | None = None) -> Any:
    handler = TOOL_HANDLERS.get(name)
    if handler is None:
        raise UnknownToolError(f"unknown tool: {name}")
    # Capability gate before checking arguments so a denial is not masked by a missing
    # required argument on a disallowed tool.
    _require_tool(name)
    result = handler(**_validated_arguments(name, handler, arguments or {}))
    if isinstance(result, (dict, list)):
        return result
    return json.loads(json.dumps(result, default=str))


call_tool = install_guest_tool_progress(_call_tool_impl, fail_detail=guest_failure_detail)
