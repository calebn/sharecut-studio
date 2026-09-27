from __future__ import annotations

import uuid
from pathlib import Path

from podcast_mcp.engines import FFmpegEngine
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    ProcessingChain,
    ProcessingEffect,
    TrackRole,
)


def ffmpeg() -> FFmpegEngine:
    return FFmpegEngine()


def ensure_dialogue_clips(project: EpisodeProject) -> None:
    for track in project.tracks:
        if track.role != TrackRole.DIALOGUE or not track.media:
            continue
        existing = [c for c in project.clips if c.track_id == track.id]
        if existing:
            continue
        dur = track.media.duration_sec or 0.0
        project.clips.append(
            Clip(
                id=f"clip_{track.id}",
                track_id=track.id,
                source_start=0.0,
                source_end=dur,
                timeline_start=0.0,
            )
        )


def set_or_replace_chain(
    project: EpisodeProject,
    track_id: str,
    effects: list[ProcessingEffect],
) -> None:
    project.processing_chains = [c for c in project.processing_chains if c.track_id != track_id]
    project.processing_chains.append(ProcessingChain(track_id=track_id, effects=effects))


def replace_effect(
    effects: list[ProcessingEffect], new: ProcessingEffect
) -> list[ProcessingEffect]:
    """``effects`` with one ``new.effect`` entry: ``new`` in place of the first, later ones dropped.

    The replaced entry keeps its position and ``bypass``. ``new`` is appended when the
    chain has none. A pipeline step that owns an effect updates it on re-run instead of
    stacking another copy.
    """
    slot = next((i for i, e in enumerate(effects) if e.effect == new.effect), None)
    if slot is None:
        return [*effects, new]
    kept = new.model_copy(update={"bypass": effects[slot].bypass})
    return [
        kept if i == slot else e
        for i, e in enumerate(effects)
        if i == slot or e.effect != new.effect
    ]


def artifact(project: EpisodeProject, name: str) -> Path:
    p = project.artifacts_dir() / name
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def new_clip_id() -> str:
    return f"clip_{uuid.uuid4().hex[:8]}"
