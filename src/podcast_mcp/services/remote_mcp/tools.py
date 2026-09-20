"""Guest MCP tool implementations - wrap ShareService / document commands."""

from __future__ import annotations

import json
from typing import Any

from podcast_mcp.edits.share_capabilities import CAP_PLAY, CAP_VIEW, has_capability
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.payloads import (
    COMMENT_BODY_MAX,
    document_command_json_schema,
    parse_document_command,
)
from podcast_mcp.services.remote_mcp.allowlist import tool_allowed
from podcast_mcp.services.remote_mcp.context import get_remote_mcp_context
from podcast_mcp.services.share import (
    share_add_comment,
    share_add_reply,
    share_audition_context_info,
    share_daw_project_view,
    share_pending_preview_info,
    share_project_view,
    share_set_action_done,
    share_upload_media,
)
from podcast_mcp.util.progress import install_guest_tool_progress


def _require_tool(name: str) -> None:
    ctx = get_remote_mcp_context()
    if not tool_allowed(ctx.capabilities, name):
        raise PermissionError(f"share capabilities do not allow tool: {name}")


def guest_get_review_summary() -> dict[str, Any]:
    """ReviewApp-level project summary (no host paths)."""
    _require_tool("guest_get_review_summary")
    ctx = get_remote_mcp_context()
    return share_project_view(ctx.token)


def guest_get_project() -> dict[str, Any]:
    """Sanitized Sharecut Studio project view (requires ``view``)."""
    _require_tool("guest_get_project")
    ctx = get_remote_mcp_context()
    return share_daw_project_view(ctx.token)


def guest_get_session_presence() -> dict[str, Any]:
    """Live roster for this share (requires ``view``). Paths stripped."""
    _require_tool("guest_get_session_presence")
    ctx = get_remote_mcp_context()
    if not has_capability(ctx.capabilities, CAP_VIEW):
        raise PermissionError("share does not allow view")
    from podcast_mcp.services.session_control import SessionControlService
    from podcast_mcp.services.share import sanitize_guest_session_event

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
        raise PermissionError("share does not allow view")
    from podcast_mcp.edits.transcript_cuts import search_transcript

    hits = search_transcript(ctx.workspace.project, query=query)
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
) -> dict[str, Any]:
    """Listen-first Current / Suggested / A/B URLs (requires ``play`` + ``view``)."""
    _require_tool("guest_pending_preview")
    ctx = get_remote_mcp_context()
    if not has_capability(ctx.capabilities, CAP_PLAY) or not has_capability(
        ctx.capabilities, CAP_VIEW
    ):
        raise PermissionError("share does not allow play and view")
    return share_pending_preview_info(
        ctx.token,
        edit_id=edit_id,
        mode=mode,
        visual=visual,
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
        raise PermissionError("share does not allow play and view")
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
        raise ValueError("data_base64 must be valid base64") from exc
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
    """Submit a document command allowed by suggest/edit caps.

    Arguments match ``DocumentCommandBody`` (type + payload + client envelope).
    """
    _require_tool("guest_submit_document_command")
    ctx = get_remote_mcp_context()
    from podcast_mcp.services.share import sanitize_guest_document_event

    data = dict(kwargs)
    data.setdefault("client_id", "remote-mcp")
    data.setdefault("client_seq", 1)
    data.setdefault("role", "guest")
    if "payload" not in data:
        data["payload"] = {}
    cmd = parse_document_command(data)
    cmd.role = "guest"
    svc = DocumentSyncService(ctx.workspace)
    result = svc.submit(
        cmd,
        capabilities=list(ctx.capabilities),
        structural_mode=data.get("structural_mode"),
    )
    if isinstance(result, dict):
        return sanitize_guest_document_event(result)
    return result


def guest_render_preview(rerender: bool = True) -> dict[str, Any]:
    """Rebuild stems/premix (requires ``edit`` + ``PODCAST_GUEST_RENDER=1``)."""
    del rerender  # job manager always rebuilds; kept for API compatibility
    _require_tool("guest_render_preview")
    from podcast_mcp.gui.jobs import shared_job_manager
    from podcast_mcp.services.share import sanitize_guest_render_preview
    from podcast_mcp.util.guest_render import require_guest_render

    require_guest_render()
    ctx = get_remote_mcp_context()
    jobs = shared_job_manager()
    # RuntimeError (busy lock) propagates as MCP -32000, not caps deny (-32003).
    job = jobs.start_render_preview(ctx.workspace.path)
    import time

    from podcast_mcp.util.progress import current_progress

    deadline = time.monotonic() + 600.0
    progress = current_progress()
    last_snap: tuple[Any, ...] | None = None
    while job.status in ("queued", "running"):
        if time.monotonic() > deadline:
            raise TimeoutError("Timed out waiting for render preview")
        snap = (job.status, job.message, job.current, job.total)
        if snap != last_snap:
            last_snap = snap
            progress.update(
                "guest_render_preview",
                int(job.current or 0),
                total=job.total,
                message=job.message or "Rendering preview",
            )
        time.sleep(0.05)
    if job.status != "ok":
        raise RuntimeError(job.error or "Render preview failed")
    return sanitize_guest_render_preview({"ok": True})


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
    "guest_upload_media": guest_upload_media,
}


TOOL_DESCRIPTIONS: dict[str, str] = {
    "guest_get_review_summary": "Review-mode project summary for this share (no host paths).",
    "guest_get_project": "Sanitized Sharecut Studio project view (requires view capability).",
    "guest_get_session_presence": (
        "Who is in the Sharecut Studio session: display names, cursor, selection, "
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
    "guest_render_preview": (
        "Rebuild stems and mix preview (requires edit). Host CPU; same as render_preview."
    ),
    "guest_upload_media": (
        "Chunked audio upload into host raw/ (requires edit). Same as POST …/daw/media/upload."
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
        "guest_render_preview": {
            "type": "object",
            "properties": {
                "rerender": {"type": "boolean", "default": True},
            },
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


def _call_tool_impl(name: str, arguments: dict[str, Any] | None = None) -> Any:
    handler = TOOL_HANDLERS.get(name)
    if handler is None:
        raise KeyError(f"unknown tool: {name}")
    # Capability gate before binding kwargs so denials are not masked by TypeError
    # from missing required arguments on disallowed tools.
    _require_tool(name)
    args = arguments or {}
    result = handler(**args)
    if isinstance(result, (dict, list)):
        return result
    return json.loads(json.dumps(result, default=str))


call_tool = install_guest_tool_progress(_call_tool_impl)
