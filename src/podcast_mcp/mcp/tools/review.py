from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import ReviewService


def publish_review_version_tool(
    project_path: str,
    label: str,
    prefer: str = "premix",
    set_active: bool = True,
) -> str:
    """Freeze the current premix/mastered mix as a review version under artifacts/review/.

    Comments created while a version is active stamp review_version_id.
    prefer: \"premix\" (default) or \"mastered\".
    Refuses a project with no mix yet (code no_mix: Refresh first), a premix
    that's stale vs the project (Refresh first) or a master not mastered from
    the current premix (export first).
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(ReviewService(ws).publish(label=label, prefer=prefer, set_active=set_active))


def list_review_versions_tool(project_path: str) -> str:
    """List frozen review mix versions (includes active flag)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(ReviewService(ws).list_versions())


def list_session_suggestions_tool(project_path: str, status: str = "") -> str:
    """List record sessions staged for an insert or replace target.

    status: pending, skipped or accepted; empty lists all. A staged session has its recordings
    registered as sources but nothing on the timeline until accept_session_suggestion_tool places
    it. Only insert sessions can be accepted so far.
    """
    from podcast_mcp.services.document import SessionSuggestionService

    ws = ProjectWorkspace.open(project_path)
    return to_json(SessionSuggestionService(ws).list(status=status or None))


def skip_session_suggestion_tool(project_path: str, suggestion_id: str) -> str:
    """Skip a pending staged session (one undo step). Refuses one that is not pending."""
    from podcast_mcp.services.document import SessionSuggestionService

    ws = ProjectWorkspace.open(project_path)
    return to_json(SessionSuggestionService(ws).skip(suggestion_id))


def accept_session_suggestion_tool(project_path: str, suggestion_id: str) -> str:
    """Place a pending insert session on the timeline (one undo step, "Added Session N").

    Opens the session's length at its insert point on every dialogue track and places its
    takes, room-tone beds and live comments there. Refuses a session that is not pending, a
    replace session (not available yet) and one whose insert point is gone (stale_anchor).
    The result lists non-dialogue tracks that did not move (unmoved_track_ids).
    """
    from podcast_mcp.services.document import SessionSuggestionService

    ws = ProjectWorkspace.open(project_path)
    return to_json(SessionSuggestionService(ws).accept(suggestion_id))


def set_active_review_version_tool(
    project_path: str,
    version_id: str | None = None,
) -> str:
    """Set or clear review.active_version_id (pass null/omit to clear)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(ReviewService(ws).set_active(version_id))


def create_review_share_tool(
    project_path: str,
    version_id: str = "",
    public_base_url: str = "http://127.0.0.1:8765",
    role: str = "commenter",
    with_mcp: bool = False,
    general_access: str = "link",
    require_sign_in: bool = False,
    invite_emails: str = "",
    pin: bool = False,
) -> str:
    """Create a review share URL (Anyone with the link by default).

    version_id: freeze the link on this review version. Leave empty and the link
    follows the latest published version, so a fix never needs a new URL.
    pin: freeze the link on the active version when no version_id is given.

    role: review-link role, as in Google Docs. viewer views and plays; commenter
    also comments and suggests edits that wait for an editor or the host; editor
    also edits directly and approves or rejects suggestions.
    with_mcp: also mint an MCP URL ({base}/mcp/{token}/mcp) with the role's powers.
    general_access: link (default) or restricted (ACL + sign-in).
    require_sign_in: force login even on link shares.
    invite_emails: comma-separated emails to add to the ACL.
    """
    from podcast_mcp.services.collaboration import ShareService, capabilities_for_role
    from podcast_mcp.services.share_auth import get_identity_store

    caps = capabilities_for_role(role, with_mcp=with_mcp)
    ws = ProjectWorkspace.open(project_path)
    service = ShareService(ws)
    row = service.create(
        review_version_id=service.resolve_start_version(version_id or None),
        public_base_url=public_base_url,
        capabilities=caps,
        general_access=general_access,
        require_sign_in=require_sign_in,
        follow_latest=not (version_id or pin),
    )
    emails = [e.strip() for e in invite_emails.split(",") if e.strip()]
    if emails:
        store = get_identity_store()
        row = {
            **row,
            "invites": [store.invite_to_share(row["token"], email=e, role=role) for e in emails],
        }
    return to_json(row)


def create_record_room_tool(
    project_path: str,
    public_base_url: str = "http://127.0.0.1:8765",
    expires_at: str | None = None,
    target: str | None = None,
) -> str:
    """Mint a recording room: guest + producer /rec/ links; revokes earlier rooms' links (docs/recording-session.md).

    ``target`` is where the session lands: ``end`` (the default), or an ``insert``/``replace`` JSON object
    that stages the session as a suggestion.
    """
    from podcast_mcp.services.collaboration import ShareService

    ws = ProjectWorkspace.open(project_path)
    return to_json(
        ShareService(ws).create_record_room(
            public_base_url=public_base_url,
            expires_at=expires_at,
            target=target,
        )
    )


def revoke_record_room_tool(project_path: str, session_id: str) -> str:
    """End a recording room: revoke guest and producer tokens."""
    from podcast_mcp.services.collaboration import ShareService

    ws = ProjectWorkspace.open(project_path)
    return to_json(ShareService(ws).revoke_room(session_id))


def register_core(mcp: MCPServer) -> None:
    """Local review mix freeze tools (FOSS core - no share minting)."""
    for fn in (
        accept_session_suggestion_tool,
        publish_review_version_tool,
        list_review_versions_tool,
        list_session_suggestions_tool,
        set_active_review_version_tool,
        skip_session_suggestion_tool,
    ):
        mcp.tool()(fn)


def register_share(mcp: MCPServer) -> None:
    """Share minting - registered only when the collaboration extension loads."""
    mcp.tool()(create_review_share_tool)
    mcp.tool()(create_record_room_tool)
    mcp.tool()(revoke_record_room_tool)
