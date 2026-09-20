"""podcast tunnel - connect this host to the relay for internet sharing."""

from __future__ import annotations

from pathlib import Path

import typer

from podcast_mcp.runtime_config import RuntimeConfigError
from podcast_mcp.services.tunnel import run_tunnel_sync


def tunnel_cmd(
    project: Path | None = typer.Option(
        None,
        "--project",
        help="episode.project.json to advertise shares from.",
    ),
    relay_url: str | None = typer.Option(
        None,
        "--relay-url",
        help="Relay WebSocket URL (overrides config file).",
    ),
    host_token: str | None = typer.Option(
        None,
        "--host-token",
        help="Host authentication token for the relay.",
    ),
    public_base_url: str | None = typer.Option(
        None,
        "--public-base-url",
        help="Public HTTPS share origin (overrides environment and config file).",
    ),
    local_gui: str | None = typer.Option(
        None,
        "--local-gui",
        help="Local GUI base URL (default: http://127.0.0.1:8765).",
    ),
    config: Path | None = typer.Option(
        None,
        "--config",
        help="Relay config YAML path (default: ~/.config/podcast_mcp/relay.yaml).",
    ),
) -> None:
    """Connect this host to the relay so guests can access your project online."""
    try:
        run_tunnel_sync(
            project_path=project,
            relay_url=relay_url,
            host_token=host_token,
            public_base_url=public_base_url,
            local_gui_url=local_gui,
            config_path=config,
        )
    except RuntimeConfigError as exc:
        typer.echo(f"Invalid relay configuration: {exc}", err=True)
        raise typer.Exit(2) from exc
    except ImportError:
        typer.echo(
            "WebSocket or HTTP dependencies missing. Install with: uv sync --extra gui",
            err=True,
        )
        raise typer.Exit(1) from None
    except KeyboardInterrupt:
        typer.echo("\nTunnel disconnected.")
