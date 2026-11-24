from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer


class DeleteClipsProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["propose_delete_clips"]
    mode: Literal["gap", "ripple"]
    edits: list[dict[str, Any]]


class DeleteClipsApplied(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["delete_clips", "ripple_delete_clips"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    clip_ids: list[str]
    mode: Literal["gap", "ripple"]
    cut_speech: dict[str, Any] | None = None

    @model_serializer(mode="wrap")
    def _drop_unset_cut_speech(self, handler: SerializerFunctionWrapHandler) -> Any:
        data: dict[str, Any] = handler(self)
        if data.get("cut_speech") is None:
            data.pop("cut_speech", None)
        return data


class DeleteClipsHeld(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["delete_clips", "ripple_delete_clips"]
    unchanged: Literal[True]
    needs_confirmation: dict[str, Any]
    apply_anyway: str
