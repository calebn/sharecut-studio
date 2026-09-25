from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services import ProjectWorkspace, ReviewService


def publish_review_version_tool(
    project_path: str,
    label: str,
    prefer: str = "premix",
    set_active: bool = True,
) -> str:
    """Freeze the current premix/mastered mix as a review version under artifacts/review/.

    Comments created while a version is active stamp review_version_id.
    prefer: \"premix\" (default) or \"mastered\".
    Refuses a premix that's stale vs the project (Refresh first) or a master not mastered from the current premix (export first).
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(ReviewService(ws).publish(label=label, prefer=prefer, set_active=set_active))


def list_review_versions_tool(project_path: str) -> str:
    """List frozen review mix versions (includes active flag)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(ReviewService(ws).list_versions())


def set_active_review_version_tool(
    project_path: str,
    version_id: str | None = None,
) -> str:
    """Set or clear review.active_version_id (pass null/omit to clear)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(ReviewService(ws).set_active(version_id))


def create_review_share_tool(
    project_path: str,
    version_id: str,
    public_base_url: str = "http://127.0.0.1:8765",
    capabilities: str = "play,comment,reply,action",
    role: str | None = None,
    with_mcp: bool = False,
    general_access: str = "link",
    require_sign_in: bool = False,
    invite_emails: str = "",
) -> str:
    """Create a review share URL (Anyone with the link by default).

    role: optional Docs-like preset viewer|commenter|editor (overrides capabilities).
    capabilities: comma-separated play,view,comment,reply,action,suggest,edit,mcp.
    with_mcp: also grant capability-scoped remote MCP ({base}/mcp/{token}/mcp).
    general_access: link (default) or restricted (ACL + sign-in).
    require_sign_in: force login even on link shares.
    invite_emails: comma-separated emails to add to the ACL.
    """
    from podcast_mcp.edits.share_capabilities import resolve_share_capabilities
    from podcast_mcp.services.share import ShareService
    from podcast_mcp.services.share_auth import get_identity_store

    caps = resolve_share_capabilities(
        role=role,
        capabilities=capabilities,
        with_mcp=with_mcp,
    )
    ws = ProjectWorkspace.open(project_path)
    row = ShareService(ws).create(
        review_version_id=version_id,
        public_base_url=public_base_url,
        capabilities=caps,
        general_access=general_access,
        require_sign_in=require_sign_in,
    )
    emails = [e.strip() for e in invite_emails.split(",") if e.strip()]
    if emails:
        store = get_identity_store()
        acl_role = role or row.get("docs_role") or "commenter"
        row = {
            **row,
            "invites": [
                store.invite_to_share(row["token"], email=e, role=str(acl_role)) for e in emails
            ],
        }
    return to_json(row)


def create_record_room_tool(
    project_path: str,
    public_base_url: str = "http://127.0.0.1:8765",
    expires_at: str | None = None,
) -> str:
    """Mint a recording room: guest + producer /rec/ links (design: docs/recording-session.md)."""
    from podcast_mcp.services.share import ShareService

    ws = ProjectWorkspace.open(project_path)
    return to_json(
        ShareService(ws).create_record_room(
            public_base_url=public_base_url,
            expires_at=expires_at,
        )
    )


def revoke_record_room_tool(project_path: str, session_id: str) -> str:
    """End a recording room: revoke guest and producer tokens."""
    from podcast_mcp.services.share import ShareService

    ws = ProjectWorkspace.open(project_path)
    return to_json(ShareService(ws).revoke_room(session_id))


def register_core(mcp: MCPServer) -> None:
    """Local review mix freeze tools (FOSS core - no share minting)."""
    for fn in (
        publish_review_version_tool,
        list_review_versions_tool,
        set_active_review_version_tool,
    ):
        mcp.tool()(fn)


def register_share(mcp: MCPServer) -> None:
    """Share minting - registered only when the collaboration extension loads."""
    mcp.tool()(create_review_share_tool)
    mcp.tool()(create_record_room_tool)
    mcp.tool()(revoke_record_room_tool)
