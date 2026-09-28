from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from podcast_mcp.edits.mute_regions import mute_regions_payload
from podcast_mcp.engines.play_audit import dialogue_render_hashes, envelope_audio_payload
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.tracks import dialogue_track_ids


def audio_state_fingerprint(
    project: EpisodeProject, render_hashes: Mapping[str, str] | None = None
) -> str:
    """Hash of the audio state reconciliation measures: dialogue tracks only.

    ``render_hashes`` is this project's ``dialogue_render_hashes`` when the caller already
    has it; passing it skips hashing every dialogue track a second time. It must be
    computed from this same state: the track set always comes from the project, so a
    map missing a dialogue track raises ``KeyError``, but a stale hash value would go
    unnoticed.
    """
    hashes = dialogue_render_hashes(project) if render_hashes is None else render_hashes
    parts: list[str] = []
    dialogue = sorted(dialogue_track_ids(project))
    for tid in dialogue:
        parts.append(hashes[tid])
        track = project.track_by_id(tid)
        if track:
            for clip in sorted(
                (c for c in project.clips if c.track_id == tid),
                key=lambda c: c.id,
            ):
                parts.append(
                    json.dumps(
                        {
                            "fade_in_ms": clip.fade_in_ms,
                            "fade_out_ms": clip.fade_out_ms,
                            "mute_regions": mute_regions_payload(clip.mute_regions),
                        },
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                )
    dialogue_set = set(dialogue)
    envelopes = (e for e in project.automation_envelopes if e.track_id in dialogue_set)
    for env in sorted(envelopes, key=lambda e: e.track_id):
        parts.append(json.dumps(envelope_audio_payload(env), sort_keys=True, separators=(",", ":")))
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def reconciliation_is_stale(project: EpisodeProject) -> bool:
    if project.reconciliation_stale:
        return True
    fp = audio_state_fingerprint(project)
    stored = project.last_reconciliation_hash
    if stored is None:
        return True
    return fp != stored


def reconciliation_status(project: EpisodeProject) -> dict[str, Any]:
    fp = audio_state_fingerprint(project)
    stale = reconciliation_is_stale(project)
    return {
        "stale": stale,
        "fingerprint": fp,
        "last_reconciliation_hash": project.last_reconciliation_hash,
        "reconciliation_stale_flag": project.reconciliation_stale,
    }


def mark_reconciliation_stale(project: EpisodeProject) -> None:
    project.reconciliation_stale = True


def mark_reconciliation_fresh(project: EpisodeProject) -> None:
    project.last_reconciliation_hash = audio_state_fingerprint(project)
    project.reconciliation_stale = False
