"""Closed ProjectView projection names — no GUI imports."""

from __future__ import annotations

from enum import StrEnum

__all__ = ["VIEW_PROJECTION_QUERY_DESCRIPTION", "ViewProjection", "parse_view_projection"]


class ViewProjection(StrEnum):
    """Closed ProjectView projections — HTTP ``?phase=`` and WS slices alias these."""

    FULL = "full"
    SHELL = "shell"
    DETAIL = "detail"
    TRACKS = "tracks"
    COMMENTS = "comments"
    CLIPS = "clips"
    FX = "fx"
    ENVELOPES = "envelopes"


VIEW_PROJECTION_QUERY_DESCRIPTION = (
    "View projection: " + ", ".join(p.value for p in ViewProjection) + " (default shell)"
)


def parse_view_projection(
    raw: str | None,
    *,
    default: ViewProjection = ViewProjection.SHELL,
) -> ViewProjection:
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return ViewProjection(str(raw).strip().lower())
    except ValueError as exc:
        raise ValueError(f"unknown project projection: {raw}") from exc
