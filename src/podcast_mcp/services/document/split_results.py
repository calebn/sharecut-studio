from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer


class SplitClipResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["split_clips_at"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    at_time: float | int
    skipped_track_ids: list[str]
    split_source_by_track: dict[str, float]
    split_pieces: list[dict[str, str]]


class SplitAtTimeResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["split_clips_at"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    at_time: float | int
    skipped_track_ids: list[str]
    split_source_by_track: dict[str, float]
    split_times: list[float] | None = None
    first_right_pieces: list[dict[str, str]]

    @model_serializer(mode="wrap")
    def _drop_unset_split_times(self, handler: SerializerFunctionWrapHandler) -> Any:
        data: dict[str, Any] = handler(self)
        if data.get("split_times") is None:
            data.pop("split_times", None)
        return data


class ProposeSplitResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["propose_split"]
    edit: dict[str, Any]
    edits: list[dict[str, Any]]
