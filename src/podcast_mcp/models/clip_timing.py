"""Per-clip timing map: a piecewise-constant shift over source time (#2857, umbrella #1089).

A step is a discontinuity of the clip's source-to-timeline shift, placed in a quiet span.
``delta_sec > 0`` inserts a hole of that length at ``at``; ``delta_sec < 0`` skips source
``[at, at + |delta_sec|)``. Steps are in SOURCE seconds, so moving a clip never edits them.
Inert until a producer sets ``Clip.timing`` (stages 2-4).
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field, model_validator

MIN_STEP_GAP_SEC = 1e-6

# (source_a, source_b, timeline_a): source [a, b) plays at timeline_a with a constant shift.
VirtualPiece = tuple[float, float, float]


class QuietSpan(BaseModel):
    """``[start_s, end_s)`` in source seconds that the solver certified quiet."""

    start_s: float = Field(allow_inf_nan=False)
    end_s: float = Field(allow_inf_nan=False)


class TimingStep(BaseModel):
    at: float = Field(allow_inf_nan=False)
    delta_sec: float = Field(allow_inf_nan=False)
    quiet: QuietSpan | None = None

    @model_validator(mode="after")
    def _delta_and_quiet(self) -> TimingStep:
        if abs(self.delta_sec) < MIN_STEP_GAP_SEC:
            raise ValueError("delta_sec must be at least 1e-6 s in magnitude")
        if self.delta_sec < 0 and self.quiet is None:
            raise ValueError("a step that skips source needs the quiet span it skips inside")
        if self.quiet is not None:
            skip_end = self.at + max(0.0, -self.delta_sec)
            # `at` is half-open in the quiet span; the skipped span may end exactly at its end.
            if not self.quiet.start_s <= self.at < self.quiet.end_s:
                raise ValueError("a step must start inside its quiet span [start_s, end_s)")
            if skip_end > self.quiet.end_s + MIN_STEP_GAP_SEC:
                raise ValueError("a skipped span must end inside its quiet span")
        return self


class ClipTiming(BaseModel):
    kind: Literal["step"] = "step"
    steps: list[TimingStep] = Field(min_length=1)
    method: str = "bleed_lag"
    evidence: str | None = None

    @model_validator(mode="after")
    def _sorted_and_apart(self) -> ClipTiming:
        for prev, cur in zip(self.steps, self.steps[1:], strict=False):
            if cur.at - prev.at < MIN_STEP_GAP_SEC:
                raise ValueError("steps must be sorted by `at` and more than 1e-6 s apart")
            if prev.at + max(0.0, -prev.delta_sec) > cur.at + MIN_STEP_GAP_SEC:
                raise ValueError("a skipped span must end before the next step")
        return self

    def validate_within(self, source_start: float, source_end: float) -> None:
        """Raise ValueError unless every step (and skipped span) lies strictly inside the clip's source range."""
        for step in self.steps:
            if not source_start < step.at < source_end:
                raise ValueError(f"step at {step.at} is outside ({source_start}, {source_end})")
            if step.at + max(0.0, -step.delta_sec) > source_end + MIN_STEP_GAP_SEC:
                raise ValueError(f"step at {step.at} skips past source_end {source_end}")

    def total_delta(self) -> float:
        return math.fsum(step.delta_sec for step in self.steps)

    def delta_before(self, source_s: float) -> float:
        """``D(s)``: sum of ``delta_sec`` for steps with ``at <= source_s``."""
        return math.fsum(step.delta_sec for step in self.steps if step.at <= source_s)

    def pieces(
        self, source_start: float, source_end: float, timeline_start: float
    ) -> list[VirtualPiece]:
        """Constant-shift pieces the clip plays as, in source order; empty pieces dropped."""
        out: list[VirtualPiece] = []
        cur, tl = source_start, timeline_start
        for step in self.steps:
            piece_end_tl = tl + (step.at - cur)
            if step.at > cur:
                out.append((cur, step.at, tl))
            if step.delta_sec > 0:
                cur, tl = step.at, piece_end_tl + step.delta_sec
            else:
                cur, tl = step.at - step.delta_sec, piece_end_tl
        if source_end > cur:
            out.append((cur, source_end, tl))
        return out
