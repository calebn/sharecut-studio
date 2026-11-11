from __future__ import annotations

from enum import StrEnum
from typing import Any

from podcast_mcp.models import Clip, ClipOffSpeakerMuteRegion, FadeCurve


class MuteOwnership(StrEnum):
    ORDINARY = "ordinary"
    OFF_SPEAKER = "off_speaker"


def nonempty_off_speaker_regions_payload(clip: Clip) -> dict[str, Any]:
    return (
        {
            "off_speaker_mute_regions": [
                r.model_dump(mode="json") for r in clip.off_speaker_mute_regions
            ]
        }
        if clip.off_speaker_mute_regions
        else {}
    )


def nonzero_gain_payload(clip: Clip) -> dict[str, Any]:
    return {"gain_db": clip.gain_db} if clip.gain_db else {}


def nonlinear_fade_curves_payload(clip: Clip) -> dict[str, Any]:
    return {
        key: curve.value
        for key, curve in (
            ("fade_in_curve", clip.fade_in_curve),
            ("fade_out_curve", clip.fade_out_curve),
        )
        if curve is not FadeCurve.LINEAR
    }


def add_off_speaker_mute(clip: Clip, region: ClipOffSpeakerMuteRegion) -> bool:
    if region in clip.off_speaker_mute_regions:
        return False
    clip.off_speaker_mute_regions = sorted(
        [*clip.off_speaker_mute_regions, region.model_copy(deep=True)],
        key=lambda r: (r.start_s, r.end_s, r.fade_out_ms, r.fade_in_ms),
    )
    return True
