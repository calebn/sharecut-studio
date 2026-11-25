from __future__ import annotations

from typing import Literal

from pydantic import ConfigDict

from podcast_mcp.services.document.step_stop_note import StepStopNote, StepStopOmitted


class RollUnchangedResult(StepStopOmitted):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["roll_clip_join"]
    unchanged: Literal[True]
    step_stop: StepStopNote | None = None


class RollAppliedResult(StepStopOmitted):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["roll_clip_join"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    left_clip_id: str
    right_clip_id: str
    delta_sec: float
    left_source_end: float
    right_source_start: float
    step_stop: StepStopNote | None = None
