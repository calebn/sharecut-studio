from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer


class SetJoinModeResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["set_clip_join_mode"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    join_left_clip_id: str | None
    join_render_mode: str | None
    join_crossfade_ms: int
    join_crossfade_blocked: str | None
    join_borrow_sec: float | None = None

    @model_serializer(mode="wrap")
    def _drop_unset_borrow(self, handler: SerializerFunctionWrapHandler) -> Any:
        data: dict[str, Any] = handler(self)
        if data.get("join_borrow_sec") is None:
            data.pop("join_borrow_sec", None)
        return data


class SetClipJoinResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["set_clip_join"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    left_clip_id: str
    right_clip_id: str
    join_in_mode: Literal["fade", "crossfade", "cut"]
    left_fade_out_ms: int
    right_fade_in_ms: int
    crossfade_ms: int
    crossfade_blocked: str | None
