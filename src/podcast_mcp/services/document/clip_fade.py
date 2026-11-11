"""Set clip fades and fade curves under the project transaction, one history entry per command."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict
from typing import Any

from podcast_mcp.edits.clip_fades import (
    ClipFadeBaseline,
    ClipFadeEdit,
    fade_curve_params,
    require_clip_fade_baseline,
)
from podcast_mcp.edits.timeline_ops import set_clip_fade, set_clips_fade
from podcast_mcp.models import FadeCurve
from podcast_mcp.services.app import ProjectWorkspace

Mutate = Callable[..., Mapping[str, Any]]


def apply_clip_fade(
    ws: ProjectWorkspace,
    mutate: Mutate,
    clip_id: str,
    fade_in_ms: int,
    fade_out_ms: int,
    expected: ClipFadeBaseline | None,
    fade_in_curve: FadeCurve | None,
    fade_out_curve: FadeCurve | None,
) -> Mapping[str, Any]:
    with ws.transaction() as project:
        if expected is not None:
            require_clip_fade_baseline(project, clip_id, expected)
        return mutate(
            "set clip fade",
            lambda p: set_clip_fade(
                p,
                clip_id,
                fade_in_ms,
                fade_out_ms,
                fade_in_curve=fade_in_curve,
                fade_out_curve=fade_out_curve,
            ),
            operation="set_clip_fade",
            params={
                "clip_id": clip_id,
                "fade_in_ms": fade_in_ms,
                "fade_out_ms": fade_out_ms,
                **fade_curve_params(fade_in_curve, fade_out_curve),
                **({"expected": asdict(expected)} if expected is not None else {}),
            },
        )


def apply_clips_fade(
    ws: ProjectWorkspace, mutate: Mutate, fades: list[ClipFadeEdit]
) -> Mapping[str, Any]:
    with ws.transaction() as project:
        for fade in fades:
            require_clip_fade_baseline(project, fade.clip_id, fade.expected)
        return mutate(
            "set clips fade",
            lambda p: set_clips_fade(p, fades),
            operation="set_clips_fade",
            params={
                "fades": [
                    {
                        "clip_id": fade.clip_id,
                        "fade_in_ms": fade.fade_in_ms,
                        "fade_out_ms": fade.fade_out_ms,
                        **fade_curve_params(fade.fade_in_curve, fade.fade_out_curve),
                        "expected": asdict(fade.expected),
                    }
                    for fade in fades
                ]
            },
        )
