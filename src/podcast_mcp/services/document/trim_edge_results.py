from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer

from podcast_mcp.services.document.step_stop_note import StepStopNote, StepStopOmitted


class TrimUnchangedResult(StepStopOmitted):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["trim_clip_edge"]
    unchanged: Literal[True]
    step_stop: StepStopNote | None = None


class TrimAppliedResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["trim_clip_edge"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    clip_id: str
    edge: Literal["in", "out"]
    source_sec: float
    mode: Literal["ripple", "gap"]
    clip_ids: list[str]
    cut_speech: dict[str, Any] | None = None
    step_stop: StepStopNote | None = None

    @model_serializer(mode="wrap")
    def _drop_unset_cut_speech(self, handler: SerializerFunctionWrapHandler) -> Any:
        data: dict[str, Any] = handler(self)
        if data.get("cut_speech") is None:
            data.pop("cut_speech", None)
        if data.get("step_stop") is None:
            data.pop("step_stop", None)
        return data


class TrimHeldResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["trim_clip_edge"]
    unchanged: Literal[True]
    needs_confirmation: dict[str, Any]
    apply_anyway: str
