from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.timed import timed_command
from podcast_mcp.edits.share_capabilities import resolve_share_capabilities
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.share import ShareService

review_app = typer.Typer(
    help="Review mix versions and public share links (collaboration extension).",
)


@review_app.command("publish-version")
@timed_command("review publish-version")
def review_publish_version_cmd(
    project: Path = typer.Option(..., "--project"),
    label: str = typer.Option(..., "--label"),
    prefer: str = typer.Option(
        "premix",
        "--prefer",
        help="Source mix: premix or mastered",
    ),
    no_activate: bool = typer.Option(
        False,
        "--no-activate",
        help="Do not set the new version as active",
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        ver = ReviewService(ws).publish(
            label=label,
            prefer=prefer,
            set_active=not no_activate,
        )
    except (ValueError, FileNotFoundError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(ver, indent=2))


@review_app.command("list-versions")
def review_list_versions_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    rows = ReviewService(ws).list_versions()
    typer.echo(json.dumps(rows, indent=2))


@review_app.command("set-active")
def review_set_active_cmd(
    project: Path = typer.Option(..., "--project"),
    version_id: str | None = typer.Option(
        None,
        "--id",
        help="Version id; omit with --clear to unset active",
    ),
    clear: bool = typer.Option(False, "--clear", help="Clear active version"),
) -> None:
    if clear:
        version_id = None
    elif not version_id:
        typer.echo("pass --id or --clear", err=True)
        raise typer.Exit(1)
    ws = ProjectWorkspace.open(project)
    try:
        result = ReviewService(ws).set_active(version_id)
    except KeyError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(result, indent=2))


@timed_command("review share")
def _cli_create_record_share(
    *,
    project: Path,
    base_url: str,
    session_id: str | None,
    expires_at: str | None,
    role: str | None,
    capabilities: str,
    with_mcp: bool,
    general_access: str,
    require_sign_in: bool,
    invite: list[str] | None,
) -> None:
    _DEFAULT_CAPS = "play,comment,reply,action"
    if (
        with_mcp
        or general_access != "link"
        or require_sign_in
        or invite
        or capabilities != _DEFAULT_CAPS
    ):
        typer.echo(
            "record links do not support --capabilities, --with-mcp, "
            "--general-access restricted, --require-sign-in, or --invite",
            err=True,
        )
        raise typer.Exit(2)
    ws = ProjectWorkspace.open(project)
    try:
        if session_id:
            if not role:
                typer.echo(
                    "record re-invite requires --role guest or producer",
                    err=True,
                )
                raise typer.Exit(2)
            row = ShareService(ws).create_record_token(
                role=role,
                session_id=session_id,
                public_base_url=base_url,
                expires_at=expires_at,
            )
            typer.echo(json.dumps(row, indent=2))
            typer.echo(f"\nShare URL: {row['url']}", err=True)
            return
        room = ShareService(ws).create_record_room(
            public_base_url=base_url,
            expires_at=expires_at,
        )
    except (KeyError, ValueError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(room, indent=2))
    guest_url = room["guest"]["url"]
    producer_url = room["producer"]["url"]
    typer.echo(f"\nGuest URL: {guest_url}", err=True)
    typer.echo(
        f"Producer URL: {producer_url} (intended silent monitor; not recorded — keep private)",
        err=True,
    )


def review_share_cmd(
    project: Path = typer.Option(..., "--project"),
    version: str | None = typer.Option(
        None,
        "--version",
        help="Review mix version id (required for --kind review)",
    ),
    base_url: str = typer.Option(
        "http://127.0.0.1:8765",
        "--base-url",
        help="Public origin for the printed share URL",
    ),
    kind: str = typer.Option(
        "review",
        "--kind",
        help="review (listen link) or record (studio room)",
    ),
    session_id: str | None = typer.Option(
        None,
        "--session-id",
        help="Record room id (re-invite an extra guest or producer token)",
    ),
    expires_at: str | None = typer.Option(
        None,
        "--expires-at",
        help="ISO 8601 expiry for the minted token(s)",
    ),
    role: str | None = typer.Option(
        None,
        "--role",
        help=("review: viewer|commenter|editor; record: guest|producer (only with --session-id)"),
    ),
    capabilities: str = typer.Option(
        "play,comment,reply,action",
        "--capabilities",
        help=(
            "Comma-separated: play,view,comment,reply,action,"
            "suggest,edit,mcp. Ignored when --role is set. Grant mcp via "
            "--with-mcp or include mcp in this list."
        ),
    ),
    with_mcp: bool = typer.Option(
        False,
        "--with-mcp/--no-with-mcp",
        help="Also grant capability-scoped remote MCP on this share",
    ),
    general_access: str = typer.Option(
        "link",
        "--general-access",
        help="link (Anyone with the link) or restricted (ACL + sign-in)",
    ),
    require_sign_in: bool = typer.Option(
        False,
        "--require-sign-in/--no-require-sign-in",
        help="Force sign-in even on link shares (high-sensitivity)",
    ),
    invite: list[str] | None = typer.Option(
        None,
        "--invite",
        help="Invite email(s) onto the ACL (useful with --general-access restricted)",
    ),
) -> None:
    """Create a review share link (Anyone with the link; login-free by default)."""
    kind_key = (kind or "review").strip().lower()
    if kind_key == "record":
        _cli_create_record_share(
            project=project,
            base_url=base_url,
            session_id=session_id,
            expires_at=expires_at,
            role=role,
            capabilities=capabilities,
            with_mcp=with_mcp,
            general_access=general_access,
            require_sign_in=require_sign_in,
            invite=invite,
        )
        return
    if kind_key != "review":
        typer.echo(f"unknown share kind {kind!r}", err=True)
        raise typer.Exit(2)
    if not version:
        typer.echo("--version is required for review shares", err=True)
        raise typer.Exit(2)
    try:
        caps = resolve_share_capabilities(
            role=role,
            capabilities=capabilities,
            with_mcp=with_mcp,
        )
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    ws = ProjectWorkspace.open(project)
    try:
        row = ShareService(ws).create(
            review_version_id=version,
            public_base_url=base_url,
            capabilities=caps,
            general_access=general_access,
            require_sign_in=require_sign_in,
            expires_at=expires_at,
        )
    except (KeyError, ValueError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    if invite:
        from podcast_mcp.services.share_auth import get_identity_store

        store = get_identity_store()
        acl_role = role or row.get("docs_role") or "commenter"
        invites = []
        for email in invite:
            invites.append(store.invite_to_share(row["token"], email=email, role=str(acl_role)))
        row = {**row, "invites": invites}
    typer.echo(json.dumps(row, indent=2))
    typer.echo(f"\nShare URL: {row['url']}", err=True)
    if row.get("mcp_url"):
        typer.echo(f"MCP URL: {row['mcp_url']}", err=True)
        if row.get("general_access") == "restricted" or row.get("require_sign_in"):
            typer.echo(
                "Restricted/sign-in share: agents need a user-bound Bearer "
                "(POST /auth/agent-credential after sign-in); coolname alone is not enough.",
                err=True,
            )
        else:
            typer.echo(
                "Cursor remote MCP: set url to the MCP URL above "
                "(host: PODCAST_REMOTE_MCP=1 + podcast tunnel).",
                err=True,
            )
            typer.echo(
                "Claude.ai custom connector: paste the MCP URL "
                "(/mcp/<token>/mcp), leave OAuth Client ID blank (authless). "
                "Do not use the Share URL with /mcp appended - prefer the MCP URL "
                "(/r/<token>/mcp is also accepted as an alias).",
                err=True,
            )


def review_list_shares_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(ShareService(ws).list(), indent=2))


def review_invite_share_cmd(
    token: str = typer.Option(..., "--token"),
    email: str = typer.Option(..., "--email"),
    role: str = typer.Option(
        "commenter",
        "--role",
        help="ACL role label: viewer, commenter, or editor",
    ),
) -> None:
    """Add an email to a Restricted share ACL (does not rotate the coolname)."""
    from podcast_mcp.services.share_auth import get_identity_store

    row = get_identity_store().invite_to_share(token, email=email, role=role)
    typer.echo(json.dumps(row, indent=2))


def review_revoke_invite_cmd(
    token: str = typer.Option(..., "--token"),
    email: str = typer.Option(..., "--email"),
) -> None:
    """Remove a person from a share ACL without rotating the coolname."""
    from podcast_mcp.services.share_auth import get_identity_store

    ok = get_identity_store().revoke_acl(token, email=email)
    if not ok:
        typer.echo("invite not found", err=True)
        raise typer.Exit(1)
    typer.echo(json.dumps({"revoked": True, "token": token, "email": email}, indent=2))


def review_revoke_share_cmd(
    project: Path = typer.Option(..., "--project"),
    token: str | None = typer.Option(None, "--token"),
    session_id: str | None = typer.Option(
        None,
        "--session-id",
        help="Revoke every token in a record room",
    ),
) -> None:
    if bool(token) == bool(session_id):
        typer.echo("provide exactly one of --token or --session-id", err=True)
        raise typer.Exit(2)
    ws = ProjectWorkspace.open(project)
    try:
        if session_id:
            result = ShareService(ws).revoke_room(session_id)
        else:
            result = ShareService(ws).revoke(str(token))
    except KeyError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(result, indent=2))


def review_backup_registry_cmd(
    dest: Path | None = typer.Option(
        None,
        "--dest",
        help="Backup file path (default: sibling timestamped .bak.sqlite)",
    ),
) -> None:
    """Copy the host share registry sqlite DB (WAL-safe online backup)."""
    from podcast_mcp.edits.share_registry import (
        backup_share_registry,
        default_share_registry_db_path,
    )

    src = default_share_registry_db_path()
    try:
        out = backup_share_registry(dest)
    except OSError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(
        json.dumps(
            {"source": str(src), "backup": str(out)},
            indent=2,
        )
    )


def register_share_cli(review_typer: typer.Typer | None = None) -> None:
    """Mount share mint/ACL commands (collaboration / ``share.cli`` only)."""
    app = review_typer if review_typer is not None else review_app
    existing = {command.name for command in app.registered_commands}
    commands = (
        ("share", review_share_cmd),
        ("list-shares", review_list_shares_cmd),
        ("invite-share", review_invite_share_cmd),
        ("revoke-invite", review_revoke_invite_cmd),
        ("revoke-share", review_revoke_share_cmd),
        ("backup-registry", review_backup_registry_cmd),
    )
    for name, callback in commands:
        if name not in existing:
            app.command(name)(callback)


def register_share_cli_on_host(typer_root: object) -> None:
    """Mount share commands on the review group owned by ``typer_root``."""
    for group in getattr(typer_root, "registered_groups", ()):
        if group.name == "review" and group.typer_instance is not None:
            register_share_cli(group.typer_instance)
            return
    raise RuntimeError("host Typer app must register the review command group first")
