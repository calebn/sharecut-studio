from dataclasses import dataclass
from typing import Annotated

from pydantic import Field

from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.coded_error import CodedError


@dataclass(frozen=True)
class ClipGainBaseline:
    gain_db: Annotated[float, Field(allow_inf_nan=False)]


class ClipGainChangedError(CodedError, ValueError):
    code = "clip_gain_changed"


def require_clip_gain_baseline(
    project: EpisodeProject, clip_id: str, expected: ClipGainBaseline
) -> None:
    clip = next((item for item in project.clips if item.id == clip_id), None)
    if clip is None or round(clip.gain_db, 2) != round(expected.gain_db, 2):
        raise ClipGainChangedError("This clip changed. Nothing was saved. Adjust the gain again.")
