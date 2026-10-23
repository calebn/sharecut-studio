"""Offer to download a missing model when a CLI command needs one (#2197).

Only a person at a terminal is asked. A pipe, a redirected stdin or ``--no-input`` keeps the
refusal as it was: one ``Error: needs ...`` line with the install command, no prompt and no
download. The download is the ``podcast bootstrap`` one, on the same progress reporter.
"""

from __future__ import annotations

import sys
from contextlib import nullcontext

import typer

from podcast_mcp.cli.context import get_progress, no_input
from podcast_mcp.cli.setup_cmd import install_and_report
from podcast_mcp.services.pipeline import model_spec
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.progress import CliProgressReporter


def is_interactive() -> bool:
    return sys.stdin.isatty() and sys.stderr.isatty()


def offer_download(missing: ModelMissing) -> bool:
    """Ask, and on yes install; True means the command can run again."""
    if missing.state != "missing" or no_input() or not is_interactive():
        return False
    reporter = get_progress()
    with reporter.paused() if isinstance(reporter, CliProgressReporter) else nullcontext():
        try:
            agreed = typer.confirm(
                f"Download {missing.label} ({missing.size})?", default=False, err=True
            )
        except typer.Abort:
            return False
    return agreed and install_and_report(model_spec(missing.id), whisper_model=missing.model)
