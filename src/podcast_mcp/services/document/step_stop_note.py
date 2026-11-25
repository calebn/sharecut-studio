from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer

from podcast_mcp.engines.clips_ops import StepStop


class StepStopNote(BaseModel):
    """Why a trim or roll stopped short: a timing correction sits inside the clip."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    clip_id: str
    edge: Literal["in", "out"]
    step_at_sec: float
    stopped_at_sec: float
    message: str


class StepStopOmitted(BaseModel):
    """Result base that leaves ``step_stop`` off the wire when there is none."""

    @model_serializer(mode="wrap")
    def _drop_unset_step_stop(self, handler: SerializerFunctionWrapHandler) -> Any:
        data: dict[str, Any] = handler(self)
        if data.get("step_stop") is None:
            data.pop("step_stop", None)
        return data


def trim_step_stop_note(stop: StepStop | None) -> StepStopNote | None:
    if stop is None:
        return None
    return StepStopNote(
        clip_id=stop.clip_id,
        edge=stop.edge,
        step_at_sec=stop.step_at_sec,
        stopped_at_sec=stop.stopped_at_sec,
        message=(
            f"This edge stopped at {stop.stopped_at_sec:.2f} s of the recording because a "
            f"timing correction at {stop.step_at_sec:.2f} s sits inside the clip, and an edge "
            "cannot move across a correction."
        ),
    )


def roll_step_stop_note(stop: StepStop | None) -> StepStopNote | None:
    if stop is None:
        return None
    side = "right" if stop.edge == "in" else "left"
    return StepStopNote(
        clip_id=stop.clip_id,
        edge=stop.edge,
        step_at_sec=stop.step_at_sec,
        stopped_at_sec=stop.stopped_at_sec,
        message=(
            f"This join stopped at {stop.stopped_at_sec:.2f} s of the recording because a "
            f"timing correction at {stop.step_at_sec:.2f} s sits inside the {side} clip, and a "
            "join cannot move across a correction."
        ),
    )
