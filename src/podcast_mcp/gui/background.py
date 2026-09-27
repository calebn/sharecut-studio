"""Starlette background-task helpers shared by GUI responses."""

from __future__ import annotations

from starlette.background import BackgroundTask


def release_background(background: BackgroundTask | None) -> None:
    """Run a synchronous *background* now, when no response will run it."""
    if background is not None:
        background.func(*background.args, **background.kwargs)
