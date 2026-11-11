from dataclasses import dataclass
from typing import Annotated

from pydantic import Field

from podcast_mcp.models import EpisodeProject, FadeCurve
from podcast_mcp.util.coded_error import CodedError


@dataclass(frozen=True)
class ClipFadeBaseline:
    fade_in_ms: Annotated[int, Field(ge=0, strict=True)]
    fade_out_ms: Annotated[int, Field(ge=0, strict=True)]
    fade_in_curve: FadeCurve = FadeCurve.LINEAR
    fade_out_curve: FadeCurve = FadeCurve.LINEAR


@dataclass(frozen=True)
class ClipFadeEdit:
    """One clip's wanted fade lengths and its baseline; a curve left ``None`` is kept."""

    clip_id: str
    fade_in_ms: int
    fade_out_ms: int
    expected: ClipFadeBaseline
    fade_in_curve: FadeCurve | None = None
    fade_out_curve: FadeCurve | None = None


class ClipFadeChangedError(CodedError, ValueError):
    code = "clip_fade_changed"


def require_clip_fade_baseline(
    project: EpisodeProject, clip_id: str, expected: ClipFadeBaseline
) -> None:
    clip = next((item for item in project.clips if item.id == clip_id), None)
    if clip is None or (
        clip.fade_in_ms,
        clip.fade_out_ms,
        clip.fade_in_curve,
        clip.fade_out_curve,
    ) != (
        expected.fade_in_ms,
        expected.fade_out_ms,
        expected.fade_in_curve,
        expected.fade_out_curve,
    ):
        raise ClipFadeChangedError("This clip changed. Nothing was saved. Adjust the fade again.")


def fade_curve_params(
    fade_in_curve: FadeCurve | None, fade_out_curve: FadeCurve | None
) -> dict[str, str]:
    """The curves an edit sets, for its history params; a curve left alone is not named."""
    return {
        key: curve.value
        for key, curve in (("fade_in_curve", fade_in_curve), ("fade_out_curve", fade_out_curve))
        if curve is not None
    }
