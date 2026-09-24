"""Map document command types onto closed ProjectView projections."""

from __future__ import annotations

from podcast_mcp.services.document_sync.handlers.comments import HANDLERS as COMMENT_HANDLERS
from podcast_mcp.services.document_sync.handlers.transcript import HANDLERS as TRANSCRIPT_HANDLERS
from podcast_mcp.services.document_sync.projection_types import ViewProjection

COMMENT_COMMANDS: frozenset[str] = frozenset(COMMENT_HANDLERS)

TRACK_SLICE_COMMANDS: frozenset[str] = frozenset(
    {
        "ReorderTrack",
        "SetTrackMeta",
    }
)

TRANSCRIPT_WORD_COMMANDS: frozenset[str] = frozenset(TRANSCRIPT_HANDLERS)

CLIP_SLICE_COMMANDS: frozenset[str] = frozenset(
    {
        "SetClipFade",
        "SetJoinMode",
        "ApplyFadeRecommendations",
    }
)

FX_SLICE_COMMANDS: frozenset[str] = frozenset({"SetEffectBypass"})

ENVELOPE_SLICE_COMMANDS: frozenset[str] = frozenset({"SetEnvelope"})

MIX_SLICE_COMMANDS: frozenset[str] = frozenset({"SetTrackFader", "SetTrackMute"})


def projection_for_command(command_type: str) -> ViewProjection:
    """Return the Applied snapshot projection for a document command type.

    ``FULL`` is reserved for explicit hydrate (``GET ?phase=full``), not Applied.
    """
    if command_type in COMMENT_COMMANDS:
        return ViewProjection.COMMENTS
    if command_type in TRACK_SLICE_COMMANDS:
        return ViewProjection.TRACKS
    if command_type in TRANSCRIPT_WORD_COMMANDS:
        return ViewProjection.DETAIL
    if command_type in CLIP_SLICE_COMMANDS:
        return ViewProjection.CLIPS
    if command_type in FX_SLICE_COMMANDS:
        return ViewProjection.FX
    if command_type in ENVELOPE_SLICE_COMMANDS:
        return ViewProjection.ENVELOPES
    if command_type in MIX_SLICE_COMMANDS:
        return ViewProjection.MIX
    return ViewProjection.SHELL
