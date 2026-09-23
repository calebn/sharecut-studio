from __future__ import annotations

import webbrowser
from pathlib import Path
from urllib.parse import urlencode

import typer

from podcast_mcp.services.gui_launch import ensure_viewer, packaged_cli_gui_refusal, viewer_url

gui_app = typer.Typer(help="DAW-style episode viewer.")


@gui_app.callback(invoke_without_command=True)
def gui_cmd(
    ctx: typer.Context,
    project: Path | None = typer.Option(
        None,
        "--project",
        help="episode.project.json path (omit on loopback for New/Open home)",
    ),
    port: int = typer.Option(8765, "--port"),
    host: str = typer.Option("127.0.0.1", "--host"),
    no_open: bool = typer.Option(False, "--no-open"),
    background: bool = typer.Option(
        False,
        "--background",
        help="Start in the background (same as MCP open_gui_tool) and exit",
    ),
    dev: bool = typer.Option(
        False,
        "--dev",
        help="API only; run `npm run dev` in gui/web for hot reload on :5173",
    ),
) -> None:
    """Launch the DAW episode viewer."""
    if ctx.invoked_subcommand is not None:
        return

    refusal = packaged_cli_gui_refusal()
    if refusal is not None:
        typer.echo(refusal, err=True)
        raise typer.Exit(2)

    if project is not None and not project.is_file():
        typer.echo(f"Project not found: {project}", err=True)
        raise typer.Exit(1)

    if background:
        if project is None:
            typer.echo("--background requires --project", err=True)
            raise typer.Exit(1)
        result = ensure_viewer(
            project,
            host=host,
            port=port,
            open_browser=not no_open,
        )
        typer.echo(result.to_json())
        raise typer.Exit(0 if result.ok else 1)

    from podcast_mcp.gui.bind import gui_server_deps_available

    if not gui_server_deps_available():
        typer.echo(
            "GUI dependencies missing. Install with: uv sync --extra gui",
            err=True,
        )
        raise typer.Exit(1)

    from podcast_mcp.gui.routes.deps import ensure_non_loopback_session_auth, is_bind_loopback
    from podcast_mcp.gui.server import create_app

    if project is None and not is_bind_loopback(host):
        typer.echo(
            "Omitting --project is only allowed when binding to loopback (127.0.0.1 / localhost).",
            err=True,
        )
        raise typer.Exit(1)

    session_token = ensure_non_loopback_session_auth(host)
    if session_token is not None:
        typer.echo(
            f"Warning: binding to {host} enables PODCAST_SESSION_AUTHZ=strict. "
            "Use the printed URL (includes session_token).",
            err=True,
        )

    served = project.resolve() if project is not None else None
    app = create_app(served_project=served, bind_host=host)
    if project is not None:
        url = viewer_url(host, port, project, session_token=session_token)
    else:
        q = {}
        if session_token:
            q["session_token"] = session_token
        qs = f"?{urlencode(q)}" if q else ""
        url = f"http://{host}:{port}/{qs}"
    if dev:
        typer.echo(
            "Dev mode: API on "
            f"http://{host}:{port} - run `cd gui/web && npm run dev` "
            "and open http://127.0.0.1:5173"
        )
    else:
        typer.echo(f"Viewer: {url}")
        if not no_open:
            webbrowser.open(url)

    from podcast_mcp.gui.bind import run_gui_server

    run_gui_server(app, host=host, port=port, log_level="info")
