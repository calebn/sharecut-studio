from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer


def _drop_none(data: dict[str, Any], *keys: str) -> None:
    for key in keys:
        if data.get(key) is None:
            data.pop(key, None)


class CutRangeRippleApplied(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["ripple_delete"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    timeline_start: float | int
    timeline_end: float | int
    track_ids: list[str]
    use_inaudible_opt: bool | None
    span_count: int
    per_track_source: dict[str, list[float]]
    cut_speech: dict[str, Any] | None = None
    join_quality: dict[str, Any] | None = None

    @model_serializer(mode="wrap")
    def _drop_unset_optionals(self, handler: SerializerFunctionWrapHandler) -> Any:
        data: dict[str, Any] = handler(self)
        _drop_none(data, "cut_speech", "join_quality")
        return data


class CutRangeGapApplied(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["punch_delete"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    timeline_start: float | int
    timeline_end: float | int
    mode: Literal["gap"]


class CutRangeHeld(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["ripple_delete", "ripple_delete_text"]
    unchanged: Literal[True]
    needs_confirmation: dict[str, Any]
    apply_anyway: str


class RippleDeleteTextApplied(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["ripple_delete_text"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    query: str
    use_inaudible_opt: bool | None
    timeline_start: float | int
    timeline_end: float | int
    span_count: int
    per_track_source: dict[str, list[float]]
    cut_speech: dict[str, Any] | None = None

    @model_serializer(mode="wrap")
    def _drop_unset_cut_speech(self, handler: SerializerFunctionWrapHandler) -> Any:
        data: dict[str, Any] = handler(self)
        _drop_none(data, "cut_speech")
        return data


class RippleDeleteTextHeld(CutRangeHeld):
    query: str


CutRangeResult = CutRangeRippleApplied | CutRangeGapApplied | CutRangeHeld
RippleDeleteTextResult = RippleDeleteTextApplied | RippleDeleteTextHeld


def cut_range_result(out: Any) -> CutRangeResult:
    if out.get("needs_confirmation") is not None:
        return CutRangeHeld.model_validate(out)
    if "mode" in out:
        return CutRangeGapApplied.model_validate(out)
    return CutRangeRippleApplied.model_validate(out)


def ripple_delete_text_result(out: Any) -> RippleDeleteTextResult:
    if out.get("needs_confirmation") is not None:
        return RippleDeleteTextHeld.model_validate(out)
    return RippleDeleteTextApplied.model_validate(out)
