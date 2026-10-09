from dataclasses import dataclass
from typing import Annotated

from pydantic import Field

from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.coded_error import CodedError


@dataclass(frozen=True)
class ClipFadeBaseline:
    fade_in_ms: Annotated[int, Field(ge=0, strict=True)]
    fade_out_ms: Annotated[int, Field(ge=0, strict=True)]


class ClipFadeChangedError(CodedError, ValueError):
    code = "clip_fade_changed"


def require_clip_fade_baseline(
    project: EpisodeProject, clip_id: str, expected: ClipFadeBaseline
) -> None:
    clip = next((item for item in project.clips if item.id == clip_id), None)
    if clip is None or (clip.fade_in_ms, clip.fade_out_ms) != (
        expected.fade_in_ms,
        expected.fade_out_ms,
    ):
        raise ClipFadeChangedError("This clip changed. Nothing was saved. Adjust the fade again.")
