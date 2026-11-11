"""Set clip gain under the project transaction, one history entry per command."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict
from typing import Any

from podcast_mcp.edits.clip_gain import ClipGainBaseline, require_clip_gain_baseline
from podcast_mcp.edits.timeline_ops import set_clip_gain, set_clips_gain
from podcast_mcp.services.app import ProjectWorkspace

Mutate = Callable[..., Mapping[str, Any]]


def apply_clip_gain(
    ws: ProjectWorkspace,
    mutate: Mutate,
    clip_id: str,
    gain_db: float,
    expected: ClipGainBaseline | None,
) -> Mapping[str, Any]:
    with ws.transaction() as project:
        if expected is not None:
            require_clip_gain_baseline(project, clip_id, expected)
        return mutate(
            "set clip gain",
            lambda p: set_clip_gain(p, clip_id, gain_db),
            operation="set_clip_gain",
            params={
                "clip_id": clip_id,
                "gain_db": gain_db,
                **({"expected": asdict(expected)} if expected is not None else {}),
            },
        )


def apply_clips_gain(
    ws: ProjectWorkspace, mutate: Mutate, gains: list[tuple[str, float, ClipGainBaseline]]
) -> Mapping[str, Any]:
    with ws.transaction() as project:
        for clip_id, _, expected in gains:
            require_clip_gain_baseline(project, clip_id, expected)
        return mutate(
            "set clips gain",
            lambda p: set_clips_gain(p, [(clip_id, gain_db) for clip_id, gain_db, _ in gains]),
            operation="set_clips_gain",
            params={
                "gains": [
                    {"clip_id": clip_id, "gain_db": gain_db, "expected": asdict(expected)}
                    for clip_id, gain_db, expected in gains
                ]
            },
        )
