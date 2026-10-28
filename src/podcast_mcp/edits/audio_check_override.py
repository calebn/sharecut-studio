"""The owner's explicit override of the automatic audio-quality and cut-position checks.

The checks run on every edit by default and hold a cut whose edges or neighbours they
cannot clear. Any caller allowed to run the edit (the CLI, the host MCP, a share MCP with
the Editor capability) may ask to apply it anyway, as a DAW would for a mid-word cut. The
override changes which checks run for that one call; it does not change who the caller is.
History and every applied edit record who overrode and through which surface.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from podcast_mcp.models import CutIntent

OVERRIDE_PARAM = "audio_check_override"
OVERRIDE_FLAG = "override_audio_checks"
MCP_HOST_ACTOR = "mcp:host"
MCP_HOST_SURFACE = "host_mcp"


@dataclass(frozen=True)
class AudioCheckOverride:
    actor: str
    surface: str

    def record(self) -> dict[str, str]:
        return {"kind": "owner_override", "actor": self.actor, "surface": self.surface}


_ACTIVE: ContextVar[AudioCheckOverride | None] = ContextVar("audio_check_override", default=None)


def active_override() -> AudioCheckOverride | None:
    return _ACTIVE.get()


@contextmanager
def audio_check_override(
    actor: str, surface: str, *, enabled: bool = True
) -> Iterator[AudioCheckOverride | None]:
    """Skip the audio checks for edits run inside this block; a no-op when not ``enabled``."""
    if not enabled:
        yield None
        return
    override = AudioCheckOverride(actor, surface)
    token = _ACTIVE.set(override)
    try:
        yield override
    finally:
        _ACTIVE.reset(token)


def mcp_host_override(*, enabled: bool = True) -> AbstractContextManager[AudioCheckOverride | None]:
    return audio_check_override(MCP_HOST_ACTOR, MCP_HOST_SURFACE, enabled=enabled)


def is_human_intent(intent: CutIntent) -> bool:
    """A person chose these boundaries, or the owner overrode the checks for this call."""
    return intent is CutIntent.HUMAN_BOUNDARIES or _ACTIVE.get() is not None


def stamp_params(params: dict[str, Any] | None) -> dict[str, Any] | None:
    override = _ACTIVE.get()
    if override is None:
        return params
    return {**(params or {}), OVERRIDE_PARAM: override.record()}
