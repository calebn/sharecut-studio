from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

SESSION_HEAR_PUBLIC_EXCLUDE: dict[str, Any] = {
    "wav": True,
    "player": True,
    "current": {"wav": True},
    "suggested": {"wav": True},
}


class SessionHearCurrentSide(BaseModel):
    """The window of the staged session as it is now."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    wav: str
    start_s: float
    end_s: float


class SessionHearSuggestedSide(BaseModel):
    """The window of the staged session after Accept."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    wav: str
    start_s: float
    end_s: float
    delta_s: float


class SessionHearResult(BaseModel):
    """What a session hear rendered; field order is the wire key order.

    ``speech`` stays a plain mapping: it is the cached JSON dump of the speech report.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    suggestion_id: str
    kind: str
    mode: Literal["current", "suggested", "ab"]
    take_index: int | None
    pad_sec: float
    wav: str
    player: list[str] | None
    current: SessionHearCurrentSide | None
    suggested: SessionHearSuggestedSide | None
    delta_s: float | None
    removed_s: float | None
    span_s: float | None
    speech: dict[str, Any] | None
    speech_message: str | None
