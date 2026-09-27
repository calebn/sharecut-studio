from __future__ import annotations

import uuid
from dataclasses import dataclass
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


@dataclass(frozen=True)
class EffectReplacement:
    """Result of :func:`replace_effect`, reported from the same pass that built the chain.

    ``effects`` is the new chain, ``replaced`` the same-type entry that was overwritten
    (``None`` when ``new`` was appended), and ``dropped`` how many later same-type
    entries were removed.
    """

    effects: list[ProcessingEffect]
    replaced: ProcessingEffect | None
    dropped: int


def replace_effect(effects: list[ProcessingEffect], new: ProcessingEffect) -> EffectReplacement:
    """Collapse ``new.effect`` entries into one: ``new`` in place of the first, later ones dropped.

    Only for single-instance effects a pipeline step owns (e.g. ``compress_tracks``'s
    ``acompressor``): every same-type entry anywhere in the chain collapses into one,
    including user-authored ones. Do not use it for effect types that legitimately repeat
    (several ``equalizer`` bands, an ``agate`` on both sides of another effect); those
    extra instances would be deleted. The replaced entry keeps its position and
    ``bypass``; ``new`` is appended when the chain has none. Pure: neither argument is
    mutated. Returns the new chain plus the overwritten entry and dropped count, so
    callers log and count from this pass instead of re-scanning.
    """
    slot = next((i for i, e in enumerate(effects) if e.effect == new.effect), None)
    if slot is None:
        return EffectReplacement(effects=[*effects, new], replaced=None, dropped=0)
    kept = new.model_copy(update={"bypass": effects[slot].bypass})
    result = [
        kept if i == slot else e
        for i, e in enumerate(effects)
        if i == slot or e.effect != new.effect
    ]
    return EffectReplacement(
        effects=result,
        replaced=effects[slot],
        dropped=len(effects) - len(result),
    )


def artifact(project: EpisodeProject, name: str) -> Path:
    p = project.artifacts_dir() / name
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def new_clip_id() -> str:
    return f"clip_{uuid.uuid4().hex[:8]}"
