"""Patch a name the play modules import, in every module that holds it.

``PlayService`` is split across ``podcast_mcp.services.document.play_*``; each module binds
its own copy of an imported name, so one patch target no longer reaches all of them.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from typing import Any
from unittest.mock import DEFAULT, MagicMock, patch

PLAY_MODULES = (
    "play",
    "play_boundary",
    "play_cache",
    "play_compose",
    "play_follow",
    "play_headroom",
    "play_pending",
    "play_stems",
    "play_support",
)


@contextmanager
def patch_play(name: str, new: Any = DEFAULT, **kwargs: Any) -> Iterator[Any]:
    """``patch`` of ``name`` in each play module that has it, one mock shared by all."""
    mock = MagicMock(**kwargs) if new is DEFAULT else new
    with ExitStack() as stack:
        patched = 0
        for module in PLAY_MODULES:
            path = f"podcast_mcp.services.document.{module}"
            if hasattr(importlib.import_module(path), name):
                stack.enter_context(patch(f"{path}.{name}", mock))
                patched += 1
        assert patched, f"no play module has {name}"
        yield mock
