from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.cut_speech import (
    cli_override,
    override_audio_checks_option,
    require_cut_applied,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import (
    RecordStaleLinksError,
    ReviewService,
    ShareService,
    capabilities_for_role,
)
from podcast_mcp.util.coded_error import CodedError, describe_error

review_app = typer.Typer(
    help="Review mix versions and public review links (collaboration extension).",
)


@review_app.command("publish-version")
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
        typer.echo(describe_error(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(ver, indent=2))


@review_app.command("list-versions")
def review_list_versions_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    rows = ReviewService(ws).list_versions()
    typer.echo(json.dumps(rows, indent=2))


@review_app.command("session-suggestions")
def review_session_suggestions_cmd(
    project: Path = typer.Option(..., "--project"),
    status: str | None = typer.Option(
        None, "--status", help="Only suggestions that are pending, skipped or accepted"
    ),
) -> None:
    """List record sessions staged for an insert or replace target.

    Accept a session with accept-session-suggestion.
    """
    from podcast_mcp.services.document import SessionSuggestionService

    ws = ProjectWorkspace.open(project)
    try:
        rows = SessionSuggestionService(ws).list(status=status)
    except CodedError as exc:
        typer.echo(describe_error(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(rows, indent=2))


@review_app.command("skip-session-suggestion")
def review_skip_session_suggestion_cmd(
    project: Path = typer.Option(..., "--project"),
    suggestion_id: str = typer.Option(..., "--id", help="Suggestion id from session-suggestions"),
) -> None:
    """Skip a pending staged session. Its recordings stay in the project."""
    from podcast_mcp.services.document import SessionSuggestionService

    ws = ProjectWorkspace.open(project)
    try:
        row = SessionSuggestionService(ws).skip(suggestion_id)
    except CodedError as exc:
        typer.echo(describe_error(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(row, indent=2))


@review_app.command("session-takes")
def review_session_takes_cmd(
    project: Path = typer.Option(..., "--project"),
    suggestion_id: str = typer.Option(..., "--id", help="Suggestion id from session-suggestions"),
) -> None:
    """List the takes of a staged session: length, words, which is picked and which is default.

    The default is the take accept-session-suggestion places when --take is not given. A take
    accept would refuse shows the reason. Change the pick with select-session-take.
    """
    from podcast_mcp.services.document import SessionSuggestionService

    ws = ProjectWorkspace.open(project)
    try:
        result = SessionSuggestionService(ws).takes(suggestion_id)
    except CodedError as exc:
        typer.echo(describe_error(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(result, indent=2))


@review_app.command("select-session-take")
def review_select_session_take_cmd(
    project: Path = typer.Option(..., "--project"),
    suggestion_id: str = typer.Option(..., "--id", help="Suggestion id from session-suggestions"),
    take: int = typer.Option(..., "--take", help="Take index from session-takes"),
) -> None:
    """Pick the take a pending replace session will place (one undo step).

    Accept and the preview then use it unless they are given another --take. Refuses a session
    that is not pending, an insert, an unknown take, a take that did not record every track and
    a range that has changed.
    """
    from podcast_mcp.services.document import SessionSuggestionService

    ws = ProjectWorkspace.open(project)
    try:
        result = SessionSuggestionService(ws).select_take(suggestion_id, take)
    except CodedError as exc:
        typer.echo(describe_error(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(result, indent=2))


@review_app.command("accept-session-suggestion")
def review_accept_session_suggestion_cmd(
    project: Path = typer.Option(..., "--project"),
    suggestion_id: str = typer.Option(..., "--id", help="Suggestion id from session-suggestions"),
    take: int | None = typer.Option(
        None,
        "--take",
        help="Take index to place for a replace session (default: the selected or last take)",
    ),
    override_checks: bool = override_audio_checks_option(),
) -> None:
    """Place a pending session on the timeline in one undo step.

    An insert opens the session's length at its insert point on every dialogue track. A replace
    removes its range on every dialogue track, puts one take in its place and discards the
    other takes and the comments held on them (the result counts them; undo brings them back).
    If that also removes speech of a track the take did not record, nothing changes until you
    repeat with --override-audio-checks.
    """
    from podcast_mcp.services.document import SessionSuggestionService

    ws = ProjectWorkspace.open(project)
    try:
        with cli_override(override_checks):
            result = require_cut_applied(
                lambda: SessionSuggestionService(ws).accept(
                    suggestion_id, take_index=take, override_audio_checks=override_checks
                ),
                what="this replace",
            )
    except CodedError as exc:
        typer.echo(describe_error(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(result, indent=2))


@review_app.command("preview-session-suggestion")
def review_preview_session_suggestion_cmd(
    project: Path = typer.Option(..., "--project"),
    suggestion_id: str = typer.Option(..., "--id", help="Suggestion id from session-suggestions"),
    take: int | None = typer.Option(
        None,
        "--take",
        help="Take index to hear for a replace session (default: the selected or last take)",
    ),
    mode: str = typer.Option("ab", "--mode", help="current | suggested | ab"),
    pad: float = typer.Option(
        1.5, "--pad", help="Seconds of audio around the change, 0 to 10 (pad_sec_invalid outside)"
    ),
    gap: float = typer.Option(
        0.4, "--gap", help="Silence between A and B, 0 to 5 (gap_sec_invalid outside)"
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Render the WAVs; do not play"),
    player: str | None = typer.Option(None, "--player", help="Override player binary"),
    rerender: bool = typer.Option(False, "--rerender", help="Render the windows again"),
) -> None:
    """Hear a pending session before accepting it: now (A), after accepting (B), or A then B.

    B is what accept-session-suggestion would give, for the same --take. Nothing in the project
    changes, and a replace that would remove another track's speech still plays.
    """
    from podcast_mcp.services.document import SessionSuggestionService

    ws = ProjectWorkspace.open(project)
    try:
        result = SessionSuggestionService(ws).preview(
            suggestion_id,
            mode=mode,
            take_index=take,
            pad_sec=pad,
            gap_sec=gap,
            rerender=rerender,
            dry_run=dry_run,
            player=player,
        )
    except CodedError as exc:
        typer.echo(describe_error(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(result, indent=2))


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


def _cli_create_record_share(
    *,
    project: Path,
    base_url: str,
    session_id: str | None,
    expires_at: str | None,
    role: str | None,
    with_mcp: bool,
    general_access: str,
    require_sign_in: bool,
    invite: list[str] | None,
    target: str | None,
    land_first: bool,
) -> None:
    if land_first and session_id:
        typer.echo("--land-first only applies when minting a new room", err=True)
        raise typer.Exit(2)
    if with_mcp or general_access != "link" or require_sign_in or invite:
        typer.echo(
            "record links do not support --with-mcp, "
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
            target=target,
            land_first=land_first,
        )
    except RecordStaleLinksError as exc:
        typer.echo(json.dumps(exc.room, indent=2))
        raise
    except (KeyError, ValueError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(room, indent=2))
    if room.get("warning"):
        hint = " Add --land-first to save first." if room.get("land_first_possible") else ""
        typer.echo(f"\nWarning: {room['warning']}{hint}", err=True)
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
        help=(
            "Review mix version id to freeze the link on. Without it a review link "
            "follows the latest published version"
        ),
    ),
    pin: bool = typer.Option(
        False,
        "--pin",
        help="Freeze the link on the active version (or --version) instead of following the latest",
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
        help="ISO 8601 date the minted link(s) stop working; without it they never expire",
    ),
    role: str | None = typer.Option(
        None,
        "--role",
        help=(
            "review: viewer (view, play), commenter (default; also comment and "
            "suggest edits), or editor (also edit and approve suggestions); "
            "record: guest|producer (only with --session-id)"
        ),
    ),
    with_mcp: bool = typer.Option(
        False,
        "--with-mcp/--no-with-mcp",
        help="Also mint an MCP URL with this link's permissions",
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
    target: str | None = typer.Option(
        None,
        "--target",
        help=(
            "record: where the session lands: end (default), start, or a JSON object for "
            'insert {"kind":"insert","at_sec":12.5} or replace '
            '{"kind":"replace","from_sec":12.5,"to_sec":20,"track_ids":["p_host"]}'
        ),
    ),
    land_first: bool = typer.Option(
        False,
        "--land-first",
        help=(
            "record: save the current room's stopped take to the episode, then mint the new "
            "room. Without it a new room still starts, and says what it left behind"
        ),
    ),
) -> None:
    """Create a review link (Anyone with the link; login-free by default)."""
    kind_key = (kind or "review").strip().lower()
    if kind_key == "record":
        _cli_create_record_share(
            project=project,
            base_url=base_url,
            session_id=session_id,
            expires_at=expires_at,
            role=role,
            with_mcp=with_mcp,
            general_access=general_access,
            require_sign_in=require_sign_in,
            invite=invite,
            target=target,
            land_first=land_first,
        )
        return
    if land_first:
        typer.echo("--land-first only applies with --kind record", err=True)
        raise typer.Exit(2)
    if kind_key != "review":
        typer.echo(f"unknown share kind {kind!r}", err=True)
        raise typer.Exit(2)
    review_role = "commenter" if role is None else role
    try:
        caps = capabilities_for_role(review_role, with_mcp=with_mcp)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    ws = ProjectWorkspace.open(project)
    try:
        service = ShareService(ws)
        row = service.create(
            review_version_id=service.resolve_start_version(version),
            public_base_url=base_url,
            capabilities=caps,
            general_access=general_access,
            require_sign_in=require_sign_in,
            expires_at=expires_at,
            follow_latest=not (version or pin),
        )
    except (KeyError, ValueError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    if invite:
        from podcast_mcp.services.share_auth import get_identity_store

        store = get_identity_store()
        invites = []
        for email in invite:
            invites.append(store.invite_to_share(row["token"], email=email, role=review_role))
        row = {**row, "invites": invites}
    typer.echo(json.dumps(row, indent=2))
    for warning in row.get("warnings") or []:
        typer.echo(f"\nWarning: {warning['message']}", err=True)
    typer.echo(f"\nShare URL: {row['url']}", err=True)
    if row.get("follow_latest"):
        typer.echo(
            "Follows the latest published version (--pin or --version freezes a link).",
            err=True,
        )
    else:
        typer.echo(
            f"Frozen on {row.get('review_version_label') or row['review_version_id']}.", err=True
        )
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
                "Cursor remote MCP: set url to the MCP URL above (host: podcast tunnel).",
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
        help="New backup file in an existing trusted private directory (default: timestamp + random suffix)",
    ),
) -> None:
    """Create a new private standalone registry backup; existing destinations are refused."""
    from podcast_mcp.services.collaboration import (
        backup_share_registry,
        default_share_registry_db_path,
    )

    src = default_share_registry_db_path()
    try:
        out = backup_share_registry(dest)
    except CodedError:
        raise
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
