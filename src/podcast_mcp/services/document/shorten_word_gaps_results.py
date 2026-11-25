from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer


class ShortenWordGapsApplied(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["shorten_word_gaps"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    max_gap_sec: float | int
    use_inaudible_opt: bool | None
    timeline_start: float | int
    timeline_end: float | int
    span_count: int
    per_track_source: dict[str, list[float]]
    cut_speech: dict[str, Any] | None = None

    @model_serializer(mode="wrap")
    def _drop_unset_cut_speech(self, handler: SerializerFunctionWrapHandler) -> Any:
        data: dict[str, Any] = handler(self)
        if data.get("cut_speech") is None:
            data.pop("cut_speech", None)
        return data


class ShortenWordGapsUnchanged(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["shorten_word_gaps"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    unchanged: Literal[True]


class ShortenWordGapsHeld(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["shorten_word_gaps"]
    unchanged: Literal[True]
    needs_confirmation: dict[str, Any]
    apply_anyway: str
