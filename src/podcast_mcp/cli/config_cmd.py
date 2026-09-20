"""Inspect runtime and build-time configuration without exposing secrets."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import typer

from podcast_mcp.services.config_check import run_config_checks
from podcast_mcp.services.doctor import echo_doctor_report

config_app = typer.Typer(help="Validate local, self-hosted, or distributor configuration.")


@config_app.command("check")
def check_config(
    mode: Literal["local", "self-hosted", "distributor"] = typer.Option(
        "local",
        "--mode",
        help="Configuration contract to validate.",
    ),
    relay_config: Path | None = typer.Option(
        None,
        "--relay-config",
        help="Host relay YAML (default: ~/.config/podcast_mcp/relay.yaml).",
    ),
    distribution_profile: Path | None = typer.Option(
        None,
        "--distribution-profile",
        help="Build-time public distribution profile JSON.",
    ),
) -> None:
    """Report missing requirements without making network requests."""
    result = run_config_checks(
        mode,
        relay_config=relay_config,
        distribution_profile=distribution_profile,
    )
    echo_doctor_report(result, typer.echo, lambda message: typer.echo(message, err=True))
    if not result.passed:
        raise typer.Exit(1)
    typer.echo(f"Configuration is valid for {mode} mode.")
